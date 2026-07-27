/**
 * buildEffectiveSensorMap — pure merge of built-in defaults, user
 * overrides, and observational data into per-(station, dataPoint)
 * effective rows.
 *
 * See docs/future/sensor-map.md §7 for the design contract and §3.4
 * for the discriminated-union output shape.
 *
 * Precedence (later wins):
 *   1. Built-in defaults (global template, keyed by dataPoint)
 *   2. Global user overrides (stationMac absent)
 *   3. Station-specific user overrides (stationMac matches)
 *   4. Observational metadata (firstSeen, lastSeen from discovery)
 *
 * The compat-layer transformation (legacy config → synthetic overrides)
 * belongs to Stage 3; this function takes already-normalized overrides.
 *
 * Safe mode: returns { rows: [], errors: [] }. Existing cached
 * accessories continue via configureAccessory() restore; no new
 * add/remove decisions happen.
 */
import { DEFAULT_SENSOR_MAP, defaultRowFor } from './defaultMap.js';
import { computeStructuralSignature } from './structuralSignature.js';
import { validateOverrideBody, validateOverrideIdentity, } from './validation.js';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from './wrappers.js';
export function buildEffectiveSensorMap(input) {
    if (input.configMode === 'safe-mode') {
        return { rows: [], errors: [], warnings: [] };
    }
    const errors = [];
    const warnings = [];
    const pendingMerges = new Map();
    input.userOverrides.forEach((raw, i) => {
        const idResult = validateOverrideIdentity(raw);
        if (idResult.status === 'error') {
            errors.push({
                overrideIndex: i,
                code: 'invalid-identity',
                dataPoint: extractDataPointForError(raw),
                stationMac: extractStationMacForError(raw),
                message: idResult.message,
            });
            return;
        }
        const { dataPoint, stationMac } = idResult.identity;
        const key = `${stationMac ?? '*'}|${dataPoint}`;
        let bucket = pendingMerges.get(key);
        if (!bucket) {
            bucket = { key: { dataPoint, stationMac }, fragments: [] };
            pendingMerges.set(key, bucket);
        }
        // At this point raw passed identity check, so it IS an object.
        bucket.fragments.push({ originalIndex: i, record: raw });
    });
    // ---- 2. Dedup + merge fragments, then run Phase 2 body validation
    //         on each merged entry. `later wins` semantics per §3.3.2.
    //         Track per-field provenance so a warning about a specific
    //         field can be attributed to the fragment whose value for
    //         THAT field survived the merge (not just the last fragment).
    const globalOverrides = new Map();
    const stationOverrides = new Map();
    for (const { key, fragments } of pendingMerges.values()) {
        // Merge fragments field-by-field, later wins on conflict. Record
        // which fragment provided each field's final value.
        const merged = {};
        const provenance = {};
        for (const frag of fragments) {
            for (const [k, v] of Object.entries(frag.record)) {
                if (v !== undefined) {
                    merged[k] = v;
                    provenance[k] = frag.originalIndex;
                }
            }
        }
        // Warn once per duplicated key, per §3.3.2. Whole-row warning —
        // attributed to the FIRST fragment because that's the one users
        // typically scroll to first when auditing their config.
        if (fragments.length > 1) {
            warnings.push({
                overrideIndex: fragments[0].originalIndex,
                code: 'duplicate-merged',
                dataPoint: key.dataPoint,
                stationMac: key.stationMac,
                message: `Duplicate sensorMap entries for '${key.dataPoint}'${key.stationMac ? ` on ${key.stationMac}` : ''}; merged in order with later fields winning. Canonicalize on next UI save.`,
            });
        }
        const defaultRow = defaultRowFor(key.dataPoint);
        const result = validateOverrideBody(merged, key, defaultRow);
        // Body validation warnings — attribute each to the fragment
        // whose value for that field survived the merge. If the warning
        // has no field (whole-row warning), fall back to the last
        // fragment.
        const lastFragmentIndex = fragments[fragments.length - 1].originalIndex;
        for (const w of result.warnings) {
            const attributionIndex = w.field !== undefined && provenance[w.field] !== undefined
                ? provenance[w.field]
                : lastFragmentIndex;
            warnings.push({
                overrideIndex: attributionIndex,
                code: w.code,
                field: w.field,
                dataPoint: key.dataPoint,
                stationMac: key.stationMac,
                message: w.message,
            });
        }
        if (result.status === 'error') {
            // Attribute the error the same way we attribute warnings —
            // through per-field merge provenance when the failure names a
            // specific field, falling back to the last fragment for
            // row-scope failures (unknown key, missing required field,
            // kind × measurement incompatibility). Point at the fragment
            // that ACTUALLY caused the rejection so the UI can highlight
            // the right entry, not an unrelated last-write-wins fragment.
            const errField = result.field;
            const attributionIndex = errField !== undefined && provenance[errField] !== undefined
                ? provenance[errField]
                : lastFragmentIndex;
            errors.push({
                overrideIndex: attributionIndex,
                code: result.code,
                field: errField,
                dataPoint: key.dataPoint,
                stationMac: key.stationMac,
                message: result.message,
            });
            continue;
        }
        const validated = result.validated;
        if (validated.stationMac === undefined) {
            globalOverrides.set(validated.dataPoint, validated);
        }
        else {
            let m = stationOverrides.get(validated.stationMac);
            if (!m) {
                m = new Map();
                stationOverrides.set(validated.stationMac, m);
            }
            m.set(validated.dataPoint, validated);
        }
    }
    // ---- 2. Build lookup for discovery entries.
    const discoveryByStationDp = new Map();
    for (const e of input.discovery.entries) {
        discoveryByStationDp.set(`${e.stationMac.toUpperCase()}|${e.dataPoint}`, e);
    }
    const forgotten = new Set(input.uiState.forgottenFields.map((f) => `${f.stationMac.toUpperCase()}|${f.dataPoint}`));
    const pairs = new Map();
    const stationByMac = new Map();
    for (const s of input.stations) {
        stationByMac.set(s.macAddress.toUpperCase(), s.name);
    }
    // Defaults × stations.
    for (const station of input.stations) {
        const mac = station.macAddress.toUpperCase();
        for (const row of DEFAULT_SENSOR_MAP) {
            const key = `${mac}|${row.dataPoint}`;
            if (!pairs.has(key)) {
                pairs.set(key, { mac, dataPoint: row.dataPoint, stationName: station.name });
            }
        }
    }
    // Discovery-observed pairs.
    for (const e of input.discovery.entries) {
        const mac = e.stationMac.toUpperCase();
        const key = `${mac}|${e.dataPoint}`;
        if (!pairs.has(key)) {
            pairs.set(key, {
                mac,
                dataPoint: e.dataPoint,
                stationName: stationByMac.get(mac) ?? e.stationName,
            });
        }
    }
    // Station-specific override targets.
    for (const [mac, m] of stationOverrides) {
        for (const dp of m.keys()) {
            const key = `${mac}|${dp}`;
            if (!pairs.has(key)) {
                pairs.set(key, {
                    mac,
                    dataPoint: dp,
                    stationName: stationByMac.get(mac) ?? '',
                });
            }
        }
    }
    // ---- 4. Resolve each pair to an EffectiveSensorRow.
    const rows = [];
    for (const { mac, dataPoint } of pairs.values()) {
        const key = `${mac}|${dataPoint}`;
        // Skip forgotten unrecognized fields.
        if (forgotten.has(key) && !defaultRowFor(dataPoint)) {
            continue;
        }
        const defaultRow = defaultRowFor(dataPoint);
        const globalOv = globalOverrides.get(dataPoint);
        const stationOv = stationOverrides.get(mac)?.get(dataPoint);
        const merged = mergeOverrides(globalOv, stationOv);
        const discovered = discoveryByStationDp.get(key);
        const row = resolveRow({
            stationMac: mac,
            dataPoint,
            defaultRow,
            override: merged,
            discovered,
        });
        if (row) {
            rows.push(row);
        }
    }
    return { rows, errors, warnings };
}
// ---- Helpers ------------------------------------------------------
/**
 * Best-effort dataPoint extraction for a RowValidationError whose
 * source failed identity validation. Purely for user-facing error
 * attribution — do not use for anything semantic.
 */
function extractDataPointForError(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const dp = raw.dataPoint;
    return typeof dp === 'string' ? dp : undefined;
}
function extractStationMacForError(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const mac = raw.stationMac;
    return typeof mac === 'string' ? mac : undefined;
}
/**
 * Later-wins field merge for duplicate override entries with the same
 * (dataPoint, stationMac?) key. §3.3.2.
 */
function mergeInto(prev, next) {
    if (!prev) {
        return next;
    }
    const out = { ...prev, dataPoint: prev.dataPoint };
    const bag = out;
    for (const [k, v] of Object.entries(next)) {
        if (v !== undefined) {
            bag[k] = v;
        }
    }
    return out;
}
/** Station-specific fields override global fields for the same key. */
function mergeOverrides(global, station) {
    if (!global && !station) {
        return undefined;
    }
    if (!global) {
        return station;
    }
    if (!station) {
        return global;
    }
    return mergeInto(global, station);
}
function resolveRow(inp) {
    const { stationMac, dataPoint, defaultRow, override, discovered } = inp;
    // ---- Unrecognized: no default, no user override with kind+measurement.
    if (!defaultRow && !hasKindAndMeasurement(override)) {
        if (!discovered) {
            // Neither default, custom-declared, nor observed. Nothing to emit.
            return null;
        }
        return buildUnrecognizedRow(stationMac, dataPoint, discovered);
    }
    // ---- Resolve kind + measurement.
    const kind = (override?.kind && override.kind !== 'unrecognized' ? override.kind : undefined)
        ?? defaultRow?.kind
        ?? 'motion';
    const measurement = defaultRow?.measurement ?? override?.measurement ?? 'temperature';
    // ---- Resolve wrapper.
    const wrapper = defaultRow?.wrapper ?? WRAPPER_FOR_KIND_AND_MEASUREMENT[`${kind}|${measurement}`];
    if (!wrapper) {
        // Custom row with no registered wrapper for its (kind, measurement).
        // Should have been caught by validation; belt-and-suspenders skip.
        return null;
    }
    // ---- Resolve units.
    const sourceUnit = defaultRow?.sourceUnit ?? override?.sourceUnit;
    const displayUnit = override?.displayUnit ?? defaultRow?.displayUnit ?? sourceUnit;
    // ---- Resolve battery attachment.
    const batteryField = resolveBatteryField(defaultRow, override);
    const hasBatterySubService = batteryField !== null
        && (defaultRow?.canonicalForBattery ?? false);
    // ---- Resolve name.
    const name = override?.name ?? defaultRow?.name ?? dataPoint;
    // ---- Motion trigger fields. Non-motion rows never carry any of
    //       these — validation (Phase 2) has already stripped them
    //       from `override`, but we also gate the fallback to
    //       defaultRow here so a non-motion row's threshold/embedName
    //       can't slip through via the built-in default. §3.6 / §3.7.
    const isMotion = kind === 'motion';
    const triggerEnabled = isMotion
        ? (override?.triggerEnabled ?? defaultRow?.triggerEnabled ?? true)
        : false;
    const triggerDirection = isMotion
        ? (override?.triggerDirection ?? defaultRow?.triggerDirection ?? 'above')
        : 'above';
    const threshold = isMotion
        ? (override?.threshold ?? defaultRow?.threshold)
        : undefined;
    const embedName = isMotion
        ? (override?.embedName ?? defaultRow?.embedName ?? false)
        : false;
    const enabled = override?.enabled !== false;
    const wrapperId = wrapper.id;
    const structuralSignature = computeStructuralSignature(kind, measurement, hasBatterySubService, wrapper);
    const base = {
        dataPoint,
        stationMac,
        firstSeen: discovered?.firstSeen,
        lastSeen: discovered?.lastSeen,
        kind,
        name,
        threshold,
        triggerEnabled,
        triggerDirection,
        batteryField,
        hasBatterySubService,
        embedName,
        enabled,
        structuralSignature,
        wrapperId,
    };
    if (measurement === 'boolean') {
        const row = { ...base, measurement: 'boolean' };
        return row;
    }
    if (measurement === 'timestamp') {
        const row = { ...base, measurement: 'timestamp', sourceUnit: 'ms' };
        return row;
    }
    // Numeric.
    if (!sourceUnit || !displayUnit) {
        // Underspecified custom row that slipped past validation. Skip.
        return null;
    }
    const row = {
        ...base,
        measurement: measurement,
        sourceUnit,
        displayUnit,
    };
    return row;
}
function hasKindAndMeasurement(o) {
    return !!o && !!o.kind && o.kind !== 'unrecognized' && !!o.measurement;
}
function buildUnrecognizedRow(stationMac, dataPoint, discovered) {
    return {
        dataPoint,
        stationMac,
        kind: 'unrecognized',
        enabled: false,
        firstSeen: discovered.firstSeen,
        lastSeen: discovered.lastSeen,
    };
}
/**
 * batteryField resolution: explicit `null` in override suppresses the
 * plugin-default battery attachment. Absent in override → keep the
 * default. Otherwise use the override's value verbatim.
 */
function resolveBatteryField(defaultRow, override) {
    if (override && 'batteryField' in override) {
        return override.batteryField ?? null;
    }
    return defaultRow?.batteryField ?? null;
}
//# sourceMappingURL=buildEffectiveMap.js.map
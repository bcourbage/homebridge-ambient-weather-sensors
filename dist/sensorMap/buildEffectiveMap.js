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
    // batteryField provenance side-table — keyed by
    // `${stationMac ?? '*'}|${dataPoint}`, value is the originalIndex
    // of the merge fragment that supplied the winning `batteryField`.
    // The ownership pass (in resolveRow) reads this to attribute
    // `duplicate-battery-owner` warnings to the loser's actual
    // config-authored fragment, not a synthetic -1 sentinel that
    // violates the Group 1 provenance contract.
    const batteryFieldProvenance = new Map();
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
        if (provenance.batteryField !== undefined) {
            batteryFieldProvenance.set(`${key.stationMac ?? '*'}|${key.dataPoint}`, provenance.batteryField);
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
    // Global custom override targets × every known station.
    //
    // A global custom row (stationMac absent, dataPoint outside the
    // built-in default map) declares a custom sensor the user wants
    // on every station. Without this pass, such rows only produce a
    // pair once AWN's discovery layer observes the dataPoint on a
    // specific station — meaning a valid custom configuration
    // produces no row and no error until discovery happens. Per
    // review finding #8, we emit a row for the (station, dataPoint)
    // pair on every station in inventory so the user gets immediate
    // feedback ("waiting for station" rows, per §3.3.4 of
    // sensor-map.md), instead of a silent nothing.
    for (const dp of globalOverrides.keys()) {
        if (defaultRowFor(dp)) {
            // Global row for a known dataPoint — the defaults × stations
            // pass above already emitted a pair for every station.
            continue;
        }
        for (const station of input.stations) {
            const mac = station.macAddress.toUpperCase();
            const key = `${mac}|${dp}`;
            if (!pairs.has(key)) {
                pairs.set(key, {
                    mac,
                    dataPoint: dp,
                    stationName: station.name,
                });
            }
        }
    }
    // ---- 4. Resolve each pair to an EffectiveSensorRow.
    //
    // The battery-ownership context is threaded through the pass so
    // custom rows can claim their (station, batteryField) key. Iteration
    // order determines first-writer-wins for custom-vs-custom collisions;
    // the pair map is insertion-ordered (defaults first per §3 above,
    // then discovery, then station-specific and global custom targets)
    // so a default canonical row always resolves before any custom row
    // that might collide with it — matches the reserved-owner rule.
    const rows = [];
    const batteryOwnership = {
        reservedFields: RESERVED_BATTERY_FIELDS,
        claims: new Map(),
        onDuplicate: (mac, batteryField, winner, loser, loserOverrideIndex) => {
            // Attribute the warning to the fragment that supplied the
            // losing row's `batteryField` — real config authorship, per
            // Group 1's provenance contract. Fallback: the winner's
            // provenance, if the loser had no config-authored field.
            //
            // If NEITHER side has provenance, both collided rows were
            // authored by the default map. That's a plugin bug (two
            // canonical owners for the same field) — the startup
            // invariant in `assertCanonicalBatteryOwnersUnique()` below
            // catches that at module load, so this branch is unreachable
            // in shipping code. We keep the guard here as belt-and-
            // suspenders: rather than manufacture an unrelated
            // `overrideIndex: 0` and mislead the UI, drop the warning
            // and log at debug — the invariant assertion is what surfaces
            // the real problem to the developer.
            const winnerIndex = batteryFieldProvenance.get(`${mac}|${winner}`)
                ?? batteryFieldProvenance.get(`*|${winner}`);
            const attribution = loserOverrideIndex ?? winnerIndex;
            if (attribution === undefined) {
                // No config authorship on either side — see comment above.
                // The RowValidationWarning shape requires overrideIndex,
                // so skipping the push is the only way to avoid inventing a
                // bogus one. A follow-up PR (per the reviewer, aligned with
                // PR #19's `EffectiveSensorMap.notes` design) will route
                // attribution-free collisions through an internal-invariant
                // channel instead. Until then, silently drop.
                return;
            }
            warnings.push({
                overrideIndex: attribution,
                code: 'duplicate-battery-owner',
                field: 'batteryField',
                dataPoint: loser,
                stationMac: mac,
                message: `Row '${loser}' on ${mac} declares batteryField '${batteryField}', `
                    + `but '${winner}' already owns that field's Battery sub-service on this station. `
                    + `'${loser}' will report the battery value but not host the HAP BatteryService.`,
            });
        },
    };
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
        // Provenance for THIS row's batteryField: station-scoped wins
        // over global (the same precedence mergeOverrides applies).
        const overrideIndex = batteryFieldProvenance.get(`${mac}|${dataPoint}`)
            ?? batteryFieldProvenance.get(`*|${dataPoint}`);
        const row = resolveRow({
            stationMac: mac,
            dataPoint,
            defaultRow,
            override: merged,
            discovered,
            overrideIndex,
            batteryOwnership,
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
    const { stationMac, dataPoint, defaultRow, override, discovered, batteryOwnership } = inp;
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
    // ---- Resolve enabled BEFORE battery ownership. A disabled row
    //       must never consume a claim slot; see the
    //       `resolveHasBatterySubService` doc-comment for why.
    const enabled = override?.enabled !== false;
    // ---- Resolve battery attachment.
    const batteryField = resolveBatteryField(defaultRow, override);
    const hasBatterySubService = resolveHasBatterySubService(stationMac, dataPoint, batteryField, defaultRow, enabled, inp.overrideIndex, batteryOwnership);
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
/**
 * Static set of every `batteryField` value reserved by a canonical
 * default-map row. Computed once at module load. A custom row's
 * `batteryField` that appears in this set gets `hasBatterySubService:
 * false` — the reserved default row owns the sub-service and a
 * custom row cannot take that over (rule 2 in
 * `BatteryOwnershipContext`).
 */
const RESERVED_BATTERY_FIELDS = new Set(DEFAULT_SENSOR_MAP
    .filter(r => r.canonicalForBattery && r.batteryField !== null)
    .map(r => r.batteryField));
/**
 * Startup invariant: every non-null `batteryField` in
 * `DEFAULT_SENSOR_MAP` has AT MOST ONE row with
 * `canonicalForBattery: true`. Violating this would produce a
 * duplicate-battery-owner collision on rows that have no
 * user-authored `overrideIndex` — i.e. both sides come from the
 * default map — and the warning would have no honest fragment to
 * attribute to. Failing fast at module load is preferable to
 * silently degrading to a debug-log-and-drop path at runtime.
 *
 * Executed unconditionally on import; if it ever throws in CI, the
 * offending DEFAULT_SENSOR_MAP entries need to be reconciled.
 */
function assertCanonicalBatteryOwnersUnique() {
    const owners = new Map();
    for (const row of DEFAULT_SENSOR_MAP) {
        if (!row.canonicalForBattery || row.batteryField === null) {
            continue;
        }
        const existing = owners.get(row.batteryField);
        if (existing !== undefined) {
            throw new Error(`DEFAULT_SENSOR_MAP invariant violation: batteryField '${row.batteryField}' `
                + `has two canonical owners ('${existing}' and '${row.dataPoint}'). `
                + 'A batteryField may be shared by many rows but must have exactly one '
                + 'row with canonicalForBattery: true.');
        }
        owners.set(row.batteryField, row.dataPoint);
    }
}
assertCanonicalBatteryOwnersUnique();
/**
 * Ownership decision for a single row. See `BatteryOwnershipContext`
 * for the full rule; this function is where those rules are executed
 * per row and where `claims` gets mutated on a successful custom
 * attachment.
 *
 * Order of operations, per Group 4 follow-up review:
 *
 *   1. If the row's effective batteryField is null → no sub-service.
 *   2. If the row is DISABLED (`enabled: false`) → no sub-service AND
 *      no claim recorded. A disabled row must never block an enabled
 *      row from taking ownership of the same batteryField.
 *   3. Canonical-owner fast path: a default-map row whose resolved
 *      batteryField still equals `defaultRow.batteryField` and
 *      `canonicalForBattery: true` — reserved forever, no need to
 *      touch claims (the reservation is static across resolveRow
 *      calls; other rows check RESERVED_BATTERY_FIELDS below).
 *   4. Any other row (custom OR default-with-overridden-batteryField
 *      OR non-canonical default with explicit user-set batteryField):
 *      go through the CLAIMS path. Reject if RESERVED_BATTERY_FIELDS
 *      says the field is default-owned. Otherwise first-writer wins
 *      via ownership.claims.
 */
function resolveHasBatterySubService(stationMac, dataPoint, batteryField, defaultRow, enabled, overrideIndex, ownership) {
    if (batteryField === null) {
        return false;
    }
    if (!enabled) {
        // Disabled rows never own a sub-service and never consume a
        // claim slot. This is the fix for the "disabled row wins over
        // enabled row" bug flagged in the Group 4 follow-up.
        return false;
    }
    const isCanonicalDefault = defaultRow !== undefined
        && defaultRow.canonicalForBattery
        && defaultRow.batteryField === batteryField;
    if (isCanonicalDefault) {
        // Canonical owner keeps ownership. Reserved by DEFAULT_SENSOR_MAP
        // (see RESERVED_BATTERY_FIELDS); no need to record in claims
        // because reservation is checked statically below.
        return true;
    }
    // Any other row wanting a sub-service — including a default row
    // whose batteryField was OVERRIDDEN to something novel, or a
    // non-canonical default with an explicit user batteryField, or a
    // custom row — must go through the reserved-set + claims path.
    if (RESERVED_BATTERY_FIELDS.has(batteryField)) {
        return false;
    }
    const key = `${stationMac}|${batteryField}`;
    const priorClaim = ownership.claims.get(key);
    if (priorClaim !== undefined) {
        ownership.onDuplicate(stationMac, batteryField, priorClaim, dataPoint, overrideIndex);
        return false;
    }
    ownership.claims.set(key, dataPoint);
    return true;
}
//# sourceMappingURL=buildEffectiveMap.js.map
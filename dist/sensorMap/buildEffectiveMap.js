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
import { validateOverride } from './validation.js';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from './wrappers.js';
export function buildEffectiveSensorMap(input) {
    if (input.configMode === 'safe-mode') {
        return { rows: [], errors: [] };
    }
    const errors = [];
    // ---- 1. Validate + partition overrides by (dataPoint, stationMac?)
    //         with de-dup (later wins per §3.3.2).
    const validated = validateOverrides(input.userOverrides, errors);
    const globalOverrides = new Map();
    const stationOverrides = new Map();
    for (const o of validated) {
        if (o.stationMac === undefined) {
            globalOverrides.set(o.dataPoint, mergeInto(globalOverrides.get(o.dataPoint), o));
        }
        else {
            const mac = o.stationMac.toUpperCase();
            let m = stationOverrides.get(mac);
            if (!m) {
                m = new Map();
                stationOverrides.set(mac, m);
            }
            m.set(o.dataPoint, mergeInto(m.get(o.dataPoint), o));
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
    for (const { mac, dataPoint, stationName: _stationName } of pairs.values()) {
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
    return { rows, errors };
}
// ---- Helpers ------------------------------------------------------
function validateOverrides(overrides, errors) {
    const valid = [];
    overrides.forEach((o, i) => {
        const defaultRow = o.dataPoint ? defaultRowFor(o.dataPoint) : undefined;
        const result = validateOverride(o, defaultRow);
        if (result.status === 'error') {
            errors.push({
                overrideIndex: i,
                dataPoint: o.dataPoint,
                stationMac: o.stationMac,
                message: result.message,
            });
            return;
        }
        valid.push(o);
    });
    return valid;
}
/**
 * Later-wins field merge for duplicate override entries with the same
 * (dataPoint, stationMac?) key. §3.3.2.
 */
function mergeInto(prev, next) {
    if (!prev)
        return next;
    const out = { ...prev };
    for (const [k, v] of Object.entries(next)) {
        if (v !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            out[k] = v;
        }
    }
    return out;
}
/** Station-specific fields override global fields for the same key. */
function mergeOverrides(global, station) {
    if (!global && !station)
        return undefined;
    if (!global)
        return station;
    if (!station)
        return global;
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
    // ---- Motion trigger fields.
    const isMotion = kind === 'motion';
    const triggerEnabled = isMotion
        ? (override?.triggerEnabled ?? defaultRow?.triggerEnabled ?? true)
        : false;
    const triggerDirection = isMotion
        ? (override?.triggerDirection ?? defaultRow?.triggerDirection ?? 'above')
        : 'above';
    const threshold = override?.threshold ?? defaultRow?.threshold;
    const embedName = isMotion ? (override?.embedName ?? defaultRow?.embedName ?? false) : false;
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
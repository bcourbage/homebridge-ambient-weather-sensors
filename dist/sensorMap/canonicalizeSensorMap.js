/**
 * Canonical sensorMap serializer (§11.3 / §17.4, as amended by review
 * #67 round 2) — the ONLY producer of the `sensorMap` array that gets
 * written to config.json. The client may submit proposed editor state,
 * but it is never responsible for assembling canonical config: the
 * compose-save boundary runs the proposal through this serializer and
 * persists the result.
 *
 * LAYERING PRESERVATION (the round-2 amendment): canonical output
 * mirrors the proposal's OWN global/station structure, read through the
 * same §3.3.2 merge machinery the resolver uses
 * (`partitionOverrideLayers`):
 *
 *   - a GLOBAL override stays a global entry — it is a TEMPLATE that
 *     must keep applying to stations that appear in the future;
 *   - a STATION override serializes as an EXCEPTION relative to the
 *     global layer (or the built-in baseline when no global layer
 *     exists for that dataPoint);
 *   - the serializer NEVER materializes a global template into
 *     per-station entries, and NEVER collapses authored per-station
 *     entries into a new global template — both directions silently
 *     change behavior on future stations. (This supersedes the original
 *     §11.3 rule 2 "identical values collapse to global"; template
 *     scope is user intent, not an optimization target.)
 *
 * MINIMAL DIFF, no second resolver: every diff side comes from the REAL
 * `buildEffectiveSensorMap`:
 *   - global entries diff the GLOBAL-LAYER effective map against the
 *     pure-defaults baseline (known dps) or the row's minimal identity
 *     declaration (custom dps);
 *   - station exceptions diff the FULL effective map against the
 *     global-layer map (falling back to defaults/identity when the
 *     dataPoint has no global layer).
 * Custom rows always re-declare their identity (kind, measurement,
 * numeric sourceUnit) in the layer that introduces them.
 *
 * Idempotency is structural: reloading canonical output reproduces the
 * same layers, so repeated saves are byte-stable — and the compose-save
 * boundary independently gates on full effective-map equivalence
 * INCLUDING a synthetic never-seen station (template equivalence).
 *
 * Ordering (§17.4): entries sort by `dataPoint`, global before station,
 * MACs ascending case-insensitive; fields in the fixed §17.4 order.
 */
import { buildEffectiveSensorMap, partitionOverrideLayers } from './buildEffectiveMap.js';
import { defaultRowFor } from './defaultMap.js';
/** §17.4 rule 4 — the fixed field order for byte-stable output. */
const FIELD_ORDER = [
    'batteryField', 'dataPoint', 'displayUnit', 'embedName', 'enabled',
    'kind', 'measurement', 'name', 'sourceUnit', 'stationMac',
    'threshold', 'triggerDirection', 'triggerEnabled',
];
/** The user-controllable fields a diff can emit. */
const DIFF_FIELDS = [
    'kind', 'measurement', 'name', 'threshold', 'triggerEnabled',
    'triggerDirection', 'displayUnit', 'sourceUnit', 'batteryField',
    'embedName', 'enabled',
];
export function canonicalizeSensorMap(input) {
    const common = {
        discovery: input.discovery,
        uiState: input.uiState,
        stations: input.stations,
        configMode: 'v2',
    };
    const byKey = (m) => {
        const out = new Map();
        for (const row of m.rows) {
            if (row.kind !== 'unrecognized') {
                out.set(`${row.stationMac}|${row.dataPoint}`, row);
            }
        }
        return out;
    };
    const layers = partitionOverrideLayers(input.overrides);
    const full = byKey(buildEffectiveSensorMap({ ...common, userOverrides: [...input.overrides] }));
    const defaults = byKey(buildEffectiveSensorMap({ ...common, userOverrides: [] }));
    const globalLayer = byKey(buildEffectiveSensorMap({
        ...common,
        userOverrides: [...layers.global.values()],
    }));
    // Identity baselines for CUSTOM dataPoints, declared in the layer
    // that introduces them: a global custom gets a GLOBAL identity
    // override; a custom introduced only by a station override gets a
    // STATION-SCOPED identity (review round-1 P1-2: identities are
    // per-station facts, never borrowed across stations).
    const identityOverrides = [];
    const identityFor = (row, stationMac) => {
        const identity = {
            dataPoint: row.dataPoint,
            kind: row.kind,
            measurement: row.measurement,
        };
        if (stationMac !== undefined) {
            identity.stationMac = stationMac;
        }
        if (row.measurement !== 'timestamp' && row.measurement !== 'boolean') {
            identity.sourceUnit = row.sourceUnit;
        }
        return identity;
    };
    const stationMacs = input.stations.map(s => s.macAddress.toUpperCase());
    for (const dp of layers.global.keys()) {
        if (defaultRowFor(dp)) {
            continue;
        }
        // Any station's global-layer row carries the template identity.
        const row = stationMacs.map(mac => globalLayer.get(`${mac}|${dp}`)).find(r => r !== undefined);
        if (row) {
            identityOverrides.push(identityFor(row));
        }
    }
    for (const [mac, perDp] of layers.station) {
        for (const dp of perDp.keys()) {
            if (defaultRowFor(dp) || globalLayer.get(`${mac}|${dp}`)) {
                continue; // known, or identity already provided by the global layer
            }
            const row = full.get(`${mac}|${dp}`);
            if (row) {
                identityOverrides.push(identityFor(row, mac));
            }
        }
    }
    const identity = byKey(buildEffectiveSensorMap({ ...common, userOverrides: identityOverrides }));
    const diffRows = (proposed, reference) => {
        const out = {};
        for (const f of DIFF_FIELDS) {
            const a = proposed[f];
            const b = reference ? reference[f] : undefined;
            if (a !== b) {
                out[f] = a;
            }
        }
        return out;
    };
    const entries = [];
    // ---- Global entries: the template layer vs the built-in baseline.
    for (const dp of layers.global.keys()) {
        const isCustom = !defaultRowFor(dp);
        const row = stationMacs.map(mac => globalLayer.get(`${mac}|${dp}`)).find(r => r !== undefined);
        if (!row) {
            // The global layer alone doesn't resolve a configured row on any
            // current station (e.g. a custom template whose identity is
            // completed by station overrides). Effective defaults for it
            // cannot be computed, so preserve the merged template VERBATIM —
            // dropping or reshaping it would change future-station behavior.
            const merged = layers.global.get(dp);
            const fields = {};
            for (const f of DIFF_FIELDS) {
                const v = merged[f];
                if (v !== undefined || (f === 'batteryField' && 'batteryField' in merged)) {
                    fields[f] = v;
                }
            }
            if (Object.keys(fields).length > 0) {
                entries.push({ dataPoint: dp, fields });
            }
            continue;
        }
        const reference = isCustom
            ? identity.get(`${row.stationMac}|${dp}`)
            : defaults.get(`${row.stationMac}|${dp}`);
        const fields = diffRows(row, reference);
        if (isCustom) {
            // Custom templates always re-declare identity.
            fields.kind = row.kind;
            fields.measurement = row.measurement;
            if (row.measurement !== 'timestamp' && row.measurement !== 'boolean') {
                fields.sourceUnit = row.sourceUnit;
            }
        }
        if (Object.keys(fields).length > 0) {
            entries.push({ dataPoint: dp, fields });
        }
    }
    // ---- Station entries: exceptions relative to the global layer
    //      (falling back to defaults/identity when no global layer
    //      configures the dataPoint on that station).
    for (const [mac, perDp] of layers.station) {
        for (const dp of perDp.keys()) {
            const key = `${mac}|${dp}`;
            const proposed = full.get(key);
            if (!proposed) {
                continue; // row didn't resolve (station not in inventory, etc.)
            }
            const isCustom = !defaultRowFor(dp);
            const globalRow = globalLayer.get(key);
            const reference = globalRow
                ?? (isCustom ? identity.get(key) : defaults.get(key));
            const fields = diffRows(proposed, reference);
            const onlyIdentityRestated = isCustom && globalRow !== undefined
                && Object.keys(fields).length === 0;
            if (isCustom) {
                // Custom station entries ALWAYS re-declare identity — the
                // frozen per-key validation (§3.7) requires kind + measurement
                // (+ numeric sourceUnit) on EVERY custom entry, so a canonical
                // exception must be independently valid when reloaded. Without
                // this, the reload drops the entry as custom-missing-kind and
                // the divergence gate refuses the save.
                fields.kind = proposed.kind;
                fields.measurement = proposed.measurement;
                if (proposed.measurement !== 'timestamp' && proposed.measurement !== 'boolean') {
                    fields.sourceUnit = proposed.sourceUnit;
                }
            }
            // A custom exception that restates ONLY the template's identity
            // adds nothing — the global layer already provides it.
            if (Object.keys(fields).length > 0 && !onlyIdentityRestated) {
                entries.push({ dataPoint: dp, stationMac: mac, fields });
            }
        }
    }
    // ---- Ordering (§17.4 rules 3–4) + fixed field order.
    entries.sort((a, b) => {
        if (a.dataPoint !== b.dataPoint) {
            return a.dataPoint < b.dataPoint ? -1 : 1;
        }
        const am = a.stationMac?.toLowerCase();
        const bm = b.stationMac?.toLowerCase();
        if (am === bm) {
            return 0;
        }
        if (am === undefined) {
            return -1; // global first
        }
        if (bm === undefined) {
            return 1;
        }
        return am < bm ? -1 : 1;
    });
    return entries.map(({ dataPoint, stationMac, fields }) => {
        const out = {};
        for (const f of FIELD_ORDER) {
            if (f === 'dataPoint') {
                out.dataPoint = dataPoint;
            }
            else if (f === 'stationMac') {
                if (stationMac !== undefined) {
                    out.stationMac = stationMac;
                }
            }
            else if (fields[f] !== undefined || (f === 'batteryField' && f in fields)) {
                // batteryField: null is a meaningful suppression value.
                out[f] = fields[f];
            }
        }
        return out;
    });
}
//# sourceMappingURL=canonicalizeSensorMap.js.map
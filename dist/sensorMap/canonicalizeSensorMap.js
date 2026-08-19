/**
 * Canonical sensorMap serializer (§11.3 / §17.4) — the ONLY producer of
 * the `sensorMap` array that gets written to config.json. The client
 * may submit proposed editor state, but it is never responsible for
 * assembling canonical config: the compose-save boundary runs the
 * proposal through this serializer and persists the result.
 *
 * Definition (§11.3): an override contains only fields whose effective
 * value differs from the v2 built-in baseline for the same
 * `(stationMac, dataPoint)`.
 *
 * IMPLEMENTATION PRINCIPLE — no second resolver: both sides of the
 * diff come from the REAL `buildEffectiveSensorMap`:
 *   - the proposal side is the effective map built from the proposed
 *     overrides;
 *   - the baseline side is the effective map built from NO overrides
 *     (pure defaults) for known datapoints, or from the row's minimal
 *     identity declaration (`dataPoint` + `kind` + `measurement` +
 *     numeric `sourceUnit`) for custom datapoints — so derived
 *     defaults (names, measurement-aware trigger directions, display
 *     units, battery ownership) are computed by the same machinery
 *     that will interpret the serialized result on the next load.
 * That construction makes idempotency structural:
 * `canonicalize(load(canonicalize(x)))` compares equal effective maps,
 * so repeated saves are byte-stable (§17.4 rule 5's test).
 *
 * Canonicalization rules enforced here:
 *   1. At most one entry per `(dataPoint, stationMac?)` key.
 *   2. Identical field values across ALL inventory stations collapse
 *      to a single global override (no `stationMac`).
 *   3. Divergent stations get per-station entries, and only for
 *      stations whose diff is non-empty.
 *   4. Fields within an entry appear in the fixed §17.4 order.
 *   5. Entries sort by `dataPoint`, then global-first, then
 *      `stationMac` ascending case-insensitive.
 */
import { buildEffectiveSensorMap } from './buildEffectiveMap.js';
import { defaultRowFor } from './defaultMap.js';
/** §17.4 rule 4 — the fixed field order for byte-stable output. */
const FIELD_ORDER = [
    'batteryField', 'dataPoint', 'displayUnit', 'embedName', 'enabled',
    'kind', 'measurement', 'name', 'sourceUnit', 'stationMac',
    'threshold', 'triggerDirection', 'triggerEnabled',
];
/** The user-controllable fields a diff can emit (identity excluded). */
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
    const proposal = buildEffectiveSensorMap({ ...common, userOverrides: [...input.overrides] });
    // Baseline for KNOWN datapoints: the pure-defaults effective map.
    const defaults = buildEffectiveSensorMap({ ...common, userOverrides: [] });
    const defaultsByKey = new Map();
    for (const row of defaults.rows) {
        if (row.kind !== 'unrecognized') {
            defaultsByKey.set(`${row.stationMac}|${row.dataPoint}`, row);
        }
    }
    // Baseline for CUSTOM datapoints: the minimal identity declaration,
    // resolved by the same machinery (one batch map for all customs).
    const customIdentity = new Map();
    for (const row of proposal.rows) {
        if (row.kind === 'unrecognized' || defaultRowFor(row.dataPoint)) {
            continue;
        }
        if (!customIdentity.has(row.dataPoint)) {
            const identity = {
                dataPoint: row.dataPoint,
                kind: row.kind,
                measurement: row.measurement,
            };
            if (row.measurement !== 'timestamp' && row.measurement !== 'boolean') {
                identity.sourceUnit = row.sourceUnit;
            }
            customIdentity.set(row.dataPoint, identity);
        }
    }
    const identityBaseline = buildEffectiveSensorMap({
        ...common,
        userOverrides: [...customIdentity.values()],
    });
    const identityByKey = new Map();
    for (const row of identityBaseline.rows) {
        if (row.kind !== 'unrecognized') {
            identityByKey.set(`${row.stationMac}|${row.dataPoint}`, row);
        }
    }
    const diffsByDp = new Map(); // dp → stationMac → diff
    for (const row of proposal.rows) {
        if (row.kind === 'unrecognized') {
            continue;
        }
        const key = `${row.stationMac}|${row.dataPoint}`;
        const isCustom = !defaultRowFor(row.dataPoint);
        const baseline = isCustom ? identityByKey.get(key) : defaultsByKey.get(key);
        const diff = {};
        if (isCustom) {
            // Identity fields are always declared for a custom row.
            const identity = customIdentity.get(row.dataPoint);
            diff.kind = identity.kind;
            diff.measurement = identity.measurement;
            if (identity.sourceUnit !== undefined) {
                diff.sourceUnit = identity.sourceUnit;
            }
        }
        for (const f of DIFF_FIELDS) {
            if (isCustom && (f === 'kind' || f === 'measurement' || f === 'sourceUnit')) {
                continue; // identity, already emitted
            }
            const proposed = row[f];
            const base = baseline ? baseline[f] : undefined;
            if (proposed !== base) {
                diff[f] = proposed;
            }
        }
        if (Object.keys(diff).length === 0) {
            continue;
        }
        let perStation = diffsByDp.get(row.dataPoint);
        if (!perStation) {
            perStation = new Map();
            diffsByDp.set(row.dataPoint, perStation);
        }
        perStation.set(row.stationMac, diff);
    }
    // ---- Station collapse (§11.3 rule 2): identical diffs across ALL
    //      inventory stations become one global entry.
    const stationMacs = input.stations.map(s => s.macAddress.toUpperCase());
    const entries = [];
    for (const [dp, perStation] of diffsByDp) {
        const payloads = [...perStation.values()].map(d => stableStringify(d));
        const coversAll = stationMacs.length > 0
            && stationMacs.every(mac => perStation.has(mac));
        const allIdentical = new Set(payloads).size === 1;
        if (coversAll && allIdentical) {
            entries.push({ dataPoint: dp, fields: [...perStation.values()][0] });
        }
        else {
            for (const [mac, diff] of perStation) {
                entries.push({ dataPoint: dp, stationMac: mac, fields: diff });
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
/** Deterministic JSON for diff-payload comparison (sorted keys). */
function stableStringify(v) {
    return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))));
}
//# sourceMappingURL=canonicalizeSensorMap.js.map
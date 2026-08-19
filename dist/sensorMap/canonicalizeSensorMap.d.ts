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
import type { DiscoveryStore, SensorMapOverride, StationInventory, UiStateStore } from './types.js';
export interface CanonicalizeInput {
    /** Proposed overrides — already normalized + validated (zero errors). */
    overrides: ReadonlyArray<SensorMapOverride>;
    stations: StationInventory;
    discovery: DiscoveryStore;
    uiState: UiStateStore;
}
export declare function canonicalizeSensorMap(input: CanonicalizeInput): SensorMapOverride[];
//# sourceMappingURL=canonicalizeSensorMap.d.ts.map
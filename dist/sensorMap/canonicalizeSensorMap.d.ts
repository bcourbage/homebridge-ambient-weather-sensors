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
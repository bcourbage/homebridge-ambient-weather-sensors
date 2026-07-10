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
import type { DiscoveryStore, EffectiveSensorMap, SensorMapOverride, StationInventory, UiStateStore, WrapperDescriptor } from './types.js';
export interface BuildInput {
    userOverrides: ReadonlyArray<SensorMapOverride>;
    discovery: DiscoveryStore;
    uiState: UiStateStore;
    stations: StationInventory;
    configMode: 'legacy' | 'v2' | 'safe-mode';
}
export declare function buildEffectiveSensorMap(input: BuildInput): EffectiveSensorMap;
export type { WrapperDescriptor };
//# sourceMappingURL=buildEffectiveMap.d.ts.map
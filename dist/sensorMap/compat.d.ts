/**
 * Compat layer — translate a v1.6.0 (legacy) config into synthetic
 * global SensorMapOverride entries, deterministically and one-shot.
 *
 * See docs/future/sensor-map.md §6. The layer's contract:
 *   - Reads a LegacyConfig (whatever fields the user has set)
 *   - Emits a SensorMapOverride[] with `stationMac` absent (all global)
 *   - buildEffectiveSensorMap consumes them like any other override
 *   - Nothing written back to config.json; the projection is
 *     recomputed every boot
 *
 * The layer runs ONLY when configMode === 'legacy' (Stage 5). If the
 * user has a `sensorMap` field defined, v2 mode wins and this layer
 * is skipped entirely.
 *
 * Behavioral invariant: for any 1.6.0 config, the effective map
 * produced by (defaults + compatOverrides) MUST produce the same
 * HAP service graph as v1.6.0's determineSensorType-based pipeline.
 * Tested by the migration-equivalence property tests (§12.7),
 * scheduled for Stage 9.
 */
import type { SensorMapOverride, SensorUnit } from './types.js';
/**
 * v1.6.0 config shape — union of every field the compat layer inspects.
 * Fields the compat layer doesn't consume (stationFilter, dataSource,
 * apiKey/applicationKey, embedNameUpdateMinIntervalMinutes) are
 * intentionally omitted; they either flow through unchanged or are
 * consumed elsewhere.
 */
export interface LegacyConfig {
    temperatureSensors?: boolean;
    humiditySensors?: boolean;
    solarRadiationSensors?: boolean;
    co2Sensors?: boolean;
    airQualitySensors?: boolean;
    extendedSensors?: boolean;
    windSensors?: boolean;
    rainSensors?: boolean;
    pressureSensors?: boolean;
    uvSensors?: boolean;
    lightningSensors?: boolean;
    extendedDisplayMode?: 'static' | 'embed';
    thresholds?: {
        windSpeedEnabled?: boolean;
        windSpeedMph?: number;
        windGustEnabled?: boolean;
        windGustMph?: number;
        rainRateEnabled?: boolean;
        rainRateInHr?: number;
        uvEnabled?: boolean;
        uv?: number;
        lightningDistanceEnabled?: boolean;
        lightningDistanceMi?: number;
        pressureEnabled?: boolean;
        pressureLowInHg?: number;
    };
    units?: {
        windSpeed?: SensorUnit;
        rain?: SensorUnit;
        pressure?: SensorUnit;
        distance?: SensorUnit;
    };
    excludeSensors?: string[];
    includeOnly?: string[];
}
/**
 * Public entry point. Returns global overrides (no `stationMac`).
 *
 * Result is stable across calls with equal input — safe to cache but
 * cheap enough to recompute each boot.
 */
export declare function compatToOverrides(legacy: LegacyConfig): SensorMapOverride[];
//# sourceMappingURL=compat.d.ts.map
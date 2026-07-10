/**
 * Default sensor map — the plugin's built-in knowledge about every
 * AWN datapoint it can render out-of-the-box.
 *
 * See docs/future/sensor-map.md §11.1 (audit table) and §11.2
 * (bootstrap rule). The invariant: every row in this map produces
 * the same HAP service graph that v1.6.0 produced for the same
 * AWN key. See tests/unit/sensorMap/*.test.ts for the property-driven
 * checks that enforce this.
 *
 * Layout:
 *   1. Static rows (41 entries) — one per named AWN datapoint the
 *      plugin knows the shape of.
 *   2. Numbered-probe rows (28 entries) — generated for the WH31
 *      channel probes: temp{1..10}f, humidity{1..10},
 *      feelsLike{1..4}, dewPoint{1..4}.
 *
 * Batteries: `canonicalForBattery: true` marks the one row per
 * batteryField that hosts the Battery sub-service in HomeKit.
 * Non-canonical rows keep the batteryField for row identity but
 * do NOT get a sub-service — see docs §11 and batteryFields.ts.
 */
import type { DefaultSensorRow } from './types.js';
export declare const DEFAULT_SENSOR_MAP: ReadonlyArray<DefaultSensorRow>;
export declare function defaultRowFor(dataPoint: string): DefaultSensorRow | undefined;
//# sourceMappingURL=defaultMap.d.ts.map
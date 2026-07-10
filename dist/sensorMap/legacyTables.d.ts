/**
 * Legacy-type tables — bootstrap support for v1.5.0 / v1.6.0 cached
 * accessories that pre-date the sensor-map model.
 *
 * See docs/future/sensor-map.md §11.2 (bootstrap rule).
 *
 * Cached accessories from v1.5.x / v1.6.x carry a `context.device.type`
 * string like "Temperature", "WindSpeed", "LightningDistance", etc.
 * On first v2.0 startup, `inferForCachedAccessory` reads that string
 * and looks up the corresponding kind + measurement here.
 *
 * `LEGACY_TYPE_TO_KIND` and `LEGACY_TYPE_TO_MEASUREMENT` are 1:1 —
 * every key in one MUST have a matching key in the other, or the
 * bootstrap rule falls back to `'preserve-cached'` for that
 * accessory. Property-driven tests enforce the parity.
 *
 * These tables are frozen at the v1.6.0 legacy vocabulary. New
 * sensors added in v2.0+ don't need entries here — they'll never
 * appear as legacy `type` strings on cached accessories.
 */
import type { SensorKind, Measurement } from './types.js';
export declare const LEGACY_TYPE_TO_KIND: Readonly<Record<string, Exclude<SensorKind, 'unrecognized'>>>;
export declare const LEGACY_TYPE_TO_MEASUREMENT: Readonly<Record<string, Measurement>>;
/**
 * The set of all known legacy `type` strings. Used by tests to
 * enforce parity between the two tables above.
 */
export declare const LEGACY_TYPES: ReadonlyArray<string>;
//# sourceMappingURL=legacyTables.d.ts.map
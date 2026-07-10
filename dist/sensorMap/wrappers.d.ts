/**
 * Wrapper descriptors — stable identity for accessory-wrapper classes.
 *
 * See docs/future/sensor-map.md §3.9 and §9. Every distinct
 * `(kind, measurement)` pair the plugin can render maps to exactly one
 * WrapperDescriptor. `id` is baked into the row's
 * `structuralSignature`, so:
 *
 *   1. Renaming a wrapper class (TS refactor) does NOT invalidate
 *      cached accessories — the id is what persists.
 *   2. Changing a wrapper's HAP service graph (adding a characteristic,
 *      swapping a service type) is signaled by bumping `schemaVersion`,
 *      which invalidates ONLY that wrapper's accessories on next launch.
 *
 * `WRAPPER_FOR_KIND_AND_MEASUREMENT` resolves the wrapper for a custom
 * sensor from its user-declared `(kind, measurement)`. Known-datapoint
 * rows carry their wrapper directly in the default map (see
 * `defaultMap.ts`); this lookup only matters for custom sensors.
 *
 * Kinds not yet backed by a concrete wrapper class in the codebase
 * (`co`, `leak`, `contact`, `occupancy`) are absent from the lookup
 * table. A custom row declaring one of those kinds fails validation
 * with "no wrapper available for kind X"; concrete classes will land
 * in a later beta stage once the data-model layer is proven.
 */
import type { WrapperDescriptor, SensorKind, Measurement } from './types.js';
export declare const TEMPERATURE_WRAPPER: WrapperDescriptor;
export declare const HUMIDITY_WRAPPER: WrapperDescriptor;
export declare const LIGHT_WM2_WRAPPER: WrapperDescriptor;
export declare const CO2_WRAPPER: WrapperDescriptor;
export declare const PM25_WRAPPER: WrapperDescriptor;
export declare const PM10_WRAPPER: WrapperDescriptor;
export declare const UV_INDEX_WRAPPER: WrapperDescriptor;
export declare const WIND_SPEED_WRAPPER: WrapperDescriptor;
export declare const WIND_GUST_WRAPPER: WrapperDescriptor;
export declare const WIND_MAX_DAILY_GUST_WRAPPER: WrapperDescriptor;
export declare const WIND_DIRECTION_WRAPPER: WrapperDescriptor;
export declare const WIND_DIRECTION_10M_WRAPPER: WrapperDescriptor;
export declare const PRESSURE_RELATIVE_WRAPPER: WrapperDescriptor;
export declare const PRESSURE_ABSOLUTE_WRAPPER: WrapperDescriptor;
export declare const RAIN_RATE_WRAPPER: WrapperDescriptor;
export declare const RAIN_EVENT_WRAPPER: WrapperDescriptor;
export declare const RAIN_DAILY_WRAPPER: WrapperDescriptor;
export declare const RAIN_WEEKLY_WRAPPER: WrapperDescriptor;
export declare const RAIN_MONTHLY_WRAPPER: WrapperDescriptor;
export declare const RAIN_YEARLY_WRAPPER: WrapperDescriptor;
export declare const LAST_RAIN_WRAPPER: WrapperDescriptor;
export declare const LIGHTNING_DAY_WRAPPER: WrapperDescriptor;
export declare const LIGHTNING_HOUR_WRAPPER: WrapperDescriptor;
export declare const LIGHTNING_DISTANCE_WRAPPER: WrapperDescriptor;
export declare const LIGHTNING_LAST_STRIKE_WRAPPER: WrapperDescriptor;
/**
 * All registered wrapper descriptors. Used by tests to verify id
 * uniqueness and by the runtime for a sanity self-check at bootstrap.
 */
export declare const ALL_WRAPPERS: ReadonlyArray<WrapperDescriptor>;
/**
 * Custom-sensor wrapper resolution: given a user-declared
 * `(kind, measurement)`, return the wrapper the plugin should use.
 *
 * `motion`-kind rows disambiguate on measurement alone; a custom
 * `motion` + `wind-speed` sensor gets `WIND_SPEED_WRAPPER`. This
 * keeps the wrapper contract identical between known and custom rows.
 *
 * Kinds without a concrete wrapper class in the current codebase
 * (co, leak, contact, occupancy) are absent — a custom row declaring
 * one fails validation with "no wrapper for (kind, measurement)".
 * Add wrappers for those kinds in later stages.
 *
 * Where a measurement has multiple candidate wrappers (multiple rain
 * accumulation windows, multiple lightning views), the lookup picks
 * the most "generic" — rain-event for accumulation, lightning-day for
 * count. Users wanting a different sub-flavor must declare the row
 * matching an existing AWN dataPoint (which routes through the
 * default map) rather than fabricating a custom one.
 */
export declare const WRAPPER_FOR_KIND_AND_MEASUREMENT: Readonly<Partial<Record<`${Exclude<SensorKind, 'unrecognized'>}|${Measurement}`, WrapperDescriptor>>>;
/**
 * Resolve wrapper for a `(kind, measurement)` pair. Returns undefined
 * if no wrapper is registered. Callers must handle undefined by failing
 * validation (never by silently dropping the row).
 */
export declare function wrapperFor(kind: Exclude<SensorKind, 'unrecognized'>, measurement: Measurement): WrapperDescriptor | undefined;
//# sourceMappingURL=wrappers.d.ts.map
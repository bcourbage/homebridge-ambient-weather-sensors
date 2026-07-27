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
 * The 25 ids below are the FROZEN v2.0 vocabulary — matching the
 * design doc §3.9 table exactly. Changing an id after 2.0.0 ships
 * silently invalidates every user's accessory cache.
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
export declare const SOLAR_RADIATION_WRAPPER: WrapperDescriptor;
export declare const CO2_WRAPPER: WrapperDescriptor;
export declare const AIR_QUALITY_PM25_WRAPPER: WrapperDescriptor;
export declare const AIR_QUALITY_PM10_WRAPPER: WrapperDescriptor;
export declare const UV_WRAPPER: WrapperDescriptor;
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
 * The frozen, ordered registry of every wrapper the plugin ships.
 * Order is stable — the snapshot test in `wrappers.test.ts` locks
 * both the exact set of (id, schemaVersion) pairs and their order,
 * so a well-meaning rename or reorder breaks CI instead of silently
 * invalidating user caches. See review finding #14.
 *
 * Runtime `Object.freeze` on the array + each descriptor (applied
 * at module load, below) guards against accidental in-place
 * mutation of descriptor fields — the `readonly` compile-time
 * annotations already do most of the work; the freeze is
 * belt-and-suspenders for anything reaching the registry through
 * an untyped path.
 */
export declare const ALL_WRAPPERS: ReadonlyArray<WrapperDescriptor>;
/**
 * Custom-sensor wrapper resolution: given a user-declared
 * `(kind, measurement)`, return the wrapper the plugin should use.
 *
 * `motion`-kind rows disambiguate on measurement alone. Where a
 * measurement has multiple candidate wrappers (rain-accumulation
 * covers event/daily/weekly/monthly/yearly; count covers day/hour;
 * timestamp covers last-rain / last-strike), the lookup picks the
 * most "generic" — the top-level accumulation / count / timestamp
 * variant. Users wanting a sub-flavor declare the row against the
 * matching known dataPoint via the default map instead.
 *
 * Kinds without a concrete wrapper class (co, leak, contact,
 * occupancy) are absent — a custom row declaring one fails
 * validation with "no wrapper for (kind, measurement)".
 */
export declare const WRAPPER_FOR_KIND_AND_MEASUREMENT: Readonly<Partial<Record<`${Exclude<SensorKind, 'unrecognized'>}|${Measurement}`, WrapperDescriptor>>>;
export declare function wrapperFor(kind: Exclude<SensorKind, 'unrecognized'>, measurement: Measurement): WrapperDescriptor | undefined;
//# sourceMappingURL=wrappers.d.ts.map
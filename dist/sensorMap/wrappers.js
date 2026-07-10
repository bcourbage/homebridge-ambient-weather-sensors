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
import { TemperatureAccessory } from '../temperatureAccessory.js';
import { HumidityAccessory } from '../humidityAccessory.js';
import { SolarRadiationAccessory } from '../solarRadiationAccessory.js';
import { Co2Accessory } from '../co2Accessory.js';
import { AirQualityAccessory } from '../airQualityAccessory.js';
import { UvAccessory } from '../extendedSensors/uvAccessory.js';
import { WindSpeedAccessory, WindGustAccessory, WindMaxDailyGustAccessory, WindDirectionAccessory, WindDirection10mAccessory, } from '../extendedSensors/windAccessory.js';
import { PressureRelativeAccessory, PressureAbsoluteAccessory, } from '../extendedSensors/pressureAccessory.js';
import { RainRateAccessory, RainEventAccessory, RainDailyAccessory, RainWeeklyAccessory, RainMonthlyAccessory, RainYearlyAccessory, LastRainAccessory, } from '../extendedSensors/rainAccessory.js';
import { LightningDayAccessory, LightningHourAccessory, LightningDistanceAccessory, LightningLastStrikeAccessory, } from '../extendedSensors/lightningAccessory.js';
/*
 * Value-tile wrappers: Apple Home renders the reading directly.
 * These share `kind` with their measurement; wrapper `id` uses the
 * kind name for stability.
 */
export const TEMPERATURE_WRAPPER = {
    id: 'temperature',
    schemaVersion: 1,
    constructor: TemperatureAccessory,
};
export const HUMIDITY_WRAPPER = {
    id: 'humidity',
    schemaVersion: 1,
    constructor: HumidityAccessory,
};
export const LIGHT_WM2_WRAPPER = {
    id: 'light-wm2',
    schemaVersion: 1,
    constructor: SolarRadiationAccessory,
};
export const CO2_WRAPPER = {
    id: 'co2',
    schemaVersion: 1,
    constructor: Co2Accessory,
};
export const PM25_WRAPPER = {
    id: 'air-quality-pm25',
    schemaVersion: 1,
    constructor: AirQualityAccessory,
};
export const PM10_WRAPPER = {
    id: 'air-quality-pm10',
    schemaVersion: 1,
    constructor: AirQualityAccessory,
};
/*
 * State-tile / motion-family wrappers: every non-value HAP sensor
 * (wind, rain, pressure, UV, lightning) is rendered as MotionSensor
 * in the v1.6.0 wire-up. The wrapper class differs per measurement
 * because threshold semantics and value shape differ.
 */
export const UV_INDEX_WRAPPER = {
    id: 'uv-index-motion',
    schemaVersion: 1,
    constructor: UvAccessory,
};
export const WIND_SPEED_WRAPPER = {
    id: 'wind-speed-motion',
    schemaVersion: 1,
    constructor: WindSpeedAccessory,
};
export const WIND_GUST_WRAPPER = {
    id: 'wind-gust-motion',
    schemaVersion: 1,
    constructor: WindGustAccessory,
};
export const WIND_MAX_DAILY_GUST_WRAPPER = {
    id: 'wind-max-daily-gust-motion',
    schemaVersion: 1,
    constructor: WindMaxDailyGustAccessory,
};
export const WIND_DIRECTION_WRAPPER = {
    id: 'wind-direction-motion',
    schemaVersion: 1,
    constructor: WindDirectionAccessory,
};
export const WIND_DIRECTION_10M_WRAPPER = {
    id: 'wind-direction-10m-motion',
    schemaVersion: 1,
    constructor: WindDirection10mAccessory,
};
export const PRESSURE_RELATIVE_WRAPPER = {
    id: 'pressure-relative-motion',
    schemaVersion: 1,
    constructor: PressureRelativeAccessory,
};
export const PRESSURE_ABSOLUTE_WRAPPER = {
    id: 'pressure-absolute-motion',
    schemaVersion: 1,
    constructor: PressureAbsoluteAccessory,
};
export const RAIN_RATE_WRAPPER = {
    id: 'rain-rate-motion',
    schemaVersion: 1,
    constructor: RainRateAccessory,
};
export const RAIN_EVENT_WRAPPER = {
    id: 'rain-event-motion',
    schemaVersion: 1,
    constructor: RainEventAccessory,
};
export const RAIN_DAILY_WRAPPER = {
    id: 'rain-daily-motion',
    schemaVersion: 1,
    constructor: RainDailyAccessory,
};
export const RAIN_WEEKLY_WRAPPER = {
    id: 'rain-weekly-motion',
    schemaVersion: 1,
    constructor: RainWeeklyAccessory,
};
export const RAIN_MONTHLY_WRAPPER = {
    id: 'rain-monthly-motion',
    schemaVersion: 1,
    constructor: RainMonthlyAccessory,
};
export const RAIN_YEARLY_WRAPPER = {
    id: 'rain-yearly-motion',
    schemaVersion: 1,
    constructor: RainYearlyAccessory,
};
export const LAST_RAIN_WRAPPER = {
    id: 'last-rain-timestamp-motion',
    schemaVersion: 1,
    constructor: LastRainAccessory,
};
export const LIGHTNING_DAY_WRAPPER = {
    id: 'lightning-day-motion',
    schemaVersion: 1,
    constructor: LightningDayAccessory,
};
export const LIGHTNING_HOUR_WRAPPER = {
    id: 'lightning-hour-motion',
    schemaVersion: 1,
    constructor: LightningHourAccessory,
};
export const LIGHTNING_DISTANCE_WRAPPER = {
    id: 'lightning-distance-motion',
    schemaVersion: 1,
    constructor: LightningDistanceAccessory,
};
export const LIGHTNING_LAST_STRIKE_WRAPPER = {
    id: 'lightning-last-strike-motion',
    schemaVersion: 1,
    constructor: LightningLastStrikeAccessory,
};
/**
 * All registered wrapper descriptors. Used by tests to verify id
 * uniqueness and by the runtime for a sanity self-check at bootstrap.
 */
export const ALL_WRAPPERS = [
    TEMPERATURE_WRAPPER,
    HUMIDITY_WRAPPER,
    LIGHT_WM2_WRAPPER,
    CO2_WRAPPER,
    PM25_WRAPPER,
    PM10_WRAPPER,
    UV_INDEX_WRAPPER,
    WIND_SPEED_WRAPPER,
    WIND_GUST_WRAPPER,
    WIND_MAX_DAILY_GUST_WRAPPER,
    WIND_DIRECTION_WRAPPER,
    WIND_DIRECTION_10M_WRAPPER,
    PRESSURE_RELATIVE_WRAPPER,
    PRESSURE_ABSOLUTE_WRAPPER,
    RAIN_RATE_WRAPPER,
    RAIN_EVENT_WRAPPER,
    RAIN_DAILY_WRAPPER,
    RAIN_WEEKLY_WRAPPER,
    RAIN_MONTHLY_WRAPPER,
    RAIN_YEARLY_WRAPPER,
    LAST_RAIN_WRAPPER,
    LIGHTNING_DAY_WRAPPER,
    LIGHTNING_HOUR_WRAPPER,
    LIGHTNING_DISTANCE_WRAPPER,
    LIGHTNING_LAST_STRIKE_WRAPPER,
];
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
export const WRAPPER_FOR_KIND_AND_MEASUREMENT = {
    'temperature|temperature': TEMPERATURE_WRAPPER,
    'humidity|humidity': HUMIDITY_WRAPPER,
    'light|illuminance': LIGHT_WM2_WRAPPER,
    'co2|co2': CO2_WRAPPER,
    'air-quality-pm25|pm25': PM25_WRAPPER,
    'air-quality-pm10|pm10': PM10_WRAPPER,
    'motion|uv-index': UV_INDEX_WRAPPER,
    'motion|wind-speed': WIND_SPEED_WRAPPER,
    'motion|direction': WIND_DIRECTION_WRAPPER,
    'motion|pressure': PRESSURE_RELATIVE_WRAPPER,
    'motion|rain-rate': RAIN_RATE_WRAPPER,
    'motion|rain-accumulation': RAIN_EVENT_WRAPPER,
    'motion|distance': LIGHTNING_DISTANCE_WRAPPER,
    'motion|count': LIGHTNING_DAY_WRAPPER,
    'motion|timestamp': LAST_RAIN_WRAPPER,
};
/**
 * Resolve wrapper for a `(kind, measurement)` pair. Returns undefined
 * if no wrapper is registered. Callers must handle undefined by failing
 * validation (never by silently dropping the row).
 */
export function wrapperFor(kind, measurement) {
    return WRAPPER_FOR_KIND_AND_MEASUREMENT[`${kind}|${measurement}`];
}
//# sourceMappingURL=wrappers.js.map
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

import { TemperatureAccessory } from '../temperatureAccessory.js';
import { HumidityAccessory } from '../humidityAccessory.js';
import { SolarRadiationAccessory } from '../solarRadiationAccessory.js';
import { Co2Accessory } from '../co2Accessory.js';
import { AirQualityAccessory } from '../airQualityAccessory.js';
import { UvAccessory } from '../extendedSensors/uvAccessory.js';
import {
  WindSpeedAccessory,
  WindGustAccessory,
  WindMaxDailyGustAccessory,
  WindDirectionAccessory,
  WindDirection10mAccessory,
} from '../extendedSensors/windAccessory.js';
import {
  PressureRelativeAccessory,
  PressureAbsoluteAccessory,
} from '../extendedSensors/pressureAccessory.js';
import {
  RainRateAccessory,
  RainEventAccessory,
  RainDailyAccessory,
  RainWeeklyAccessory,
  RainMonthlyAccessory,
  RainYearlyAccessory,
  LastRainAccessory,
} from '../extendedSensors/rainAccessory.js';
import {
  LightningDayAccessory,
  LightningHourAccessory,
  LightningDistanceAccessory,
  LightningLastStrikeAccessory,
} from '../extendedSensors/lightningAccessory.js';

// Value-tile wrappers — Apple Home renders reading directly.
export const TEMPERATURE_WRAPPER: WrapperDescriptor = {
  id: 'temperature',
  schemaVersion: 1,
  constructor: TemperatureAccessory,
};

export const HUMIDITY_WRAPPER: WrapperDescriptor = {
  id: 'humidity',
  schemaVersion: 1,
  constructor: HumidityAccessory,
};

export const SOLAR_RADIATION_WRAPPER: WrapperDescriptor = {
  id: 'solar-radiation',
  schemaVersion: 1,
  constructor: SolarRadiationAccessory,
};

export const CO2_WRAPPER: WrapperDescriptor = {
  id: 'co2',
  schemaVersion: 1,
  constructor: Co2Accessory,
};

// PM2.5 and PM10 share the AirQualityAccessory class but have
// distinct ids because their HAP characteristic set differs
// (PM2_5Density vs. PM10Density).
export const AIR_QUALITY_PM25_WRAPPER: WrapperDescriptor = {
  id: 'air-quality-pm25',
  schemaVersion: 1,
  constructor: AirQualityAccessory,
};

export const AIR_QUALITY_PM10_WRAPPER: WrapperDescriptor = {
  id: 'air-quality-pm10',
  schemaVersion: 1,
  constructor: AirQualityAccessory,
};

// State-tile / motion-family wrappers — every non-value HAP sensor
// (wind, rain, pressure, UV, lightning) is rendered as MotionSensor.
// Each measurement has its own wrapper class with distinct threshold
// semantics and value shape.
export const UV_WRAPPER: WrapperDescriptor = {
  id: 'uv',
  schemaVersion: 1,
  constructor: UvAccessory,
};

export const WIND_SPEED_WRAPPER: WrapperDescriptor = {
  id: 'wind-speed',
  schemaVersion: 1,
  constructor: WindSpeedAccessory,
};

export const WIND_GUST_WRAPPER: WrapperDescriptor = {
  id: 'wind-gust',
  schemaVersion: 1,
  constructor: WindGustAccessory,
};

export const WIND_MAX_DAILY_GUST_WRAPPER: WrapperDescriptor = {
  id: 'wind-max-daily-gust',
  schemaVersion: 1,
  constructor: WindMaxDailyGustAccessory,
};

export const WIND_DIRECTION_WRAPPER: WrapperDescriptor = {
  id: 'wind-direction',
  schemaVersion: 1,
  constructor: WindDirectionAccessory,
};

export const WIND_DIRECTION_10M_WRAPPER: WrapperDescriptor = {
  id: 'wind-direction-10m',
  schemaVersion: 1,
  constructor: WindDirection10mAccessory,
};

export const PRESSURE_RELATIVE_WRAPPER: WrapperDescriptor = {
  id: 'pressure-relative',
  schemaVersion: 1,
  constructor: PressureRelativeAccessory,
};

export const PRESSURE_ABSOLUTE_WRAPPER: WrapperDescriptor = {
  id: 'pressure-absolute',
  schemaVersion: 1,
  constructor: PressureAbsoluteAccessory,
};

export const RAIN_RATE_WRAPPER: WrapperDescriptor = {
  id: 'rain-rate',
  schemaVersion: 1,
  constructor: RainRateAccessory,
};

export const RAIN_EVENT_WRAPPER: WrapperDescriptor = {
  id: 'rain-event',
  schemaVersion: 1,
  constructor: RainEventAccessory,
};

export const RAIN_DAILY_WRAPPER: WrapperDescriptor = {
  id: 'rain-daily',
  schemaVersion: 1,
  constructor: RainDailyAccessory,
};

export const RAIN_WEEKLY_WRAPPER: WrapperDescriptor = {
  id: 'rain-weekly',
  schemaVersion: 1,
  constructor: RainWeeklyAccessory,
};

export const RAIN_MONTHLY_WRAPPER: WrapperDescriptor = {
  id: 'rain-monthly',
  schemaVersion: 1,
  constructor: RainMonthlyAccessory,
};

export const RAIN_YEARLY_WRAPPER: WrapperDescriptor = {
  id: 'rain-yearly',
  schemaVersion: 1,
  constructor: RainYearlyAccessory,
};

export const LAST_RAIN_WRAPPER: WrapperDescriptor = {
  id: 'last-rain',
  schemaVersion: 1,
  constructor: LastRainAccessory,
};

export const LIGHTNING_DAY_WRAPPER: WrapperDescriptor = {
  id: 'lightning-day',
  schemaVersion: 1,
  constructor: LightningDayAccessory,
};

export const LIGHTNING_HOUR_WRAPPER: WrapperDescriptor = {
  id: 'lightning-hour',
  schemaVersion: 1,
  constructor: LightningHourAccessory,
};

export const LIGHTNING_DISTANCE_WRAPPER: WrapperDescriptor = {
  id: 'lightning-distance',
  schemaVersion: 1,
  constructor: LightningDistanceAccessory,
};

export const LIGHTNING_LAST_STRIKE_WRAPPER: WrapperDescriptor = {
  id: 'lightning-last-strike',
  schemaVersion: 1,
  constructor: LightningLastStrikeAccessory,
};

export const ALL_WRAPPERS: ReadonlyArray<WrapperDescriptor> = [
  TEMPERATURE_WRAPPER,
  HUMIDITY_WRAPPER,
  SOLAR_RADIATION_WRAPPER,
  CO2_WRAPPER,
  AIR_QUALITY_PM25_WRAPPER,
  AIR_QUALITY_PM10_WRAPPER,
  UV_WRAPPER,
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
] as const;

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
export const WRAPPER_FOR_KIND_AND_MEASUREMENT: Readonly<Partial<Record<`${Exclude<SensorKind, 'unrecognized'>}|${Measurement}`, WrapperDescriptor>>> = {
  'temperature|temperature':      TEMPERATURE_WRAPPER,
  'humidity|humidity':            HUMIDITY_WRAPPER,
  'light|illuminance':            SOLAR_RADIATION_WRAPPER,
  'co2|co2':                      CO2_WRAPPER,
  'air-quality-pm25|pm25':        AIR_QUALITY_PM25_WRAPPER,
  'air-quality-pm10|pm10':        AIR_QUALITY_PM10_WRAPPER,
  'motion|uv-index':              UV_WRAPPER,
  'motion|wind-speed':            WIND_SPEED_WRAPPER,
  'motion|direction':             WIND_DIRECTION_WRAPPER,
  'motion|pressure':              PRESSURE_RELATIVE_WRAPPER,
  'motion|rain-rate':             RAIN_RATE_WRAPPER,
  'motion|rain-accumulation':     RAIN_EVENT_WRAPPER,
  'motion|distance':              LIGHTNING_DISTANCE_WRAPPER,
  'motion|count':                 LIGHTNING_DAY_WRAPPER,
  'motion|timestamp':             LAST_RAIN_WRAPPER,
} as const;

export function wrapperFor(kind: Exclude<SensorKind, 'unrecognized'>, measurement: Measurement): WrapperDescriptor | undefined {
  return WRAPPER_FOR_KIND_AND_MEASUREMENT[`${kind}|${measurement}`];
}

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

export const LEGACY_TYPE_TO_KIND: Readonly<Record<string, Exclude<SensorKind, 'unrecognized'>>> = {
  'Temperature':         'temperature',
  'Humidity':            'humidity',
  'Solar Radiation':     'light',
  'CO2':                 'co2',
  'PM2.5':               'air-quality-pm25',
  'PM10':                'air-quality-pm10',
  'WindSpeed':           'motion',
  'WindGust':            'motion',
  'WindMaxDailyGust':    'motion',
  'WindDirection':       'motion',
  'WindDirection10m':    'motion',
  'RainRate':            'motion',
  'RainEvent':           'motion',
  'RainDaily':           'motion',
  'RainWeekly':          'motion',
  'RainMonthly':         'motion',
  'RainYearly':          'motion',
  'LastRain':            'motion',
  'PressureRelative':    'motion',
  'PressureAbsolute':    'motion',
  'UV':                  'motion',
  'LightningDay':        'motion',
  'LightningHour':       'motion',
  'LightningDistance':   'motion',
  'LightningLastStrike': 'motion',
} as const;

export const LEGACY_TYPE_TO_MEASUREMENT: Readonly<Record<string, Measurement>> = {
  'Temperature':         'temperature',
  'Humidity':            'humidity',
  'Solar Radiation':     'illuminance',
  'CO2':                 'co2',
  'PM2.5':               'pm25',
  'PM10':                'pm10',
  'WindSpeed':           'wind-speed',
  'WindGust':            'wind-speed',
  'WindMaxDailyGust':    'wind-speed',
  'WindDirection':       'direction',
  'WindDirection10m':    'direction',
  'RainRate':            'rain-rate',
  'RainEvent':           'rain-accumulation',
  'RainDaily':           'rain-accumulation',
  'RainWeekly':          'rain-accumulation',
  'RainMonthly':         'rain-accumulation',
  'RainYearly':          'rain-accumulation',
  'LastRain':            'timestamp',
  'PressureRelative':    'pressure',
  'PressureAbsolute':    'pressure',
  'UV':                  'uv-index',
  'LightningDay':        'count',
  'LightningHour':       'count',
  'LightningDistance':   'distance',
  'LightningLastStrike': 'timestamp',
} as const;

/**
 * The set of all known legacy `type` strings. Used by tests to
 * enforce parity between the two tables above.
 */
export const LEGACY_TYPES: ReadonlyArray<string> = Object.keys(LEGACY_TYPE_TO_KIND);

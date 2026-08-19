/**
 * Unit compatibility — allowed units per measurement, plus defaults.
 *
 * See §3.5 of the design doc. Thresholds are always stored in a row's
 * `sourceUnit`; conversion to `displayUnit` happens at render time only.
 *
 * `LEGAL_UNITS_FOR_MEASUREMENT` is the single source of truth for
 * unit validation. If a user's `displayUnit` (or a custom row's
 * `sourceUnit`) isn't in the measurement's legal set, the row fails
 * validation (§3.7).
 *
 * Two special measurements have no user-facing unit choice:
 *   - `timestamp`: sourceUnit is always 'ms'; no displayUnit
 *   - `boolean`: no units of any kind
 * Both are represented as empty arrays here; validation logic treats
 * an empty legal set as "no units accepted."
 */

import type { Measurement, SensorUnit } from './types.js';

export const LEGAL_UNITS_FOR_MEASUREMENT: Readonly<Record<Measurement, ReadonlyArray<SensorUnit>>> = {
  temperature:         ['fahrenheit', 'celsius'],
  humidity:            ['percent'],
  illuminance:         ['wm2', 'lux', 'fc'],
  co2:                 ['ppm'],
  co:                  ['ppm'],
  pm25:                ['ugm3'],
  pm10:                ['ugm3'],
  'wind-speed':        ['mph', 'fps', 'mps', 'kph', 'kts'],
  'rain-rate':         ['in_per_hr', 'mm_per_hr'],
  'rain-accumulation': ['in', 'mm'],
  pressure:            ['inHg', 'mmHg', 'hPa'],
  distance:            ['mi', 'km', 'nm'],
  'uv-index':          ['index'],
  count:               ['count'],
  direction:           ['degrees'],
  timestamp:           ['ms'],
  boolean:             [],
} as const;

/**
 * Default source unit — the unit AWN itself reports the measurement in.
 * Users cannot change this for known datapoints (baked into the default
 * map); for custom datapoints, users declare `sourceUnit` from the legal
 * set.
 *
 * `illuminance` has two natural sources: solar radiation is W/m², but
 * a hypothetical dedicated lux sensor would report lux directly. The
 * default map picks the source per row; this table records the more
 * common source (W/m² for solar) as the fallback default for custom
 * illuminance sensors.
 */
export const DEFAULT_SOURCE_UNIT_FOR_MEASUREMENT: Readonly<Partial<Record<Measurement, SensorUnit>>> = {
  temperature:         'fahrenheit',
  humidity:            'percent',
  illuminance:         'wm2',
  co2:                 'ppm',
  co:                  'ppm',
  pm25:                'ugm3',
  pm10:                'ugm3',
  'wind-speed':        'mph',
  'rain-rate':         'in_per_hr',
  'rain-accumulation': 'in',
  pressure:            'inHg',
  distance:            'mi',
  'uv-index':          'index',
  count:               'count',
  direction:           'degrees',
  timestamp:           'ms',
  // boolean intentionally omitted — no unit applies
} as const;

/**
 * Default display unit — what HomeKit renders to the user. Matches
 * source unit by default (imperial-preferred for US-defaulted AWN
 * data); users override via `displayUnit`.
 */
export const DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT: Readonly<Partial<Record<Measurement, SensorUnit>>> = {
  temperature:         'fahrenheit',
  humidity:            'percent',
  illuminance:         'lux',       // HomeKit LightSensor accepts lux
  co2:                 'ppm',
  co:                  'ppm',
  pm25:                'ugm3',
  pm10:                'ugm3',
  'wind-speed':        'mph',
  'rain-rate':         'in_per_hr',
  'rain-accumulation': 'in',
  pressure:            'inHg',
  distance:            'mi',
  'uv-index':          'index',
  count:               'count',
  direction:           'degrees',
  // timestamp intentionally omitted — rendered as relative time, no display unit
  // boolean intentionally omitted
} as const;

/**
 * Check whether a unit is legal for a given measurement.
 */
export function isLegalUnit(measurement: Measurement, unit: SensorUnit): boolean {
  return LEGAL_UNITS_FOR_MEASUREMENT[measurement].includes(unit);
}

/**
 * Compatibility of measurement with kind. Determines which kinds a
 * custom sensor can use for a given measurement, AND validates that
 * a user's kind-override on a known datapoint doesn't cross measurement
 * families (§3.8).
 *
 * Most measurements map to exactly one kind. `boolean` is the sole
 * exception — three state-tile kinds (leak / contact / occupancy)
 * render similarly and the user picks semantics.
 */
export const COMPATIBLE_KINDS_FOR_MEASUREMENT: Readonly<Record<Measurement, ReadonlyArray<Exclude<import('./types.js').SensorKind, 'unrecognized'>>>> = {
  temperature:         ['temperature'],
  humidity:            ['humidity'],
  illuminance:         ['light'],
  co2:                 ['co2'],
  co:                  ['co'],
  pm25:                ['air-quality-pm25'],
  pm10:                ['air-quality-pm10'],
  'wind-speed':        ['motion'],
  'rain-rate':         ['motion'],
  'rain-accumulation': ['motion'],
  pressure:            ['motion'],
  distance:            ['motion'],
  'uv-index':          ['motion'],
  count:               ['motion'],
  direction:           ['motion'],
  timestamp:           ['motion'],
  boolean:             ['leak', 'contact', 'occupancy'],
} as const;

export function isCompatibleKind(measurement: Measurement, kind: Exclude<import('./types.js').SensorKind, 'unrecognized'>): boolean {
  return COMPATIBLE_KINDS_FOR_MEASUREMENT[measurement].includes(kind);
}

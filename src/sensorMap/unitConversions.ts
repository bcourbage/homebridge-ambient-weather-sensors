/**
 * Canonical unit routing (finding-#4 wrapper parameterization, Stage 2).
 *
 * Under the row model a wrapper receives a raw AWN value whose unit is
 * `row.sourceUnit` (not necessarily AWN's imperial default — a custom
 * sensor may report temperature in Celsius). Every wrapper family has
 * ONE canonical unit it does its internal work in — thresholding and
 * intensity bucketing are scale-anchored there:
 *
 *   | family            | canonical  |
 *   |-------------------|------------|
 *   | temperature       | celsius    |
 *   | humidity          | percent    |
 *   | illuminance       | lux        |
 *   | co2 / co          | ppm        |
 *   | pm25 / pm10       | ugm3       |
 *   | wind-speed        | mph        |
 *   | rain-rate         | in_per_hr  |
 *   | rain-accumulation | in         |
 *   | pressure          | inHg       |
 *   | distance          | mi         |
 *   | uv-index          | index      |
 *   | direction         | degrees    |
 *   | count             | count      |
 *   | timestamp         | ms         |
 *
 * `toCanonical` converts a raw value FROM its source unit to canonical;
 * `toDisplayUnit` converts a canonical value TO a presentation unit for
 * the extended wrappers' custom-string characteristic. Both delegate to
 * the existing `nativeConversions` / `extendedSensors/unitConversions`
 * helpers so the arithmetic is byte-identical to v1.6.0 for every
 * AWN-native (imperial) source unit — the identity case is a no-op and
 * the non-identity cases (a custom metric sensor) are the only new math.
 *
 * Canonical for temperature is Celsius, so an AWN-native
 * `sourceUnit: 'fahrenheit'` is converted to Celsius AT THE BOUNDARY
 * here rather than inside `TemperatureAccessory`. The arithmetic is
 * identical; only the layer that owns it moves.
 */

import type { Measurement, SensorUnit } from './types.js';

import { fahrenheitToCelsius, solarWm2ToLux } from '../nativeConversions.js';
import {
  convertSpeed,
  convertRain,
  convertPressure,
  convertDistance,
} from '../extendedSensors/unitConversions.js';

/**
 * The canonical unit each measurement is compared / bucketed in.
 * `boolean` has no unit (rows forbid one); it maps to `'count'` as an
 * inert placeholder never consulted — `toCanonical`/`toDisplayUnit`
 * short-circuit boolean and timestamp before reading this table.
 */
export const CANONICAL_UNIT_FOR_MEASUREMENT: Record<Measurement, SensorUnit> = {
  'temperature':       'celsius',
  'humidity':          'percent',
  'illuminance':       'lux',
  'co2':               'ppm',
  'co':                'ppm',
  'pm25':              'ugm3',
  'pm10':              'ugm3',
  'wind-speed':        'mph',
  'rain-rate':         'in_per_hr',
  'rain-accumulation': 'in',
  'pressure':          'inHg',
  'distance':          'mi',
  'uv-index':          'index',
  'count':             'count',
  'direction':         'degrees',
  'timestamp':         'ms',
  'boolean':           'count',
} as const;

// Conversion factors relative to the family's canonical unit:
// `value_in_unit = value_in_canonical * factor`, so the inverse used
// by toCanonical is `value_in_canonical = value_in_unit / factor`.
// Only linear (non-affine) families live here; temperature and
// illuminance are affine/rounded special cases handled inline.
const WIND_FACTOR_FROM_MPH: Partial<Record<SensorUnit, number>> = {
  mph: 1, kph: 1.60934, mps: 0.44704, kts: 0.86898,
};

const DISTANCE_FACTOR_FROM_MI: Partial<Record<SensorUnit, number>> = {
  mi: 1, km: 1.60934, nm: 0.868976,
};

const IN_PER_MM = 25.4;          // rain accumulation + rate
const INHG_PER_HPA = 33.8639;    // pressure
const WM2_PER_LUX = 0.0079;      // illuminance (solar): lux = wm2 / WM2_PER_LUX

/**
 * Convert a raw reading from its `sourceUnit` to its measurement's
 * canonical unit. The identity case (`sourceUnit === canonical`) is a
 * no-op. Delegates to the shared conversion helpers so AWN-native
 * (imperial) inputs produce byte-identical results to v1.6.0.
 *
 * `timestamp` and `boolean` measurements have no unit conversion — the
 * value passes through untouched (a timestamp is already ms; a boolean
 * is already 0/1).
 */
export function toCanonical(measurement: Measurement, sourceUnit: SensorUnit, value: number): number {
  switch (measurement) {
    case 'temperature':
      return sourceUnit === 'fahrenheit' ? fahrenheitToCelsius(value) : value;
    case 'illuminance':
      // Canonical is lux. AWN reports W/m²; a custom sensor may report
      // lux directly. `solarWm2ToLux` rounds (matching v1.6.0's native
      // write), so the wm2 path stays exactly what SolarRadiationAccessory
      // produced before this refactor.
      return sourceUnit === 'wm2' ? solarWm2ToLux(value) : value;
    case 'wind-speed': {
      const factor = WIND_FACTOR_FROM_MPH[sourceUnit] ?? 1;
      return value / factor;
    }
    case 'rain-rate':
      return sourceUnit === 'mm_per_hr' ? value / IN_PER_MM : value;
    case 'rain-accumulation':
      return sourceUnit === 'mm' ? value / IN_PER_MM : value;
    case 'pressure':
      return sourceUnit === 'hPa' ? value / INHG_PER_HPA : value;
    case 'distance': {
      const factor = DISTANCE_FACTOR_FROM_MI[sourceUnit] ?? 1;
      return value / factor;
    }
    // humidity, co2/co, pm25/pm10, uv-index, count, direction,
    // timestamp, boolean — canonical == source, identity.
    default:
      return value;
  }
}

/**
 * Convert a canonical value to a presentation `displayUnit`. The ONLY
 * consumer is the extended wrappers' custom-string characteristic
 * (the label users see in Eve / Home / Controller). Native HAP
 * wrappers never call this — they write canonical into a fixed-unit
 * HAP characteristic. Delegates to the shared display-direction
 * helpers so imperial display targets are byte-identical to v1.6.0.
 */
export function toDisplayUnit(measurement: Measurement, canonical: number, displayUnit: SensorUnit): number {
  switch (measurement) {
    case 'temperature':
      // Celsius → Fahrenheit (the only non-identity display case).
      return displayUnit === 'fahrenheit' ? canonical * 9 / 5 + 32 : canonical;
    case 'illuminance':
      return displayUnit === 'wm2' ? canonical * WM2_PER_LUX : canonical;
    case 'wind-speed':
      return convertSpeed(canonical, displayUnit as Parameters<typeof convertSpeed>[1]);
    case 'rain-rate':
      return displayUnit === 'mm_per_hr' ? canonical * IN_PER_MM : canonical;
    case 'rain-accumulation':
      return convertRain(canonical, displayUnit as Parameters<typeof convertRain>[1]);
    case 'pressure':
      return convertPressure(canonical, displayUnit as Parameters<typeof convertPressure>[1]);
    case 'distance':
      return convertDistance(canonical, displayUnit as Parameters<typeof convertDistance>[1]);
    default:
      return canonical;
  }
}

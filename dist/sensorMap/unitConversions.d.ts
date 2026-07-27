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
/**
 * The canonical unit each measurement is compared / bucketed in.
 * `boolean` has no unit (rows forbid one); it maps to `'count'` as an
 * inert placeholder never consulted — `toCanonical`/`toDisplayUnit`
 * short-circuit boolean and timestamp before reading this table.
 */
export declare const CANONICAL_UNIT_FOR_MEASUREMENT: Record<Measurement, SensorUnit>;
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
export declare function toCanonical(measurement: Measurement, sourceUnit: SensorUnit, value: number): number;
/**
 * Convert a canonical value to a presentation `displayUnit`. The ONLY
 * consumer is the extended wrappers' custom-string characteristic
 * (the label users see in Eve / Home / Controller). Native HAP
 * wrappers never call this — they write canonical into a fixed-unit
 * HAP characteristic. Delegates to the shared display-direction
 * helpers so imperial display targets are byte-identical to v1.6.0.
 */
export declare function toDisplayUnit(measurement: Measurement, canonical: number, displayUnit: SensorUnit): number;
//# sourceMappingURL=unitConversions.d.ts.map
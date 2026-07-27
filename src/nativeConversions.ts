/**
 * Pure conversion + bucketing functions extracted from the native
 * accessory wrappers so both the wrapper class (normal-mode poll
 * path) and `safeModeBinding.ts` (safe-mode poll path) use
 * identical arithmetic. Parity is enforced by tests in
 * `tests/unit/nativeConversions.test.ts`.
 *
 * All functions are pure — no HAP references, no platform, no
 * logger. Callers convert `AWN raw value → canonical HAP value`
 * and then push the result into their own characteristic via
 * whatever mechanism they use (wrappers via `updateCharacteristic`,
 * safe-mode bindings via a retained `Characteristic` instance's
 * `updateValue`).
 */

// ---- Temperature (F → C) ------------------------------------------

/** AWN reports Fahrenheit; HAP `CurrentTemperature` expects Celsius. */
export function fahrenheitToCelsius(fahrenheit: number): number {
  return (fahrenheit - 32) * 5 / 9;
}

// ---- Solar Radiation (W/m² → lux) ---------------------------------

/**
 * AWN reports solar irradiance in W/m²; HAP `CurrentAmbientLightLevel`
 * takes lux. The 1 / 0.0079 factor matches the wrapper class's math
 * verbatim — approximately 126.6 lux per W/m². `Math.round` matches
 * the wrapper's rounding to integer lux.
 */
export function solarWm2ToLux(wm2: number): number {
  return Math.round(wm2 / 0.0079);
}

// ---- CO2 (ppm, rounded + threshold-detected) ----------------------

/** Threshold above which HAP `CarbonDioxideDetected` flips to abnormal. */
export const CO2_DETECTED_PPM = 1000;

/**
 * AWN raw CO2 value → HAP-ready {ppm, detected} pair, matching
 * `Co2Accessory`'s setValue exactly. Rounding happens BEFORE the
 * threshold compare — 999.6 → 1000 → abnormal.
 */
export function co2Reading(rawValue: number): { ppm: number; detected: boolean } {
  const ppm = Math.max(0, Math.round(rawValue));
  return { ppm, detected: ppm >= CO2_DETECTED_PPM };
}

// ---- Air Quality (PM2.5 / PM10 density + bucket) ------------------

/**
 * EPA AQI breakpoints for PM2.5 (24-hour averaged μg/m³), matching
 * AirQualityAccessory's PM25_BUCKETS_UG_M3 verbatim.
 */
const PM25_BUCKETS_UG_M3: ReadonlyArray<{ max: number; level: number }> = [
  { max: 12.0, level: 1 },
  { max: 35.4, level: 2 },
  { max: 55.4, level: 3 },
  { max: 150.4, level: 4 },
  { max: Infinity, level: 5 },
];

const PM10_BUCKETS_UG_M3: ReadonlyArray<{ max: number; level: number }> = [
  { max: 54, level: 1 },
  { max: 154, level: 2 },
  { max: 254, level: 3 },
  { max: 354, level: 4 },
  { max: Infinity, level: 5 },
];

/** Which HAP AirQuality level (1..5) for a given particulate density. */
export function airQualityLevel(density: number, variant: 'PM2.5' | 'PM10'): number {
  const table = variant === 'PM10' ? PM10_BUCKETS_UG_M3 : PM25_BUCKETS_UG_M3;
  for (const row of table) {
    if (density <= row.max) {
      return row.level;
    }
  }
  return 5;
}

/**
 * AWN raw PM density → HAP-ready {density, level} pair.
 *
 * IMPORTANT — matches AirQualityAccessory's ORIGINAL behavior
 * exactly: the displayed `density` is rounded to 1 decimal place,
 * but the AirQuality `level` is bucketed from the CLAMPED, UNROUNDED
 * value. Bucketing the rounded value would flip levels for readings
 * just above a boundary (e.g. PM2.5 12.04 → rounds to 12.0 → level 1,
 * but the unrounded 12.04 is above the 12.0 breakpoint → level 2).
 * Callers should pass the raw (or clamped-raw) value; this function
 * does the clamp + both derivations internally.
 */
export function airQualityReading(
  rawValue: number,
  variant: 'PM2.5' | 'PM10',
): { density: number; level: number } {
  const clamped = Math.max(0, rawValue);
  const density = Math.round(clamped * 10) / 10;
  const level = airQualityLevel(clamped, variant);   // UNROUNDED — do not use `density` here.
  return { density, level };
}

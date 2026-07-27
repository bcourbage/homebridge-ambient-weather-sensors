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
/** AWN reports Fahrenheit; HAP `CurrentTemperature` expects Celsius. */
export declare function fahrenheitToCelsius(fahrenheit: number): number;
/**
 * AWN reports solar irradiance in W/m²; HAP `CurrentAmbientLightLevel`
 * takes lux. The 1 / 0.0079 factor matches the wrapper class's math
 * verbatim — approximately 126.6 lux per W/m². `Math.round` matches
 * the wrapper's rounding to integer lux.
 */
export declare function solarWm2ToLux(wm2: number): number;
/** Threshold above which HAP `CarbonDioxideDetected` flips to abnormal. */
export declare const CO2_DETECTED_PPM = 1000;
/**
 * AWN raw CO2 value → HAP-ready {ppm, detected} pair, matching
 * `Co2Accessory`'s setValue exactly. Rounding happens BEFORE the
 * threshold compare — 999.6 → 1000 → abnormal.
 */
export declare function co2Reading(rawValue: number): {
    ppm: number;
    detected: boolean;
};
/** Which HAP AirQuality level (1..5) for a given particulate density. */
export declare function airQualityLevel(density: number, variant: 'PM2.5' | 'PM10'): number;
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
export declare function airQualityReading(rawValue: number, variant: 'PM2.5' | 'PM10'): {
    density: number;
    level: number;
};
//# sourceMappingURL=nativeConversions.d.ts.map
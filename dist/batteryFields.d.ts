/**
 * Map a sensor key from AWN's `lastData` to the name of the `batt*`
 * field that reports the battery state of that sensor's physical
 * probe. Used by the platform layer to bundle battery state with
 * each sensor's value update, so wrappers can expose a HomeKit
 * `Battery` sub-service with a meaningful `StatusLowBattery` boolean.
 *
 * Why per-sensor and not per-station? AWN stations are modular —
 * the outdoor base, the indoor display, the AQIN module, the WH31L
 * lightning sensor, and each WH31 channel probe all have separate
 * batteries. A single station can have 7+ independently-batteried
 * components.
 *
 * IMPORTANT: in HomeKit only ONE Battery sub-service per probe is
 * exposed, attached to a designated "canonical" sensor accessory
 * (see CANONICAL_SENSOR_FOR_BATTERY below). Without this dedup, a
 * fully-populated WS-2000 produces 30+ battery tiles in Apple Home
 * (one per accessory the probe powers) — overwhelming and
 * redundant. With dedup, each physical probe shows ONE battery
 * status, attached to its most representative sensor (outdoor
 * temp, indoor temp, channel temp, CO2 for AQIN, lightning_day
 * for the WH31L).
 *
 * AWN's batt* field convention:
 *   battout         — outdoor combo array (wind, rain, solar, UV,
 *                     outdoor temp/humidity, feels-like, dew point)
 *   battin          — indoor display console (indoor temp/humidity,
 *                     feels-like-in, dew-point-in, both pressure fields)
 *   batt{1..N}      — WH31 numbered probe channels 1..N (per-probe
 *                     temperature and humidity)
 *   batt_co2        — AQIN indoor air quality module (PM2.5, PM10,
 *                     CO2, AQIN's internal temp/humid housing
 *                     sensors). Despite the name, this powers the
 *                     whole AQIN module, not just CO2.
 *   batt_lightning  — WH31L lightning sensor (strike count, distance,
 *                     timestamp). AWN catalogs this sensor as the
 *                     WH31L; Ecowitt catalogs the same hardware as
 *                     the WH57.
 *
 * Returns the batt-field name as a string, or undefined when the
 * sensor key doesn't correspond to a known physical probe. Callers
 * should treat undefined as "no battery for this sensor" and skip
 * the Battery sub-service entirely.
 */
/**
 * Whether this sensor key is the canonical one for displaying the
 * HomeKit Battery sub-service for the given battery field. Used by
 * the platform layer to suppress redundant battery sub-services on
 * non-canonical accessories sharing the same physical probe.
 */
export declare function isCanonicalSensorForBattery(sensorKey: string, batteryField: string): boolean;
export declare function batteryFieldForSensor(sensorKey: string): string | undefined;
/**
 * Helper: read a battery field's raw value from a lastData object
 * and return the HomeKit-aligned "low" boolean.
 *
 * AWN convention: 0 = low / 1 = good. HomeKit convention: true = low
 * / false = normal. This function inverts AWN's polarity so callers
 * downstream can pass the boolean straight into the
 * `StatusLowBattery` characteristic without further thought.
 *
 * Returns undefined when the battery field is missing or non-numeric
 * — the wrapper should not add a Battery sub-service in that case.
 */
export declare function readBatteryLow(lastData: Record<string, unknown>, batteryField: string | undefined): boolean | undefined;
//# sourceMappingURL=batteryFields.d.ts.map
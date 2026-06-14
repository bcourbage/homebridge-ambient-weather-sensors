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
const FIXED_MAPPINGS = {
    // Indoor display console — temp, humidity, calculated values, pressure
    tempinf: 'battin',
    humidityin: 'battin',
    feelsLikein: 'battin',
    dewPointin: 'battin',
    baromrelin: 'battin',
    baromabsin: 'battin',
    // Outdoor combo array — direct readings + AWN-calculated values
    tempf: 'battout',
    humidity: 'battout',
    feelsLike: 'battout',
    dewPoint: 'battout',
    solarradiation: 'battout',
    uv: 'battout',
    windspeedmph: 'battout',
    windgustmph: 'battout',
    maxdailygust: 'battout',
    winddir: 'battout',
    winddir_avg10m: 'battout',
    hourlyrainin: 'battout',
    eventrainin: 'battout',
    dailyrainin: 'battout',
    weeklyrainin: 'battout',
    monthlyrainin: 'battout',
    yearlyrainin: 'battout',
    lastRain: 'battout',
    // WH31L lightning sensor (Ecowitt WH57 equivalent hardware)
    lightning_day: 'batt_lightning',
    lightning_hour: 'batt_lightning',
    lightning_distance: 'batt_lightning',
    lightning_time: 'batt_lightning',
};
/**
 * The canonical sensor (per battery field) chosen to host the
 * HomeKit Battery sub-service. Other sensors sharing the same
 * physical probe do NOT get a Battery sub-service — they would
 * just duplicate the same low/normal signal and clutter Apple
 * Home with redundant tiles.
 *
 * Choice of canonical sensor per field:
 *   battout         → `tempf` (Outdoor Temperature) — the most
 *                     universally-enabled outdoor sensor; users
 *                     who enable wind/rain/solar without
 *                     Temperature are very rare
 *   battin          → `tempinf` (Indoor Temperature) — same
 *                     reasoning as battout
 *   batt{1..10}     → `temp{N}f` — each channel probe's
 *                     temperature is its primary reading
 *   batt_co2        → `co2_in_aqin` — the AQIN's most
 *                     distinctive reading
 *   batt_lightning  → `lightning_day` — has no per-threshold
 *                     enable checkbox in the form (unlike
 *                     lightning_distance), so it's harder to
 *                     accidentally hide
 *
 * If the canonical sensor isn't enabled (user excluded it, or
 * its category is off, or its per-threshold enable checkbox is
 * unchecked for the extended sensors), the corresponding battery
 * status is not visible in HomeKit. Workaround: enable the
 * canonical sensor, or rely on AWN's dashboard for that
 * battery's status.
 */
const CANONICAL_SENSOR_FOR_BATTERY = {
    battout: 'tempf',
    battin: 'tempinf',
    batt1: 'temp1f',
    batt2: 'temp2f',
    batt3: 'temp3f',
    batt4: 'temp4f',
    batt5: 'temp5f',
    batt6: 'temp6f',
    batt7: 'temp7f',
    batt8: 'temp8f',
    batt9: 'temp9f',
    batt10: 'temp10f',
    batt_co2: 'co2_in_aqin',
    batt_lightning: 'lightning_day',
};
/**
 * Whether this sensor key is the canonical one for displaying the
 * HomeKit Battery sub-service for the given battery field. Used by
 * the platform layer to suppress redundant battery sub-services on
 * non-canonical accessories sharing the same physical probe.
 */
export function isCanonicalSensorForBattery(sensorKey, batteryField) {
    return CANONICAL_SENSOR_FOR_BATTERY[batteryField] === sensorKey;
}
// Numbered WH31 probes — `temp1f`, `humidity2`, `feelsLike3`,
// `dewPoint4`, etc. all roll up to `batt{N}` for their channel number.
const NUMBERED_PROBE_REGEX = /^(?:temp|humidity|feelsLike|dewPoint)(\d+)f?$/;
export function batteryFieldForSensor(sensorKey) {
    if (FIXED_MAPPINGS[sensorKey]) {
        return FIXED_MAPPINGS[sensorKey];
    }
    const m = sensorKey.match(NUMBERED_PROBE_REGEX);
    if (m) {
        return `batt${m[1]}`;
    }
    // AQIN module — any field ending in `_aqin` (pm25_in_aqin,
    // co2_in_aqin, pm_in_temp_aqin, etc.) is powered by the AQIN's
    // single battery, reported by AWN as `batt_co2`.
    if (sensorKey.endsWith('_aqin')) {
        return 'batt_co2';
    }
    // Standalone CO2 sensor (not via AQIN) — AWN's documentation
    // suggests this also uses batt_co2 since it's the same family of
    // hardware. If a future station ever ships with a separate
    // standalone CO2 sensor reporting a different battery field, we'll
    // revisit.
    if (sensorKey === 'co2') {
        return 'batt_co2';
    }
    // Outdoor PM2.5 (WH41) reports its own battery, but the field
    // name varies across AWN station firmwares and we don't have a
    // representative payload to confirm against. Skip the Battery
    // sub-service for these until we get sample data — better than
    // showing "battery normal" when we don't actually know.
    if (/^pm25(_24h)?$/.test(sensorKey)) {
        return undefined;
    }
    return undefined;
}
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
export function readBatteryLow(lastData, batteryField) {
    if (!batteryField) {
        return undefined;
    }
    const raw = lastData[batteryField];
    if (typeof raw !== 'number') {
        return undefined;
    }
    return raw === 0;
}
//# sourceMappingURL=batteryFields.js.map
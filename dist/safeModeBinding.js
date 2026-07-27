/**
 * Safe-mode value binding — no wrapper construction, no HAP graph changes.
 *
 * Sensor-map.md §17.2 says polling / realtime updates continue to
 * push values to identifiable cached wrappers in safe mode, but the
 * plugin MUST NOT reconcile the HAP graph. The v1.6.0 wrapper
 * constructors don't fit that constraint — `setupBatteryService()`
 * removes any existing BatteryService if `context.device.batteryLow`
 * is undefined, and every wrapper's ctor calls `addService()` if the
 * primary service isn't present. Either behavior is a structural
 * change safe mode forbids.
 *
 * `bindSafeMode(accessory)` binds ONLY to services and characteristics
 * that ALREADY EXIST on the cached accessory. It uses `getService()`
 * for the service check and `testCharacteristic()` + `getCharacteristic()`
 * for each characteristic — retaining the `Characteristic` instance
 * so subsequent updates go through `.updateValue()` directly. HAP's
 * `updateCharacteristic()` would attach a missing characteristic
 * on demand, which is a graph mutation safe mode forbids. Any
 * missing service or missing characteristic → return undefined and
 * skip the accessory (its cached HAP values stay in place).
 *
 * We further restrict binding to KNOWN default-map dataPoints:
 * `bindSafeMode(accessory)` extracts the dataPoint from the
 * accessory's uniqueId (`${mac}-${dataPoint}`) and rejects anything
 * not in `DEFAULT_SENSOR_MAP`. That's the "no unknown config
 * interpretation" guarantee — a cached custom sensor (whose
 * sourceUnit and semantic depend on config we can't trust) never
 * receives a value update in safe mode. Its cached HAP value
 * persists via Homebridge's normal accessory restore.
 *
 * Native types supported today: Temperature, Humidity, Solar
 * Radiation, CO2, PM2.5 / PM10. Extended-sensor accessories (Wind,
 * Rain, Pressure, UV, Lightning) fall through — same reason (their
 * live-value semantics depend on config-driven thresholds and
 * display modes we can't interpret in safe mode).
 */
import { CO2_DETECTED_PPM, airQualityReading, co2Reading, fahrenheitToCelsius, solarWm2ToLux, } from './nativeConversions.js';
import { defaultRowFor } from './sensorMap/defaultMap.js';
/**
 * Extract the sensor `dataPoint` from a uniqueId of the form
 * `${macAddress}-${dataPoint}`. Anchored on the first hyphen after
 * a valid-looking MAC prefix so sensorKeys that themselves contain
 * hyphens survive (`co2_in_aqin`, `pm25_in_24h_aqin`, etc.).
 * Returns undefined for malformed ids.
 */
function extractDataPoint(uniqueId) {
    // MAC form is `HH:HH:HH:HH:HH:HH` (17 chars). uniqueId is
    // `${mac}-${dataPoint}`, so the dataPoint starts at index 18.
    if (uniqueId.length <= 18 || uniqueId[17] !== '-') {
        return undefined;
    }
    return uniqueId.slice(18);
}
/**
 * Attach a battery-low updater IF the accessory already has both a
 * BatteryService AND a StatusLowBattery characteristic attached to
 * it. Never creates either — safe mode forbids graph mutation.
 */
function bindBatteryChar(platform, accessory) {
    const svcCtor = platform.Service.Battery;
    const existing = accessory.getService(svcCtor);
    if (!existing) {
        return () => { };
    }
    // HAP-NodeJS types testCharacteristic + getCharacteristic against
    // the class-form ctor, but the actual runtime accepts either the
    // ctor or its UUID. We cast broadly here to avoid wrestling with
    // the type gymnastics — both mock and real HAP accept it.
    const charCtor = platform.Characteristic.StatusLowBattery;
    if (!existing.testCharacteristic(charCtor)) {
        return () => { };
    }
    const characteristic = existing.getCharacteristic(charCtor);
    return (low) => {
        characteristic.updateValue(low ? 1 : 0);
    };
}
/**
 * Look up an existing service on the accessory (never adds one).
 * Returns undefined if absent.
 */
function requireService(accessory, ctor) {
    return accessory.getService(ctor);
}
/**
 * Look up an existing characteristic on the given service (never
 * attaches one). Returns undefined if absent; safe mode skips
 * updates to the missing characteristic silently.
 */
function requireCharacteristic(svc, ctor) {
    // Same rationale as bindBatteryChar's cast: HAP accepts ctor form
    // at runtime; the strict TS type wants a specific ctor.
    const c = ctor;
    if (!svc.testCharacteristic(c)) {
        return undefined;
    }
    return svc.getCharacteristic(c);
}
/**
 * Build a safe-mode binding for a cached accessory. Returns
 * undefined when:
 *   - the accessory's uniqueId doesn't parse, OR
 *   - the dataPoint isn't in `DEFAULT_SENSOR_MAP`, OR
 *   - the cached `context.device.type` isn't one of the five
 *     supported native types, OR
 *   - the expected primary service or its value characteristic(s)
 *     aren't already attached to the accessory.
 *
 * Caller (`platform.safeModeStart`) skips unmatched accessories,
 * leaving them at their cached HAP values.
 */
export function bindSafeMode(platform, accessory) {
    const uniqueId = accessory.context?.device?.uniqueId;
    if (typeof uniqueId !== 'string' || uniqueId.length === 0) {
        return undefined;
    }
    const dataPoint = extractDataPoint(uniqueId);
    if (!dataPoint || !defaultRowFor(dataPoint)) {
        // Custom / unknown dataPoint — we can't safely infer the
        // source unit, so no value updates. Cached HAP value stays.
        return undefined;
    }
    const type = accessory.context?.device?.type;
    if (typeof type !== 'string') {
        return undefined;
    }
    const P = platform.Characteristic;
    const S = platform.Service;
    switch (type) {
        case 'Temperature': {
            const svc = requireService(accessory, S.TemperatureSensor);
            if (!svc) {
                return undefined;
            }
            const currentTemp = requireCharacteristic(svc, P.CurrentTemperature);
            if (!currentTemp) {
                return undefined;
            }
            const setBatteryLow = bindBatteryChar(platform, accessory);
            return {
                setValue: (raw) => {
                    const celsius = fahrenheitToCelsius(raw);
                    currentTemp.updateValue(celsius);
                    platform.log.debug(`safe-mode: CurrentTemperature ${raw}°F → ${celsius.toFixed(2)}°C`);
                },
                setBatteryLow,
            };
        }
        case 'Humidity': {
            const svc = requireService(accessory, S.HumiditySensor);
            if (!svc) {
                return undefined;
            }
            const humidityChar = requireCharacteristic(svc, P.CurrentRelativeHumidity);
            if (!humidityChar) {
                return undefined;
            }
            const setBatteryLow = bindBatteryChar(platform, accessory);
            return {
                setValue: (raw) => {
                    humidityChar.updateValue(raw);
                    platform.log.debug(`safe-mode: CurrentRelativeHumidity ${raw}%`);
                },
                setBatteryLow,
            };
        }
        case 'Solar Radiation': {
            const svc = requireService(accessory, S.LightSensor);
            if (!svc) {
                return undefined;
            }
            const luxChar = requireCharacteristic(svc, P.CurrentAmbientLightLevel);
            if (!luxChar) {
                return undefined;
            }
            const setBatteryLow = bindBatteryChar(platform, accessory);
            return {
                setValue: (raw) => {
                    // No lower clamp — the SolarRadiationAccessory wrapper sets
                    // the CurrentAmbientLightLevel characteristic's minValue to
                    // 0 ("dark at night") and pushes lux straight through.
                    // A safe-mode-only clamp to 0.0001 would diverge from that.
                    const lux = solarWm2ToLux(raw);
                    luxChar.updateValue(lux);
                    platform.log.debug(`safe-mode: CurrentAmbientLightLevel ${raw} W/m² → ${lux} lx`);
                },
                setBatteryLow,
            };
        }
        case 'CO2': {
            const svc = requireService(accessory, S.CarbonDioxideSensor);
            if (!svc) {
                return undefined;
            }
            const co2Level = requireCharacteristic(svc, P.CarbonDioxideLevel);
            const co2Detected = requireCharacteristic(svc, P.CarbonDioxideDetected);
            if (!co2Level || !co2Detected) {
                return undefined;
            }
            const setBatteryLow = bindBatteryChar(platform, accessory);
            return {
                setValue: (raw) => {
                    const { ppm, detected } = co2Reading(raw);
                    co2Level.updateValue(ppm);
                    co2Detected.updateValue(detected ? 1 : 0);
                    platform.log.debug(`safe-mode: CarbonDioxideLevel ${ppm} ppm (${detected ? 'abnormal' : 'normal'}; threshold ${CO2_DETECTED_PPM})`);
                },
                setBatteryLow,
            };
        }
        case 'PM2.5':
        case 'PM10': {
            const svc = requireService(accessory, S.AirQualitySensor);
            if (!svc) {
                return undefined;
            }
            const kind = type;
            const densityCtor = kind === 'PM10' ? P.PM10Density : P.PM2_5Density;
            const densityChar = requireCharacteristic(svc, densityCtor);
            const aqChar = requireCharacteristic(svc, P.AirQuality);
            if (!densityChar || !aqChar) {
                return undefined;
            }
            const setBatteryLow = bindBatteryChar(platform, accessory);
            return {
                setValue: (raw) => {
                    const value = Math.max(0, raw);
                    const { density, level } = airQualityReading(value, kind);
                    densityChar.updateValue(density);
                    aqChar.updateValue(level);
                    platform.log.debug(`safe-mode: ${kind}Density ${density} µg/m³ → AirQuality level ${level}`);
                },
                setBatteryLow,
            };
        }
        default:
            // Extended-sensor types + unrecognized cached types: cached
            // HAP values remain, no updates pushed.
            return undefined;
    }
}
//# sourceMappingURL=safeModeBinding.js.map
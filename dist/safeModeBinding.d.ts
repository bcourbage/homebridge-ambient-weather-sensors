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
import type { PlatformAccessory } from 'homebridge';
/**
 * Minimal platform surface `bindSafeMode` needs — matches the real
 * `AmbientWeatherSensorsPlatform` shape. Homebridge's `Service` and
 * `Characteristic` are both extendable classes AND namespaces with
 * static named members; the interface is intentionally loose so both
 * the real platform and the test mocks fit without wrestling with
 * tight index signatures.
 */
export type SafeModeBindingPlatform = {
    Service: any;
    Characteristic: any;
    log: {
        debug(msg: string): void;
    };
};
export interface SafeModeBinding {
    /** Push a raw AWN value into the accessory's HAP characteristic(s). */
    setValue(rawValue: number): void;
    /**
     * Push a battery-low reading, iff the accessory already has an
     * attached BatteryService whose `StatusLowBattery` characteristic
     * is present. When absent, this is a no-op — safe mode never
     * creates a BatteryService or attaches a missing characteristic.
     */
    setBatteryLow(low: boolean): void;
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
export declare function bindSafeMode(platform: SafeModeBindingPlatform, accessory: PlatformAccessory): SafeModeBinding | undefined;
//# sourceMappingURL=safeModeBinding.d.ts.map
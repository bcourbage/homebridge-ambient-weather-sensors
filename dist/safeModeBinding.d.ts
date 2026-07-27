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
 * The alternative is this module: given a cached PlatformAccessory,
 * `bindSafeMode(accessory)` looks at the services THAT ALREADY EXIST
 * on the accessory, resolves the appropriate HAP characteristic
 * bindings, and returns a small object that pushes values via
 * `updateCharacteristic` — never `addService` / `removeService`.
 * Accessories whose expected primary service is absent get skipped
 * (they keep their cached HAP values; polling simply doesn't touch
 * them).
 *
 * The mapping table matches what `platform.createSensorWrapper()`
 * does for each `context.device.type`, but without the mutation.
 * Only the FIVE native HomeKit sensor types are supported today
 * (Temperature, Humidity, Solar Radiation, CO2, PM2.5 / PM10);
 * extended-sensor accessories (Wind, Rain, Pressure, UV, Lightning)
 * skip value updates in safe mode and stay at their cached values.
 * That's an intentional Group 4 scope reduction: extended sensors
 * store their live values in custom characteristics whose semantics
 * (thresholds, intensity buckets, embed-mode name updates) depend
 * on config we can't safely interpret in safe mode. Native sensors
 * have a fixed HAP unit and a single characteristic, so binding is
 * unambiguous.
 */
import type { PlatformAccessory } from 'homebridge';
/**
 * Minimal platform surface `bindSafeMode` needs — matches the real
 * `AmbientWeatherSensorsPlatform` shape. Homebridge's `Service` and
 * `Characteristic` are both extendable classes AND namespaces with
 * static named members (`Service.TemperatureSensor`,
 * `Characteristic.CurrentTemperature`, etc.); the interface is
 * intentionally loose so both the real platform and the test mocks
 * fit without wrestling with tight index signatures.
 */
export type SafeModeBindingPlatform = {
    Service: any;
    Characteristic: any;
    log: {
        debug(msg: string): void;
    };
};
export interface SafeModeBinding {
    /** Push a raw AWN value into the accessory's HAP characteristic. */
    setValue(rawValue: number): void;
    /**
     * Push a battery-low reading, iff the accessory already has an
     * attached BatteryService. When absent, this is a no-op — safe
     * mode never creates a BatteryService.
     */
    setBatteryLow(low: boolean): void;
}
/**
 * Build a safe-mode binding for a cached accessory. Returns
 * undefined when the accessory's cached `context.device.type` isn't
 * a supported native type OR the expected primary service isn't
 * already attached. The caller (`platform.safeModeStart`) skips
 * unmatched accessories, leaving them at their cached HAP values.
 */
export declare function bindSafeMode(platform: SafeModeBindingPlatform, accessory: PlatformAccessory): SafeModeBinding | undefined;
//# sourceMappingURL=safeModeBinding.d.ts.map
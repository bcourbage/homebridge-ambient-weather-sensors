import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import type { NumericSensorRow } from './sensorMap/types.js';
export declare class HumidityAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row?: NumericSensorRow);
    setBatteryLow(batteryLow: boolean): void;
    /**
     * Push a fresh raw AWN humidity reading (0-100 %) into the HomeKit
     * characteristic. Called by the platform's poll tick.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=humidityAccessory.d.ts.map
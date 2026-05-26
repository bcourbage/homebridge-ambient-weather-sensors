import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
export declare class SolarRadiationAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    /**
     * Push a fresh raw AWN solar-radiation reading (W/m²) into the HomeKit
     * LightSensor characteristic after converting to lux. Called by the
     * platform's poll tick.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=solarRadiationAccessory.d.ts.map
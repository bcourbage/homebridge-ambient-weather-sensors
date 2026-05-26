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
     *
     * AWN reports solar radiation in W/m²; HomeKit's LightSensor accepts
     * lux. The standard conversion factor of 1 W/m² ≈ 127 lux assumes
     * sunlight's spectral distribution (the AWN sensor's design point).
     * Documented in the README so users can do the reverse math from the
     * HomeKit reading if they want W/m² back.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=solarRadiationAccessory.d.ts.map
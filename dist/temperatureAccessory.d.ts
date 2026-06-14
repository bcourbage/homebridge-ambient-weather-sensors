import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
export declare class TemperatureAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    setBatteryLow(batteryLow: boolean): void;
    private fahrenheitToCelsius;
    /**
     * Push a fresh raw AWN reading (in °F) into the HomeKit characteristic
     * after converting to °C. Called by the platform's poll tick — wrappers
     * no longer poll on their own.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=temperatureAccessory.d.ts.map
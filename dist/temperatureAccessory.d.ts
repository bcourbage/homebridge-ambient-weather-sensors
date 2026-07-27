import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import type { NumericSensorRow } from './sensorMap/types.js';
export declare class TemperatureAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly row?;
    private service;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row?: NumericSensorRow | undefined);
    setBatteryLow(batteryLow: boolean): void;
    /**
     * Push a fresh raw AWN reading into the HomeKit characteristic after
     * converting to °C (HAP's `CurrentTemperature` unit). Row-driven: the
     * conversion goes through `toCanonical`, which is `fahrenheitToCelsius`
     * for the AWN-native `sourceUnit: 'fahrenheit'` and a no-op for a
     * custom sensor already reporting Celsius. The legacy path keeps the
     * hardcoded F→C. Called by the platform's poll tick.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=temperatureAccessory.d.ts.map
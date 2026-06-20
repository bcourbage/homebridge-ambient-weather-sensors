import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
export declare class AirQualityAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    private readonly variant;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    setBatteryLow(batteryLow: boolean): void;
    /**
     * AWN reports particulate density in μg/m³ directly. HomeKit's
     * PM2_5Density and PM10Density characteristics take the same units,
     * so no conversion. We also derive an AirQuality enum from EPA-bucket
     * boundaries so the Home app's color-coded indicator and any
     * "air quality" based automation triggers fire sensibly.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=airQualityAccessory.d.ts.map
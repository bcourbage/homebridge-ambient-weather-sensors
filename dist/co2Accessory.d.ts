import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
export declare class Co2Accessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    setBatteryLow(batteryLow: boolean): void;
    /**
     * AWN reports CO2 in ppm directly. HomeKit's CarbonDioxideLevel is
     * also ppm, so no conversion. We also flip CarbonDioxideDetected
     * (NORMAL/ABNORMAL boolean characteristic) based on the
     * CO2_DETECTED_PPM threshold so HomeKit automations can react to
     * elevated levels.
     */
    setValue(rawValue: number): void;
}
//# sourceMappingURL=co2Accessory.d.ts.map
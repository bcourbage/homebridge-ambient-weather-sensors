import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import type { NumericSensorRow } from './sensorMap/types.js';
/**
 * The fixed HAP alert-state boundary for CarbonMonoxideDetected
 * (sensor-map.md §19.3): 400 ppm is the floor of UL 2034's SHORTEST
 * alarm window — the concentration at which every UL 2034 window
 * alarms. Like Co2Accessory's 1000 ppm, this is a documented HAP
 * alert-state semantic, deliberately NOT user-configurable
 * (`row.threshold` stays motion-only per §3.7).
 */
export declare const CO_DETECTED_PPM = 400;
/**
 * Carbon monoxide accessory (§19.3). No AWN field reports CO; this
 * wrapper exists for explicit custom assignments (kind `co`,
 * measurement `co`, ppm). The level is always written; the detected
 * alert flips at the fixed boundary above.
 */
export declare class CoAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private service;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
    setBatteryLow(batteryLow: boolean): void;
    setValue(rawValue: number): void;
}
//# sourceMappingURL=coAccessory.d.ts.map
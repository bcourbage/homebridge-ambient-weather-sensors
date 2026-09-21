import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import type { NumericSensorRow } from '../sensorMap/types.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
export declare class GenericValueAccessory extends ExtendedSensorBase {
    private readonly displayUnit;
    private readonly rowMeasurement;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow, fallbackLabel: string);
    protected formatValue(canonical: number): string;
}
export declare class SoilMoistureAccessory extends GenericValueAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
}
export declare class LeafWetnessAccessory extends GenericValueAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
}
export declare class SoilTensionAccessory extends GenericValueAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
}
export declare class EvapotranspirationAccessory extends GenericValueAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
}
export declare class AqiAccessory extends GenericValueAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
}
//# sourceMappingURL=genericValueAccessory.d.ts.map
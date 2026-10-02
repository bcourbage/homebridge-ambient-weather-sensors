import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import type { NumericSensorRow } from '../sensorMap/types.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
export declare class GenericValueAccessory extends ExtendedSensorBase {
    private readonly displayUnit;
    private readonly rowMeasurement;
    /** Resolved literal label for the generic `numeric` measurement (§19.9). */
    private readonly unitLabel;
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
/**
 * Generic numeric passthrough (§19.9, catalog 4). An honest finite
 * reading with a user-supplied literal label and an optional threshold.
 * No `formatIntensity` override, so no Intensity characteristic and no
 * invented qualitative classification.
 */
export declare class NumericAccessory extends GenericValueAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: NumericSensorRow);
}
//# sourceMappingURL=genericValueAccessory.d.ts.map
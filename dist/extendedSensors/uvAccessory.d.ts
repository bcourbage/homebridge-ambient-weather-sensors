import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
/**
 * UV index accessory. AWN's `uv` field is the integer UV index
 * (0-11+), standard EPA scale. Threshold default of 3 corresponds
 * to the "Moderate" bucket — the level where the EPA recommends sun
 * protection — and is a sensible "should I close the window
 * shades" automation trigger.
 *
 * The UV index is unitless, so no per-unit selection is offered;
 * we display the raw integer plus the EPA bucket label.
 */
export declare class UvAccessory extends ExtendedSensorBase {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    protected formatValue(rawUv: number): string;
    protected formatIntensity(rawUv: number): string | undefined;
}
//# sourceMappingURL=uvAccessory.d.ts.map
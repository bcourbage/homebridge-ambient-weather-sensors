import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
/**
 * Barometric pressure accessory. AWN reports two values:
 *   - `baromrelin` — relative pressure (corrected to sea level)
 *   - `baromabsin` — absolute pressure (raw, at station altitude)
 *
 * For users at low elevations the two are nearly identical; at
 * altitude they diverge significantly (Denver's absolute is ~25 inHg
 * while sea-level-corrected relative is ~30 inHg). We expose both
 * as independent accessories and let the user enable whichever they
 * find meaningful — most users want relative since that's what
 * weather forecasts and almanacs use.
 *
 * Threshold default (29.5 inHg ≈ 999 hPa) triggers MotionDetected
 * when pressure drops below — this is the conventional "low pressure
 * system incoming" threshold. Above ~30.5 inHg is "high pressure"
 * (fair weather), below ~29.5 is "low pressure" (storms likely).
 *
 * Intensity bucket / pressure trend is deferred to v1.5.x — it
 * requires a small ring buffer of recent readings to detect
 * Rising / Falling / Steady, which is more state than the current
 * base class carries.
 */
declare abstract class PressureLikeAccessory extends ExtendedSensorBase {
    private readonly pressureUnit;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, sensorLabel: string, awnKey: string);
    protected formatValue(rawInHg: number): string;
}
export declare class PressureRelativeAccessory extends PressureLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
export declare class PressureAbsoluteAccessory extends PressureLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
export {};
//# sourceMappingURL=pressureAccessory.d.ts.map
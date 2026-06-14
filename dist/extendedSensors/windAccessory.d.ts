import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
/**
 * Wind speed/gust accessories share their entire body — only the
 * sensor label, AWN key, and default threshold differ — so we use a
 * single base for them and let the three exported subclasses
 * configure those three things.
 *
 * Wind direction is structurally different (no threshold, no
 * intensity bucket, special formatter) and lives in its own base
 * below.
 */
declare abstract class WindSpeedLikeAccessory extends ExtendedSensorBase {
    private readonly speedUnit;
    private readonly unitLabel;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, sensorLabel: string, awnKey: string, thresholdMph: number);
    protected formatValue(rawMph: number): string;
    protected formatIntensity(rawMph: number): string | undefined;
}
/**
 * AWN: `windspeedmph` — the current instantaneous wind speed. Default
 * threshold (25 mph) corresponds to Beaufort 6 ("Strong breeze") —
 * the level at which loose objects start to blow around, a common
 * automation trigger ("close the awning when it gets gusty").
 */
export declare class WindSpeedAccessory extends WindSpeedLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
/**
 * AWN: `windgustmph` — the highest instantaneous reading in the last
 * polling interval. Default threshold (35 mph) is higher than the
 * sustained-speed threshold because gusts are momentary and need a
 * larger value to be alarming. Beaufort 7 territory.
 */
export declare class WindGustAccessory extends WindSpeedLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
/**
 * AWN: `maxdailygust` — the maximum gust speed recorded today (resets
 * at local midnight per AWN's tz). Default threshold matches
 * WindGust since it's a different time-aggregation of the same
 * fundamental measurement.
 */
export declare class WindMaxDailyGustAccessory extends WindSpeedLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
/**
 * Wind direction is informational. The Value characteristic carries
 * both degrees and a 16-point cardinal — useful for at-a-glance
 * reading in Eve — but there's no threshold and no Intensity bucket
 * (no meaningful "wind direction is HIGH"). MotionDetected stays
 * permanently false, which is what we want; users who need a
 * direction-shift trigger can build it from a Wind Speed automation
 * + a Home app scene check.
 *
 * AWN reports degrees as a float; we round to the nearest integer
 * since fractional degrees are below the station's sensor precision.
 */
declare abstract class WindDirectionLikeAccessory extends ExtendedSensorBase {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, sensorLabel: string, awnKey: string);
    protected formatValue(rawDegrees: number): string;
}
/**
 * AWN: `winddir` — the instantaneous wind direction reading. Can
 * flap around in light wind; users who want a smoothed value should
 * enable the 10m-averaged variant below.
 */
export declare class WindDirectionAccessory extends WindDirectionLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
/**
 * AWN: `winddir_avg10m` — direction averaged over the last 10
 * minutes. More stable than the instant reading; recommended for
 * users in variable-wind locations.
 */
export declare class WindDirection10mAccessory extends WindDirectionLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
export {};
//# sourceMappingURL=windAccessory.d.ts.map
import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
/**
 * AWN's WH31L lightning sensor (Ecowitt WH57 equivalent) reports four fields, and we expose each
 * as its own MotionSensor accessory:
 *   - lightning_day      — strike count since local midnight
 *   - lightning_hour     — strike count in the trailing hour
 *   - lightning_distance — miles to the most recent strike
 *   - lightning_time     — Unix-ms timestamp of the most recent strike
 *
 * For the two counts, any non-zero value triggers MotionDetected
 * (default threshold of 1 strike) — useful for "send notification
 * when lightning detected" automations.
 *
 * For distance, the trigger direction is inverted — *close* strikes
 * are the alarming case. Default 10 mi threshold corresponds to ~16
 * km, the conventional "lightning is too close for outdoor activity"
 * boundary used by sports officials and the National Weather Service.
 *
 * For the timestamp, there's no meaningful threshold; MotionDetected
 * stays permanently false and the Value characteristic carries a
 * relative "time-since" string ("3 hours ago", "2 days ago",
 * "never"). The platform layer pre-converts the AWN ms timestamp to
 * a raw number before passing into setValue().
 */
declare abstract class LightningCountLikeAccessory extends ExtendedSensorBase {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, sensorLabel: string, awnKey: string);
    protected formatValue(rawCount: number): string;
}
/**
 * AWN: `lightning_day` — strike count since local midnight. Resets at
 * midnight in the station's configured timezone.
 */
export declare class LightningDayAccessory extends LightningCountLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
/**
 * AWN: `lightning_hour` — strike count in the trailing 60 minutes.
 * Sliding window, not aligned to clock hours.
 */
export declare class LightningHourAccessory extends LightningCountLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
/**
 * AWN: `lightning_distance` — distance to the most recent strike, in
 * miles. Triggers MotionDetected when the distance drops *below* the
 * configured threshold (close strikes are the alarming case).
 *
 * Note: AWN doesn't refresh this field when no new strike has
 * occurred recently — the value can be stale by minutes or hours.
 * Pair this with the lightning_time accessory to know how recent
 * the reading is.
 */
export declare class LightningDistanceAccessory extends ExtendedSensorBase {
    private readonly distanceUnit;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    protected formatValue(rawMi: number): string;
}
/**
 * AWN: `lightning_time` — Unix-ms timestamp of the last detected
 * strike. The platform layer ensures the raw value passed in is
 * already a number (AWN itself reports it as a JSON number, so no
 * conversion needed). Value characteristic is rendered as a
 * relative time string ("2 minutes ago", "never").
 */
export declare class LightningLastStrikeAccessory extends ExtendedSensorBase {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    protected formatValue(rawMs: number): string;
}
export {};
//# sourceMappingURL=lightningAccessory.d.ts.map
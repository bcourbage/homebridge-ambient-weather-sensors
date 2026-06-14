import { PlatformAccessory } from 'homebridge';
import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedSensorBase } from './extendedSensorBase.js';
/**
 * Rain-rate accessory. AWN's `hourlyrainin` is inches-per-hour — the
 * canonical "is it raining right now" signal. Threshold default
 * (0.01 in/hr) is set just above zero so any measurable rain trips
 * the MotionDetected boolean — useful for irrigation automations
 * ("when rain motion detected, skip the sprinkler cycle").
 *
 * Intensity uses NWS descriptors (None / Light / Moderate / Heavy /
 * Violent) based on the rate; bucket boundaries match conventional
 * meteorological definitions.
 */
declare abstract class RainRateLikeAccessory extends ExtendedSensorBase {
    private readonly rainUnit;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, sensorLabel: string, awnKey: string, thresholdInHr: number);
    protected formatValue(rawInHr: number): string;
    protected formatIntensity(rawInHr: number): string | undefined;
}
/**
 * AWN: `hourlyrainin` — current rainfall rate in inches per hour.
 * Updates roughly every minute on AWN's side; refreshed by us on
 * every poll/realtime tick.
 */
export declare class RainRateAccessory extends RainRateLikeAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
}
/**
 * Accumulation totals (event, daily, weekly, monthly, yearly). Unlike
 * the rate sensor, these are cumulative counters that reset on AWN's
 * schedule (event = until next dry period, daily = local midnight,
 * etc.). We expose the value with two decimals and trigger
 * MotionDetected if any rain has fallen since the last reset.
 *
 * Intensity uses the same NWS descriptors as the rate sensor but
 * applied to the accumulated total rather than the rate — useful as
 * an at-a-glance "how wet has it been this week?" indicator.
 */
declare abstract class RainAccumulationLikeAccessory extends ExtendedSensorBase {
    private readonly rainUnit;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, sensorLabel: string, awnKey: string);
    protected formatValue(rawIn: number): string;
}
export declare class RainEventAccessory extends RainAccumulationLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
export declare class RainDailyAccessory extends RainAccumulationLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
export declare class RainWeeklyAccessory extends RainAccumulationLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
export declare class RainMonthlyAccessory extends RainAccumulationLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
export declare class RainYearlyAccessory extends RainAccumulationLikeAccessory {
    constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory);
}
/**
 * AWN: `lastRain` — ISO timestamp string of the last detected rain
 * event. The platform layer pre-converts this to a Unix-ms number
 * via Date.parse(...) before passing to setValue(), keeping the
 * SensorAccessory interface signature uniform.
 *
 * Value reads as a relative time-since-then ("3 hours ago", "5 days
 * ago", "never"). MotionDetected here doesn't make sense as a
 * threshold against a timestamp; we leave it always false.
 */
export declare class LastRainAccessory extends ExtendedSensorBase {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory);
    protected formatValue(rawMs: number): string;
}
export {};
//# sourceMappingURL=rainAccessory.d.ts.map
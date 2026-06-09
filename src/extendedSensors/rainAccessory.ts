import { PlatformAccessory } from 'homebridge';

import { AmbientWeatherSensorsPlatform } from '../platform.js';
import { ExtendedDisplayMode, ExtendedSensorBase } from './extendedSensorBase.js';
import { rainIntensity, timeSince } from './intensityBuckets.js';
import { convertRain, RainUnit } from './unitConversions.js';

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
abstract class RainRateLikeAccessory extends ExtendedSensorBase {
  private readonly rainUnit: RainUnit;

  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    sensorLabel: string,
    awnKey: string,
    thresholdInHr: number,
  ) {
    const displayMode: ExtendedDisplayMode =
      platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
    const rainUnit: RainUnit = (platform.config.units?.rain as RainUnit) || 'in';

    super(platform, accessory, {
      sensorLabel,
      awnKey,
      threshold: thresholdInHr,  // threshold stays in inches/hr internally (AWN's native unit)
      displayMode,
    });

    this.rainUnit = rainUnit;
  }

  protected formatValue(rawInHr: number): string {
    const converted = convertRain(rawInHr, this.rainUnit);
    // Two decimals at low values, one at moderate, none at violent —
    // matches what someone would actually want to see at each rate.
    const precision = converted < 1 ? 2 : (converted < 10 ? 1 : 0);
    const unitLabel = this.rainUnit === 'mm' ? 'mm/hr' : 'in/hr';
    return `${converted.toFixed(precision)} ${unitLabel}`;
  }

  protected formatIntensity(rawInHr: number): string | undefined {
    return rainIntensity(rawInHr);
  }
}

/**
 * AWN: `hourlyrainin` — current rainfall rate in inches per hour.
 * Updates roughly every minute on AWN's side; refreshed by us on
 * every poll/realtime tick.
 */
export class RainRateAccessory extends RainRateLikeAccessory {
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory) {
    const threshold = (platform.config.thresholds?.rainRateInHr as number) ?? 0.01;
    super(platform, accessory, 'Rain Rate', 'hourlyrainin', threshold);
  }
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
abstract class RainAccumulationLikeAccessory extends ExtendedSensorBase {
  private readonly rainUnit: RainUnit;

  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    sensorLabel: string,
    awnKey: string,
  ) {
    const displayMode: ExtendedDisplayMode =
      platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
    const rainUnit: RainUnit = (platform.config.units?.rain as RainUnit) || 'in';

    super(platform, accessory, {
      sensorLabel,
      awnKey,
      // Trigger if there's *any* measurable accumulation since the
      // last reset; threshold deliberately tiny so light drizzle
      // counts. Users can raise it in config for noisier signals.
      threshold: 0.01,
      displayMode,
    });

    this.rainUnit = rainUnit;
  }

  protected formatValue(rawIn: number): string {
    const converted = convertRain(rawIn, this.rainUnit);
    const precision = converted < 1 ? 2 : (converted < 10 ? 1 : 0);
    const unitLabel = this.rainUnit === 'mm' ? 'mm' : 'in';
    return `${converted.toFixed(precision)} ${unitLabel}`;
  }

  // No intensity bucket for accumulation totals — the rate sensor is
  // the right place to convey "how hard it's raining"; this one just
  // tracks the total.
}

export class RainEventAccessory extends RainAccumulationLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory) { super(p, a, 'Rain Event', 'eventrainin'); }
}
export class RainDailyAccessory extends RainAccumulationLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory) { super(p, a, 'Rain Daily', 'dailyrainin'); }
}
export class RainWeeklyAccessory extends RainAccumulationLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory) { super(p, a, 'Rain Weekly', 'weeklyrainin'); }
}
export class RainMonthlyAccessory extends RainAccumulationLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory) { super(p, a, 'Rain Monthly', 'monthlyrainin'); }
}
export class RainYearlyAccessory extends RainAccumulationLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory) { super(p, a, 'Rain Yearly', 'yearlyrainin'); }
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
export class LastRainAccessory extends ExtendedSensorBase {
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory) {
    const displayMode: ExtendedDisplayMode =
      platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
    super(platform, accessory, {
      sensorLabel: 'Last Rain',
      awnKey: 'lastRain',
      threshold: Infinity,
      displayMode,
    });
  }

  protected formatValue(rawMs: number): string {
    return timeSince(rawMs);
  }
}

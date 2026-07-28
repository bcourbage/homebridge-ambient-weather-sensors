import { PlatformAccessory } from 'homebridge';

import { AmbientWeatherSensorsPlatform } from '../platform.js';
import type { NumericSensorRow, TimestampSensorRow } from '../sensorMap/types.js';
import {
  ExtendedSensorBase,
  extendedDisplayModeFor,
  thresholdFor,
} from './extendedSensorBase.js';
import { timeSince } from './intensityBuckets.js';
import { convertDistance, DistanceUnit } from './unitConversions.js';

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

abstract class LightningCountLikeAccessory extends ExtendedSensorBase {
  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    sensorLabel: string,
    awnKey: string,
    // Row-driven (finding #4). count is canonical for strike counts.
    row?: NumericSensorRow,
  ) {
    super(platform, accessory, {
      variant: 'numeric',
      sensorLabel: row?.name ?? sensorLabel,
      awnKey: row?.dataPoint ?? awnKey,
      // Any strike at all is noteworthy — the family default is 1, set on
      // the KNOWN lightning-count rows in DEFAULT_SENSOR_MAP so a resolved
      // known row carries it and `thresholdFor` reads it off the row
      // (uniform with every other family). The legacy fallback (1) is used
      // only on the row-absent path. A custom count row that omits
      // `threshold` is disabled (Infinity), per the frozen schema.
      threshold: thresholdFor(row, 1),
      // Row-driven trigger direction (review R10-1): an authored
      // `below` must flow through; 'above' is the family default.
      triggerDirection: row?.triggerDirection ?? 'above',
      displayMode: extendedDisplayModeFor(platform, row),
      measurement: 'count',
      sourceUnit: 'count',
    }, row);
  }

  protected formatValue(rawCount: number): string {
    const n = Math.max(0, Math.round(rawCount));
    return `${n} ${n === 1 ? 'strike' : 'strikes'}`;
  }

  // No qualitative bucket — a strike count is a count.
}

/**
 * AWN: `lightning_day` — strike count since local midnight. Resets at
 * midnight in the station's configured timezone.
 */
export class LightningDayAccessory extends LightningCountLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory, row?: NumericSensorRow) {
    super(p, a, 'Lightning Strikes Today', 'lightning_day', row);
  }
}

/**
 * AWN: `lightning_hour` — strike count in the trailing 60 minutes.
 * Sliding window, not aligned to clock hours.
 */
export class LightningHourAccessory extends LightningCountLikeAccessory {
  constructor(p: AmbientWeatherSensorsPlatform, a: PlatformAccessory, row?: NumericSensorRow) {
    super(p, a, 'Lightning Strikes This Hour', 'lightning_hour', row);
  }
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
export class LightningDistanceAccessory extends ExtendedSensorBase {
  private readonly distanceUnit: DistanceUnit;

  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row?: NumericSensorRow) {
    const distanceUnit: DistanceUnit = row
      ? (row.displayUnit as DistanceUnit)
      : ((platform.config.units?.distance as DistanceUnit) || 'mi');
    // Blank in HB UI form → undefined → Infinity → Number.isFinite check
    // in the base class returns false → MotionDetected never fires.
    // Accessory still appears so distance is visible in Eve.
    const raw = platform.config.thresholds?.lightningDistanceMi;
    const thresholdMi = typeof raw === 'number' ? raw : Infinity;

    super(platform, accessory, {
      variant: 'numeric',
      sensorLabel: row?.name ?? 'Lightning Distance',
      awnKey: row?.dataPoint ?? 'lightning_distance',
      threshold: thresholdFor(row, thresholdMi),  // in mi (canonical for AWN)
      triggerDirection: row?.triggerDirection ?? 'below',  // close = alarming, opposite of most sensors
      displayMode: extendedDisplayModeFor(platform, row),
      measurement: 'distance',
      sourceUnit: row?.sourceUnit ?? 'mi',
    }, row);

    this.distanceUnit = distanceUnit;
  }

  protected formatValue(canonicalMi: number): string {
    const converted = convertDistance(canonicalMi, this.distanceUnit);
    const precision = converted < 10 ? 1 : 0;
    const unitLabel = this.distanceUnit;
    return `${converted.toFixed(precision)} ${unitLabel}`;
  }
}

/**
 * AWN: `lightning_time` — Unix-ms timestamp of the last detected
 * strike. The platform layer ensures the raw value passed in is
 * already a number (AWN itself reports it as a JSON number, so no
 * conversion needed). Value characteristic is rendered as a
 * relative time string ("2 minutes ago", "never").
 */
export class LightningLastStrikeAccessory extends ExtendedSensorBase {
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row?: TimestampSensorRow) {
    super(platform, accessory, {
      variant: 'timestamp',
      sensorLabel: row?.name ?? 'Last Lightning Strike',
      awnKey: row?.dataPoint ?? 'lightning_time',
      threshold: Infinity,  // informational, never triggers motion
      displayMode: extendedDisplayModeFor(platform, row),
      measurement: 'timestamp',
      sourceUnit: 'ms',
    }, row);
  }

  protected formatValue(rawMs: number): string {
    return timeSince(rawMs);
  }
}

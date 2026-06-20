import { ExtendedSensorBase } from './extendedSensorBase.js';
import { timeSince } from './intensityBuckets.js';
import { convertDistance } from './unitConversions.js';
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
class LightningCountLikeAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, sensorLabel, awnKey) {
        const displayMode = platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
        super(platform, accessory, {
            sensorLabel,
            awnKey,
            // Any strike at all is noteworthy; users can raise this in
            // config if they get false positives or want a higher signal.
            threshold: 1,
            displayMode,
        });
    }
    formatValue(rawCount) {
        const n = Math.max(0, Math.round(rawCount));
        return `${n} ${n === 1 ? 'strike' : 'strikes'}`;
    }
}
/**
 * AWN: `lightning_day` — strike count since local midnight. Resets at
 * midnight in the station's configured timezone.
 */
export class LightningDayAccessory extends LightningCountLikeAccessory {
    constructor(p, a) {
        super(p, a, 'Lightning Strikes Today', 'lightning_day');
    }
}
/**
 * AWN: `lightning_hour` — strike count in the trailing 60 minutes.
 * Sliding window, not aligned to clock hours.
 */
export class LightningHourAccessory extends LightningCountLikeAccessory {
    constructor(p, a) {
        super(p, a, 'Lightning Strikes This Hour', 'lightning_hour');
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
    constructor(platform, accessory) {
        const displayMode = platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
        const distanceUnit = platform.config.units?.distance || 'mi';
        // Blank in HB UI form → undefined → Infinity → Number.isFinite check
        // in the base class returns false → MotionDetected never fires.
        // Accessory still appears so distance is visible in Eve.
        const raw = platform.config.thresholds?.lightningDistanceMi;
        const thresholdMi = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, {
            sensorLabel: 'Lightning Distance',
            awnKey: 'lightning_distance',
            threshold: thresholdMi,
            triggerDirection: 'below', // close = alarming, opposite of most sensors
            displayMode,
        });
        this.distanceUnit = distanceUnit;
    }
    formatValue(rawMi) {
        const converted = convertDistance(rawMi, this.distanceUnit);
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
    constructor(platform, accessory) {
        const displayMode = platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
        super(platform, accessory, {
            sensorLabel: 'Last Lightning Strike',
            awnKey: 'lightning_time',
            threshold: Infinity, // informational, never triggers motion
            displayMode,
        });
    }
    formatValue(rawMs) {
        return timeSince(rawMs);
    }
}
//# sourceMappingURL=lightningAccessory.js.map
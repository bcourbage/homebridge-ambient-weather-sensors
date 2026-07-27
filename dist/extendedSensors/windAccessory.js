import { ExtendedSensorBase, extendedDisplayModeFor, thresholdFor, } from './extendedSensorBase.js';
import { beaufort, toCardinal } from './intensityBuckets.js';
import { convertSpeed } from './unitConversions.js';
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
class WindSpeedLikeAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, sensorLabel, awnKey, thresholdMph, 
    // Row-driven (finding #4). When present, name / threshold /
    // display unit / embed mode come from the row; the raw mph reading
    // is canonical for AWN so the base's toCanonical is a no-op.
    row) {
        const speedUnit = row
            ? row.displayUnit
            : (platform.config.units?.windSpeed || 'mph');
        super(platform, accessory, {
            variant: 'numeric',
            sensorLabel,
            awnKey: row?.dataPoint ?? awnKey,
            threshold: thresholdFor(row, thresholdMph), // in mph (canonical for AWN)
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: 'wind-speed',
            sourceUnit: row?.sourceUnit ?? 'mph',
        }, row);
        this.speedUnit = speedUnit;
        this.unitLabel = speedUnit;
    }
    formatValue(canonicalMph) {
        const converted = convertSpeed(canonicalMph, this.speedUnit);
        return `${Math.round(converted)} ${this.unitLabel}`;
    }
    formatIntensity(canonicalMph) {
        // Beaufort scale is anchored to mph, which is the canonical unit —
        // the base hands us the already-canonicalized value.
        return beaufort(canonicalMph);
    }
}
/**
 * AWN: `windspeedmph` — the current instantaneous wind speed. Default
 * threshold (25 mph) corresponds to Beaufort 6 ("Strong breeze") —
 * the level at which loose objects start to blow around, a common
 * automation trigger ("close the awning when it gets gusty").
 */
export class WindSpeedAccessory extends WindSpeedLikeAccessory {
    constructor(platform, accessory, row) {
        // Blank threshold field in HB UI → undefined here → Infinity → base
        // class's Number.isFinite check returns false → MotionDetected
        // never fires. Accessory still exists for the value reading in Eve;
        // only the automation trigger is disabled. (Legacy path only — a
        // row supplies its own threshold.)
        const raw = platform.config.thresholds?.windSpeedMph;
        const threshold = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, 'Wind Speed', 'windspeedmph', threshold, row);
    }
}
/**
 * AWN: `windgustmph` — the highest instantaneous reading in the last
 * polling interval. Default threshold (35 mph) is higher than the
 * sustained-speed threshold because gusts are momentary and need a
 * larger value to be alarming. Beaufort 7 territory.
 */
export class WindGustAccessory extends WindSpeedLikeAccessory {
    constructor(platform, accessory, row) {
        const raw = platform.config.thresholds?.windGustMph;
        const threshold = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, 'Wind Gust', 'windgustmph', threshold, row);
    }
}
/**
 * AWN: `maxdailygust` — the maximum gust speed recorded today (resets
 * at local midnight per AWN's tz). Default threshold matches
 * WindGust since it's a different time-aggregation of the same
 * fundamental measurement.
 */
export class WindMaxDailyGustAccessory extends WindSpeedLikeAccessory {
    constructor(platform, accessory, row) {
        const raw = platform.config.thresholds?.windGustMph;
        const threshold = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, 'Max Daily Gust', 'maxdailygust', threshold, row);
    }
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
class WindDirectionLikeAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, sensorLabel, awnKey, row) {
        super(platform, accessory, {
            variant: 'numeric',
            sensorLabel,
            awnKey: row?.dataPoint ?? awnKey,
            threshold: Infinity, // never triggers MotionDetected
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: 'direction',
            sourceUnit: row?.sourceUnit ?? 'degrees',
        }, row);
    }
    formatValue(rawDegrees) {
        const deg = Math.round(((rawDegrees % 360) + 360) % 360);
        return `${deg}° ${toCardinal(rawDegrees)}`;
    }
}
/**
 * AWN: `winddir` — the instantaneous wind direction reading. Can
 * flap around in light wind; users who want a smoothed value should
 * enable the 10m-averaged variant below.
 */
export class WindDirectionAccessory extends WindDirectionLikeAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, 'Wind Direction', 'winddir', row);
    }
}
/**
 * AWN: `winddir_avg10m` — direction averaged over the last 10
 * minutes. More stable than the instant reading; recommended for
 * users in variable-wind locations.
 */
export class WindDirection10mAccessory extends WindDirectionLikeAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, 'Wind Direction 10m Avg', 'winddir_avg10m', row);
    }
}
//# sourceMappingURL=windAccessory.js.map
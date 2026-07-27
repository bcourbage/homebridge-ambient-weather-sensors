import { ExtendedSensorBase, extendedDisplayModeFor, thresholdFor, } from './extendedSensorBase.js';
import { rainIntensity, timeSince } from './intensityBuckets.js';
import { convertRain } from './unitConversions.js';
/**
 * Rain measurements report length in the family canonical unit
 * (in / in_per_hr). The display converter (`convertRain`) works in the
 * dimensionless length unit `RainUnit` ('in' | 'mm'), so a row's
 * per-hour rate display unit maps to its length unit for formatting.
 */
function rainDisplayUnit(row, legacy) {
    if (!row) {
        return legacy;
    }
    return row.displayUnit === 'mm' || row.displayUnit === 'mm_per_hr' ? 'mm' : 'in';
}
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
class RainRateLikeAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, sensorLabel, awnKey, thresholdInHr, 
    // Row-driven (finding #4). in_per_hr is canonical for rain rate.
    row) {
        const legacyUnit = platform.config.units?.rain || 'in';
        super(platform, accessory, {
            sensorLabel: row?.name ?? sensorLabel,
            awnKey: row?.dataPoint ?? awnKey,
            threshold: thresholdFor(row, thresholdInHr), // in in/hr (canonical for AWN)
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: 'rain-rate',
            sourceUnit: row?.sourceUnit ?? 'in_per_hr',
        }, row);
        this.rainUnit = rainDisplayUnit(row, legacyUnit);
    }
    formatValue(canonicalInHr) {
        const converted = convertRain(canonicalInHr, this.rainUnit);
        // Two decimals at low values, one at moderate, none at violent —
        // matches what someone would actually want to see at each rate.
        const precision = converted < 1 ? 2 : (converted < 10 ? 1 : 0);
        const unitLabel = this.rainUnit === 'mm' ? 'mm/hr' : 'in/hr';
        return `${converted.toFixed(precision)} ${unitLabel}`;
    }
    formatIntensity(rawInHr) {
        return rainIntensity(rawInHr);
    }
}
/**
 * AWN: `hourlyrainin` — current rainfall rate in inches per hour.
 * Updates roughly every minute on AWN's side; refreshed by us on
 * every poll/realtime tick.
 */
export class RainRateAccessory extends RainRateLikeAccessory {
    constructor(platform, accessory, row) {
        // Blank in HB UI form → undefined → Infinity → never triggers.
        // Accessory still appears so the rate is visible in Eve.
        const raw = platform.config.thresholds?.rainRateInHr;
        const threshold = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, 'Rain Rate', 'hourlyrainin', threshold, row);
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
class RainAccumulationLikeAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, sensorLabel, awnKey, 
    // Row-driven (finding #4). in is canonical for rain accumulation.
    row) {
        const legacyUnit = platform.config.units?.rain || 'in';
        super(platform, accessory, {
            sensorLabel: row?.name ?? sensorLabel,
            awnKey: row?.dataPoint ?? awnKey,
            // Trigger if there's *any* measurable accumulation since the last
            // reset; threshold deliberately tiny so light drizzle counts. The
            // family default (0.01 in) is the fallback for BOTH the legacy
            // path and a row that carries no explicit threshold — unlike the
            // other extended families (whose no-threshold state means
            // "disabled"), accumulation motion fires by default. An explicit
            // row threshold or `triggerEnabled: false` still wins.
            threshold: row
                ? (row.triggerEnabled === false ? Infinity : (row.threshold ?? 0.01))
                : 0.01,
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: 'rain-accumulation',
            sourceUnit: row?.sourceUnit ?? 'in',
        }, row);
        this.rainUnit = rainDisplayUnit(row, legacyUnit);
    }
    formatValue(canonicalIn) {
        const converted = convertRain(canonicalIn, this.rainUnit);
        const precision = converted < 1 ? 2 : (converted < 10 ? 1 : 0);
        const unitLabel = this.rainUnit === 'mm' ? 'mm' : 'in';
        return `${converted.toFixed(precision)} ${unitLabel}`;
    }
}
export class RainEventAccessory extends RainAccumulationLikeAccessory {
    constructor(p, a, row) { super(p, a, 'Rain Event', 'eventrainin', row); }
}
export class RainDailyAccessory extends RainAccumulationLikeAccessory {
    constructor(p, a, row) { super(p, a, 'Rain Daily', 'dailyrainin', row); }
}
export class RainWeeklyAccessory extends RainAccumulationLikeAccessory {
    constructor(p, a, row) { super(p, a, 'Rain Weekly', 'weeklyrainin', row); }
}
export class RainMonthlyAccessory extends RainAccumulationLikeAccessory {
    constructor(p, a, row) { super(p, a, 'Rain Monthly', 'monthlyrainin', row); }
}
export class RainYearlyAccessory extends RainAccumulationLikeAccessory {
    constructor(p, a, row) { super(p, a, 'Rain Yearly', 'yearlyrainin', row); }
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
    constructor(platform, accessory, row) {
        super(platform, accessory, {
            sensorLabel: row?.name ?? 'Last Rain',
            awnKey: row?.dataPoint ?? 'lastRain',
            threshold: Infinity,
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: 'timestamp',
            sourceUnit: 'ms',
        }, row);
    }
    formatValue(rawMs) {
        return timeSince(rawMs);
    }
}
//# sourceMappingURL=rainAccessory.js.map
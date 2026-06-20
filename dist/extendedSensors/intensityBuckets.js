/**
 * Qualitative-bucket helpers used by the extended sensor accessories.
 * Each function maps a raw numeric reading to a human-readable label
 * for the `Intensity` characteristic (Eve / Controller for HomeKit
 * users see these directly on the tile).
 *
 * Bucket scales are intentionally conventional — Beaufort for wind,
 * EPA buckets for UV, NWS-style descriptors for rain — so users
 * who've seen weather data anywhere else recognize the categories.
 * Boundary values are inclusive on the lower edge per the original
 * scales (e.g. Beaufort 1 is 1-3 mph; Beaufort 0 is *under* 1 mph).
 *
 * Pure functions. No dependencies. Easy to unit-test.
 */
/**
 * Beaufort wind force scale, input in mph. The full 13-step scale
 * (0 = Calm, 12 = Hurricane). AWN reports wind in mph for US
 * stations; conversion to kph happens at the per-sensor layer
 * before the bucket lookup so the thresholds below stay anchored
 * to the original Beaufort definitions.
 */
const BEAUFORT_BUCKETS_MPH = [
    { max: 1, label: 'Calm' },
    { max: 4, label: 'Light air' },
    { max: 8, label: 'Light breeze' },
    { max: 13, label: 'Gentle breeze' },
    { max: 19, label: 'Moderate breeze' },
    { max: 25, label: 'Fresh breeze' },
    { max: 32, label: 'Strong breeze' },
    { max: 39, label: 'Near gale' },
    { max: 47, label: 'Gale' },
    { max: 55, label: 'Strong gale' },
    { max: 64, label: 'Storm' },
    { max: 73, label: 'Violent storm' },
    { max: Infinity, label: 'Hurricane' },
];
export function beaufort(speedMph) {
    for (const bucket of BEAUFORT_BUCKETS_MPH) {
        if (speedMph < bucket.max) {
            return bucket.label;
        }
    }
    return 'Hurricane'; // unreachable; appeases the type checker
}
/**
 * Rain intensity buckets, input in inches per hour. National Weather
 * Service descriptors: nothing → light → moderate → heavy → violent.
 * The "None" bucket explicitly catches exactly-zero readings so a
 * dry station doesn't report as "Light" rain.
 */
const RAIN_BUCKETS_IN_HR = [
    { max: 0.001, label: 'None' }, // effectively 0 — float tolerance
    { max: 0.1, label: 'Light' }, // < 0.1"/hr
    { max: 0.3, label: 'Moderate' }, // 0.1 to 0.3"/hr
    { max: 2.0, label: 'Heavy' }, // 0.3 to 2.0"/hr
    { max: Infinity, label: 'Violent' }, // 2.0"/hr+
];
export function rainIntensity(rateInHr) {
    for (const bucket of RAIN_BUCKETS_IN_HR) {
        if (rateInHr < bucket.max) {
            return bucket.label;
        }
    }
    return 'Violent';
}
/**
 * EPA UV index buckets. Standard categories used by every weather
 * service in the US — "Low" through "Extreme" with the WHO/EPA
 * action recommendations implicit in each.
 */
const UV_BUCKETS = [
    { max: 3, label: 'Low' }, // 0-2
    { max: 6, label: 'Moderate' }, // 3-5
    { max: 8, label: 'High' }, // 6-7
    { max: 11, label: 'Very High' }, // 8-10
    { max: Infinity, label: 'Extreme' }, // 11+
];
export function uvBucket(uv) {
    for (const bucket of UV_BUCKETS) {
        if (uv < bucket.max) {
            return bucket.label;
        }
    }
    return 'Extreme';
}
/**
 * Map a wind direction in degrees (0 = N, increasing clockwise) to
 * one of 16 cardinal compass points. Sector width is 22.5°; sector
 * 0 (N) is centered on 0° and spans 348.75°-360° + 0°-11.25°.
 *
 * Returned strings: N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW.
 */
const COMPASS_16 = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW',
];
export function toCardinal(degrees) {
    const normalized = ((degrees % 360) + 360) % 360; // handle negative inputs
    const index = Math.round(normalized / 22.5) % 16;
    return COMPASS_16[index];
}
/**
 * Format a Unix-millisecond timestamp as a relative "time ago" string
 * suitable for display on the LastUpdated or Value characteristic.
 * Examples: "just now", "5 minutes ago", "3 hours ago", "2 days ago".
 *
 * `nowMs` is injectable for tests; production callers omit it.
 *
 * Returns "never" when timestamp is 0 / undefined / NaN — the AWN
 * sentinel for "no event yet recorded" (e.g. a lightning sensor that
 * hasn't seen a strike since boot).
 */
export function timeSince(timestampMs, nowMs = Date.now()) {
    if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) {
        return 'never';
    }
    const deltaSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
    if (deltaSec < 30) {
        return 'just now';
    }
    if (deltaSec < 60) {
        return `${deltaSec} seconds ago`;
    }
    const deltaMin = Math.floor(deltaSec / 60);
    if (deltaMin < 60) {
        return deltaMin === 1 ? '1 minute ago' : `${deltaMin} minutes ago`;
    }
    const deltaHr = Math.floor(deltaMin / 60);
    if (deltaHr < 24) {
        return deltaHr === 1 ? '1 hour ago' : `${deltaHr} hours ago`;
    }
    const deltaDay = Math.floor(deltaHr / 24);
    if (deltaDay < 30) {
        return deltaDay === 1 ? '1 day ago' : `${deltaDay} days ago`;
    }
    const deltaMonth = Math.floor(deltaDay / 30);
    if (deltaMonth < 12) {
        return deltaMonth === 1 ? '1 month ago' : `${deltaMonth} months ago`;
    }
    const deltaYear = Math.floor(deltaDay / 365);
    return deltaYear === 1 ? '1 year ago' : `${deltaYear} years ago`;
}
//# sourceMappingURL=intensityBuckets.js.map
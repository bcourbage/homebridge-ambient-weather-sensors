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
export declare function beaufort(speedMph: number): string;
export declare function rainIntensity(rateInHr: number): string;
export declare function uvBucket(uv: number): string;
export declare function toCardinal(degrees: number): string;
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
export declare function timeSince(timestampMs: number | undefined, nowMs?: number): string;
//# sourceMappingURL=intensityBuckets.d.ts.map
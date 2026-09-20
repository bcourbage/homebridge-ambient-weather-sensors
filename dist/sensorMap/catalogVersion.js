/**
 * Catalog versioning and adoption stamps — sensor-map.md §18.3.
 *
 * The AWN catalog grows in versioned steps. A configuration carries two
 * stamps that make its exposure history durable:
 *
 *   - `catalogBaseline`: the catalog version the installation was BORN
 *     at (first created, or converted from legacy). Written once.
 *   - `catalogAdopted`: the newest catalog version whose definitions
 *     are VISIBLE to this config. Advanced only by explicit adoption.
 *
 * Default exposure derives from the baseline by arithmetic: a
 * definition with `sinceCatalogVersion <= baseline` uses its own
 * default; one that arrived later (`baseline < since <= adopted`)
 * defaults to disabled. No per-row bookkeeping, no inventory
 * dependence — offline and never-seen stations resolve identically.
 *
 * Both stamps absent is the DEFINED legacy state: (1, 1), the v1
 * baseline every config in the field has today. Any other invalid
 * combination fails closed (§18.3): the caller enters the safe-mode
 * protective posture rather than capping or resetting, because
 * changing definition visibility out from under an existing accessory
 * was measured to unregister it (PR #65 review round 2).
 */
/** The catalog version this plugin build ships. */
export const CURRENT_CATALOG_VERSION = 2;
/** The frozen v1 baseline: today's static table + fallback behavior. */
export const CATALOG_V1_BASELINE = 1;
/**
 * Parse and validate the stamp pair from a raw config block.
 *
 * Valid states:
 *   - both absent → (1, 1), the legacy interpretation;
 *   - both integers >= 1, baseline <= adopted <= CURRENT_CATALOG_VERSION.
 *
 * Everything else is `invalid` with a problem statement the caller
 * embeds in the protective-posture banner. `adopted` above the running
 * plugin's version is invalid HERE (a downgrade or a config written by
 * a newer plugin): visibility must not be capped, so the caller fails
 * closed instead.
 */
export function parseCatalogStamps(config) {
    const rawBaseline = config?.catalogBaseline;
    const rawAdopted = config?.catalogAdopted;
    if (rawBaseline === undefined && rawAdopted === undefined) {
        return { status: 'ok', stamps: { catalogBaseline: CATALOG_V1_BASELINE, catalogAdopted: CATALOG_V1_BASELINE } };
    }
    if (rawBaseline === undefined || rawAdopted === undefined) {
        const present = rawBaseline === undefined ? 'catalogAdopted' : 'catalogBaseline';
        const absent = rawBaseline === undefined ? 'catalogBaseline' : 'catalogAdopted';
        return { status: 'invalid', problem: `${present} is set but ${absent} is missing; the pair travels together` };
    }
    if (!isStampInteger(rawBaseline)) {
        return { status: 'invalid', problem: `catalogBaseline "${describeStamp(rawBaseline)}" is not a positive integer` };
    }
    if (!isStampInteger(rawAdopted)) {
        return { status: 'invalid', problem: `catalogAdopted "${describeStamp(rawAdopted)}" is not a positive integer` };
    }
    if (rawBaseline > rawAdopted) {
        return { status: 'invalid', problem: `catalogBaseline (${rawBaseline}) is greater than catalogAdopted (${rawAdopted})` };
    }
    if (rawAdopted > CURRENT_CATALOG_VERSION) {
        return {
            status: 'invalid',
            problem: `catalogAdopted (${rawAdopted}) is newer than this plugin supports (${CURRENT_CATALOG_VERSION}); `
                + 'upgrade the plugin',
        };
    }
    return { status: 'ok', stamps: { catalogBaseline: rawBaseline, catalogAdopted: rawAdopted } };
}
function isStampInteger(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}
function describeStamp(v) {
    if (v === null) {
        return 'null';
    }
    if (typeof v === 'number' && Number.isNaN(v)) {
        return 'NaN';
    }
    return String(v);
}
//# sourceMappingURL=catalogVersion.js.map
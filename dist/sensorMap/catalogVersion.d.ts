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
export declare const CURRENT_CATALOG_VERSION = 3;
/** The frozen v1 baseline: today's static table + fallback behavior. */
export declare const CATALOG_V1_BASELINE = 1;
export interface CatalogStamps {
    catalogBaseline: number;
    catalogAdopted: number;
}
export type CatalogStampResult = {
    status: 'ok';
    stamps: CatalogStamps;
} | {
    status: 'invalid';
    problem: string;
};
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
export declare function parseCatalogStamps(config: Record<string, unknown> | undefined): CatalogStampResult;
//# sourceMappingURL=catalogVersion.d.ts.map
/**
 * The executable AWN input catalog (issue #63, package P1).
 *
 * One machine-readable inventory of every published AWN field
 * entry/family plus the plugin's currently supported extras, each with
 * an EXPLICIT disposition. This file records what an AWN field MEANS
 * (input), separate from which HomeKit representations exist for it
 * (output — see capabilities.ts) and from whether an installation
 * exposes it (exposure policy — sensor-map.md §18).
 *
 * DESIGN CHECKPOINT DATA, deliberately consumed by NOTHING at runtime:
 * the coverage suite (tests/unit/sensorMap/catalogCoverage.test.ts)
 * expands it and compares every key against the PRODUCTION recognizer
 * (`staticDefaultRowFor` / `defaultRowFor`) and battery rules, so
 * known gaps stay visible as tested `catalog-gap` dispositions instead
 * of being disguised as implemented support, and so a definition added
 * later without updating this inventory (or vice versa) fails CI.
 *
 * Provenance: the published baseline is AWN's Device Data Specs wiki,
 * commit e1c13509fdcad8ad7b212e77b8193dac71e241b5 (last published edit
 * 2023-08-07). The published list is not proof that every firmware
 * field is documented; entries carry their own evidence notes where
 * they extend or contradict it. Recorded uncertainty is deliberate:
 * resolving it is P2/P3 work, not this file's job.
 */
/** Bump when entries/families are added, removed, or re-dispositioned. */
export declare const AWN_CATALOG_VERSION = 1;
/** The published baseline this inventory was audited against. */
export declare const AWN_WIKI_BASELINE = "e1c13509fdcad8ad7b212e77b8193dac71e241b5";
export type CatalogClass = 
/** A quantity or state a sensor row could represent. */
'measurement'
/** Battery/status fields consumed by rows, never standalone tiles. */
 | 'battery-auxiliary'
/** Reported relay state; read-only, no control contract exists. */
 | 'relay-state'
/** Station/sample metadata; never an accessory. */
 | 'metadata';
export type CatalogDisposition = 
/** In the static table with a native HomeKit service. */
'implemented-native'
/** In the static table with the extended (threshold-shell) representation. */
 | 'implemented-extended'
/**
 * Recognized today ONLY through the legacy substring fallback (or
 * partly static, partly fallback for an indexed family). Needs an
 * anchored catalog definition (P2) — landing AFTER the
 * assignment-preservation mechanism, per the design checkpoint.
 */
 | 'compat-fallback'
/** Documented measurement the plugin does not recognize today. */
 | 'catalog-gap'
/** Battery/status auxiliary: bound to rows, never a standalone accessory. */
 | 'auxiliary'
/** Metadata: never an accessory. */
 | 'metadata'
/** Deliberately unsupported state until a real mapping is designed. */
 | 'state-unsupported';
export interface CatalogEntry {
    /** Published entry/family label, as audited in issue #63. */
    family: string;
    /** Exact keys (exclusive with `indexed`). */
    keys?: string[];
    /**
     * Bounded indexed family. `staticThrough` marks how far the static
     * table reaches; higher indexes within the bounds resolve via the
     * fallback today (and are part of the `compat-fallback` disposition).
     */
    indexed?: {
        prefix: string;
        suffix?: string;
        from: number;
        to: number;
        staticThrough?: number;
    };
    class: CatalogClass;
    disposition: CatalogDisposition;
    /** What the field means, per the published docs / device evidence. */
    meaning: string;
    /** AWN source unit where verified; absent when unverified. */
    sourceUnit?: string;
    /** Value encoding notes (numbers unless stated). */
    encoding?: string;
    /**
     * Battery relationship where verified: a fixed field name,
     * '{n}'-templated for indexed families, or null for deliberately
     * unmapped (pending device evidence).
     */
    batteryField?: string | null;
    /** Where this knowledge comes from. */
    evidence: string;
    /** Uncertainty and required work, stated instead of guessed. */
    notes?: string;
}
export declare const AWN_CATALOG: ReadonlyArray<CatalogEntry>;
/** Expand an entry to its concrete keys. */
export declare function expandCatalogKeys(entry: CatalogEntry): string[];
/** The battery field an entry declares for a concrete key, if any. */
export declare function catalogBatteryFieldFor(entry: CatalogEntry, key: string): string | null | undefined;
//# sourceMappingURL=awnCatalog.d.ts.map
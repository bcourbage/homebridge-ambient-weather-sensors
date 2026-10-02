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
 * Implemented and compat entries state their expected resolved
 * identity (`kind` / `measurement` / `sourceUnit`), and the suite
 * compares the VALUES against the production resolution — presence
 * alone proves nothing.
 *
 * Provenance: the published baseline is AWN's Device Data Specs wiki,
 * commit e1c13509fdcad8ad7b212e77b8193dac71e241b5 (last published edit
 * 2023-08-07). The published list is not proof that every firmware
 * field is documented; entries carry their own evidence notes where
 * they extend or contradict it. Evidence sources are kept SEPARATE and
 * verbatim — the vendor's declared encoding, the deployed decoder's
 * behavior, and any live-device observation are three distinct facts,
 * recorded as such even (especially) where they disagree. Recorded
 * uncertainty is deliberate: resolving it is P2/P3 work, not this
 * file's job.
 */
/**
 * Bump when entries/families are added, removed, or re-dispositioned.
 * Version 2 (issue #63 P2): the compat-fallback families gained
 * ANCHORED static definitions and the wind/rain gaps became
 * implemented-extended definitions, both stamp-gated behind
 * `sinceCatalogVersion: 2` (§18.3). Version 3 (P3, §19): the
 * agronomic and AQI gaps became extended definitions, the leak
 * detectors became native LeakSensor definitions with the explicit
 * tri-state decode, and the vendor-inverted battery polarities decode
 * correctly on adoption. Version 4 (P3.1, §19.9): adds the generic
 * numeric passthrough capability (motion|numeric); it introduces no new
 * AWN input entries, so this inventory is unchanged in shape and only
 * its version advances. Must equal the runtime's CURRENT_CATALOG_VERSION
 * — the coverage suite pins the equality.
 */
export declare const AWN_CATALOG_VERSION = 4;
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
 * Recognized only through the legacy substring fallback, with no
 * anchored definition yet. No catalog-2 entries remain in this
 * state; a newly discovered fallback-only key would use it until
 * anchored.
 */
 | 'compat-fallback'
/**
 * ANCHORED (§18.3): a static definition since catalog 2 whose
 * identity is IDENTICAL to what the fallback synthesizes, so
 * adoption changes no effective row. Both paths stay live until the
 * compatibility-retirement design; indexes within `staticThrough`
 * are v1-static.
 */
 | 'anchored'
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
    /** The catalog version the definition arrived in; absent = 1. */
    sinceCatalogVersion?: number;
    /** What the field means, per the published docs / device evidence. */
    meaning: string;
    /**
     * Expected resolved row kind. Required (test-enforced) for
     * implemented-* and compat-fallback dispositions; the coverage suite
     * compares it against the production resolution.
     */
    kind?: string;
    /** Expected resolved row measurement; same contract as `kind`. */
    measurement?: string;
    /**
     * AWN source unit as the published docs declare it (verified against
     * the plugin where implemented). Recorded verbatim even where device
     * verification is pending — a declared unit is never replaced by an
     * unspecified one.
     */
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
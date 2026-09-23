/**
 * Default sensor map — the plugin's built-in knowledge about every
 * AWN datapoint it can render out-of-the-box.
 *
 * See docs/future/sensor-map.md §11.1 (audit table) and §11.2
 * (bootstrap rule). The invariant: every row in this map produces
 * the same HAP service graph that v1.6.0 produced for the same
 * AWN key. See tests/unit/sensorMap/*.test.ts for the property-driven
 * checks that enforce this.
 *
 * Layout:
 *   1. Static rows (41 entries) — one per named AWN datapoint the
 *      plugin knows the shape of.
 *   2. Numbered-probe rows (28 entries) — generated for the WH31
 *      channel probes: temp{1..10}f, humidity{1..10},
 *      feelsLike{1..4}, dewPoint{1..4}.
 *
 * Batteries: `canonicalForBattery: true` marks the one row per
 * batteryField that hosts the Battery sub-service in HomeKit.
 * Non-canonical rows keep the batteryField for row identity but
 * do NOT get a sub-service — see docs §11 and batteryFields.ts.
 */
import type { DefaultSensorRow } from './types.js';
export declare const DEFAULT_SENSOR_MAP: ReadonlyArray<DefaultSensorRow>;
/**
 * O(1) lookup by dataPoint. Built lazily on first access so tests
 * can validate the array shape before the index is constructed.
 */
/**
 * The LEGACY field-shape matchers, in the exact order and with the
 * exact predicates of v1.7's `determineSensorType` (GA review P1-1 /
 * issue #63 Option A): one shared acceptance source of truth, so the
 * v2 recognizer cannot drift from what the legacy runtime registers.
 * `determineSensorType` consumes this list for its value-tile half;
 * `defaultRowFor` synthesizes rows from it for fields outside the
 * static table. Extended sensors (wind/rain/pressure/uv/lightning)
 * match by exact name and are fully covered by the static table.
 *
 * Scope note: real AWN vocabulary has no key matching two families at
 * once, so first-match identity is well-defined; a hypothetical
 * multi-family key would follow this order, as v1.7 does with all
 * category toggles on.
 */
export declare const LEGACY_FIELD_MATCHERS: ReadonlyArray<{
    kind: DefaultSensorRow['kind'];
    legacyType: string;
    test: (dataPoint: string) => boolean;
}>;
/**
 * Whether an authored override carries EXPLICIT identity intent: any
 * presence of kind, measurement, or sourceUnit — wrong-typed and null
 * values included, because an invalid explicit assignment must surface
 * as a diagnostic, never be silently replaced by a guess (#63 P0).
 */
export declare function hasAuthoredIdentity(override: unknown): boolean;
/**
 * The default row RESOLUTION may consult for a dataPoint given the
 * authored override layers that apply to it (#63 P0 — authored
 * identities must win): the static catalog always applies (explicit
 * identity against it stays the long-standing diagnosed conflict);
 * the dynamic legacy-compatibility fallback applies ONLY when no
 * passed layer authors identity. An explicitly assigned name that the
 * fallback also recognizes therefore resolves exactly as it did
 * before the fallback existed — the assignment is authoritative.
 */
export declare function defaultRowForOverride(dataPoint: string, ...overrideLayers: ReadonlyArray<unknown>): DefaultSensorRow | undefined;
/** The STATIC table lookup only — no dynamic fallback. */
export declare function staticDefaultRowFor(dataPoint: string): DefaultSensorRow | undefined;
/** Dynamic compatibility defaults and their value-equivalent anchored definitions. */
export declare function isCompatibilityDefinition(row: DefaultSensorRow | undefined): boolean;
export declare function defaultRowFor(dataPoint: string): DefaultSensorRow | undefined;
/**
 * The catalog-v2 definitions (§18.3, issue #63 P2). Materialized after
 * SYNTH_SHAPE exists (module init order); see makeCatalogV2Rows for
 * the exposure classes.
 */
export declare const CATALOG_V2_ROWS: ReadonlyArray<DefaultSensorRow>;
export declare const CATALOG_V3_ROWS: ReadonlyArray<DefaultSensorRow>;
/** Every catalog-versioned definition, all versions (§18.3/§19.5). */
export declare const VERSIONED_CATALOG_ROWS: ReadonlyArray<DefaultSensorRow>;
/**
 * A later-catalog definition for `dataPoint`, when the config's
 * `catalogAdopted` covers it. Never consulted for authored identities
 * (§18.4 AP-1/AP-2 — the callers gate on authorship first).
 */
export declare function catalogRowFor(dataPoint: string, catalogAdopted: number): DefaultSensorRow | undefined;
/**
 * Stamp-aware default resolution for a dataPoint given the authored
 * override layers that apply to it (§18.3 + §18.4 AP-2, generalizing
 * the P0 rule): the v1 static table always applies; ANY authored
 * identity — complete, partial, valid, or rejected — blocks both the
 * later-catalog definitions and the dynamic fallback in its scope, so
 * an explicit assignment (or a diagnosed attempt at one) is never
 * answered with a substituted default; otherwise adopted definitions
 * resolve before the fallback (anchored ones identically to it).
 */
export declare function defaultRowForConfigOverride(dataPoint: string, catalogAdopted: number, ...overrideLayers: ReadonlyArray<unknown>): DefaultSensorRow | undefined;
/**
 * The default `enabled` value a default row contributes under a
 * config's stamps (§18.3 exposure arithmetic): a NEW-exposure
 * definition that arrived after the config's baseline is DISABLED,
 * unconditionally. Everywhere else the entry's own `defaultEnabled`
 * decides (absent = enabled) — v1 baseline and anchored rows carry no
 * value and stay enabled, while all six current new-exposure
 * definitions deliberately declare false, so they are off even on
 * installs born knowing them.
 */
export declare function defaultEnabledFor(row: DefaultSensorRow, catalogBaseline: number): boolean;
//# sourceMappingURL=defaultMap.d.ts.map
/**
 * Unit vocabulary — labels, ordering, and UI applicability for every
 * legal sensor unit (GA task #70: match AmbientWeather.net's own
 * unit-selection UX).
 *
 * DIVISION OF AUTHORITY (deliberate, reviewer-mandated):
 *   - `LEGAL_UNITS_FOR_MEASUREMENT` (units.ts) remains the SINGLE
 *     validation authority: whether a unit is legal for a measurement
 *     is decided there and only there.
 *   - THIS module supplies presentation and selection metadata on top:
 *     the label each unit shows, the order options appear in, and the
 *     CONTEXTS in which a unit may be offered. It must never disagree
 *     with the legal sets — a bijection test (unitVocabulary.test.ts)
 *     fails the build on any missing, extra, duplicate, or reordered
 *     entry.
 *
 * SELECTION CONTEXTS. A unit can be offered in at most two places:
 *   - `selectableAsCustomSourceUnit`: the unit a CUSTOM row may declare
 *     its AWN payload reports in (§3.4). Known datapoints have their
 *     sourceUnit fixed by the default map.
 *   - `selectableAsExtendedDisplayUnit`: a displayUnit choice on
 *     extended (motion-family) wrappers, which render readings as a
 *     custom string. NATIVE HAP measurements (temperature, humidity,
 *     illuminance, co2/co, pm25/pm10) are NEVER display-selectable:
 *     their wrappers write the canonical value into a fixed-unit
 *     HomeKit characteristic (CurrentTemperature = °C rendered per
 *     client locale, CurrentAmbientLightLevel = lux, ...), and
 *     validation warn-and-strips displayUnit on them
 *     (`ignored-native-displayunit`). No third context exists.
 *
 * The config-schema `units` fieldset cannot import TypeScript, so its
 * options are pinned by an exact parity test against
 * `LEGACY_SCHEMA_UNIT_EXPOSURE` below (ids, titles, AND ordering) —
 * the schema can only drift loudly.
 */
import type { Measurement, SensorUnit } from './types.js';
export interface UnitOption {
    unit: SensorUnit;
    /**
     * Presentation label. Matches AmbientWeather.net's own label wherever
     * AWN offers the unit (see AWN_UNITS_PAGE below); plugin-only units
     * (fc, nm, ...) use conventional abbreviations.
     */
    label: string;
    selectableAsCustomSourceUnit: boolean;
    selectableAsExtendedDisplayUnit: boolean;
}
/**
 * Ordered vocabulary per measurement. Order is meaningful: it is the
 * order pickers present options in, and it matches AWN's units page
 * where the category exists there. The bijection test asserts the
 * `unit` ids here equal `LEGAL_UNITS_FOR_MEASUREMENT[m]` exactly,
 * including order and uniqueness.
 */
export declare const UNIT_VOCABULARY: Readonly<Record<Measurement, ReadonlyArray<UnitOption>>>;
export type UnitSelectionContext = 'custom-source' | 'extended-display';
/** Ordered options for a measurement, filtered to a selection context. */
export declare function unitOptionsFor(measurement: Measurement, context: UnitSelectionContext): ReadonlyArray<UnitOption>;
/**
 * The observed AmbientWeather.net units page — the auditable reference
 * "matches AWN" is measured against. Every AWN category and option is
 * classified rather than silently omitted:
 *   - supported:                maps to displayUnit choices this plugin offers
 *   - client-controlled-display: the HomeKit CLIENT owns the display
 *                                rendering (fixed-unit HAP characteristic);
 *                                the units remain custom-row source choices
 *   - deferred:                 no corresponding measurement in the plugin yet
 *   - not-applicable:           no equivalent concept in this plugin
 * (A 'bucket-only' classification is reserved for scales like Beaufort —
 * see notes — which surface via the Intensity characteristic, not units.)
 */
export declare const AWN_UNITS_PAGE: {
    readonly observedAt: "2026-08-18";
    readonly awnVersion: "v4.19.9";
    readonly source: "https://ambientweather.net/account/units";
    readonly categories: readonly [{
        readonly awnCategory: "Temperature";
        readonly awnOptions: readonly ["°F", "°C"];
        readonly classification: "client-controlled-display";
        readonly mapping: string;
    }, {
        readonly awnCategory: "Barometer";
        readonly awnOptions: readonly ["inHg", "mmHg", "hPa"];
        readonly classification: "supported";
        readonly mapping: "measurement pressure, displayUnit inHg | mmHg | hPa (mmHg added for AWN parity).";
    }, {
        readonly awnCategory: "Wind Speed";
        readonly awnOptions: readonly ["mph", "ft/sec", "m/sec", "km/hr", "knots"];
        readonly classification: "supported";
        readonly mapping: "measurement wind-speed, displayUnit mph | fps | mps | kph | kts (fps added for AWN parity).";
    }, {
        readonly awnCategory: "Rainfall";
        readonly awnOptions: readonly ["in/hr", "mm/hr"];
        readonly classification: "supported";
        readonly mapping: string;
    }, {
        readonly awnCategory: "Solar Radiation";
        readonly awnOptions: readonly ["W/m^2", "lux"];
        readonly classification: "client-controlled-display";
        readonly mapping: string;
    }, {
        readonly awnCategory: "Soil Moisture";
        readonly awnOptions: readonly ["%", "index"];
        readonly classification: "deferred";
        readonly mapping: string;
    }, {
        readonly awnCategory: "Time Format";
        readonly awnOptions: readonly ["12hr", "24hr"];
        readonly classification: "not-applicable";
        readonly mapping: string;
    }, {
        readonly awnCategory: "Distance";
        readonly awnOptions: readonly ["imperial", "metric"];
        readonly classification: "supported";
        readonly mapping: "measurement distance: imperial → mi, metric → km; nm is a plugin extra beyond AWN.";
    }];
    readonly notes: readonly [string, string];
};
/**
 * One selectable option of a display family: a single user choice
 * that sets the display unit of EVERY measurement the family spans
 * (AWN's Rainfall toggle sets in/hr for rain-rate AND in for
 * rain-accumulation in one gesture).
 */
export interface DisplayFamilyChoice {
    /** Stable choice id (unique within the family). */
    id: string;
    /** Presentation label, matching AWN's wording where AWN offers it. */
    label: string;
    /** displayUnit this choice sets, per measurement of the family. */
    units: Readonly<Partial<Record<Measurement, SensorUnit>>>;
}
export interface DisplayFamily {
    /** Stable family key. */
    key: string;
    /** Presentation label (AWN units-page category name where one exists). */
    label: string;
    /** Every measurement this family governs. */
    measurements: ReadonlyArray<Measurement>;
    choices: ReadonlyArray<DisplayFamilyChoice>;
}
/**
 * The display families the editor's Units panel offers (GA task #70
 * editor layer). CANONICAL: this list owns which families exist,
 * their labels, their ordering (AWN units-page order for categories
 * AWN has; the nm plugin extra appended within Distance), and which
 * measurements each choice spans. Only families with at least two
 * choices belong here — a one-option dropdown is not a preference
 * (PR #53 review F4). unitVocabulary.test.ts pins:
 *   - every choice unit is extended-display-selectable for its
 *     measurement in UNIT_VOCABULARY;
 *   - every measurement with two or more extended-display options is
 *     governed by exactly one family (completeness — a new unit
 *     cannot silently bypass the panel);
 *   - each family's choices cover its measurements exhaustively.
 */
export declare const DISPLAY_FAMILIES: ReadonlyArray<DisplayFamily>;
/**
 * Exact projection of the config-schema `units` fieldset as it ships
 * TODAY (legacy extended-sensor controls; v1.7-compatible option sets).
 * The schema cannot import this module, so unitVocabulary.test.ts pins
 * schema ids, titles, and ordering against this projection — any drift
 * in either direction fails the build.
 *
 * DELIBERATELY EXCLUDED from legacy exposure (do not add here without
 * a design round):
 *   - mmHg / fps: v2-only units. The flag-off wrappers read
 *     `config.units.*` directly (e.g. pressureAccessory) and would
 *     mislabel values for units their converters predate; new units
 *     reach users only through v2 rows (and later the row editor).
 *   - temperature / solar categories: native HAP display is
 *     client-controlled; a legacy global knob would be a no-op or a
 *     lie (see validation.ts `ignored-native-displayunit`).
 */
export declare const LEGACY_SCHEMA_UNIT_EXPOSURE: Readonly<Record<string, {
    measurement: Measurement;
    title: string;
    default: SensorUnit;
    options: ReadonlyArray<{
        unit: SensorUnit;
        title: string;
    }>;
}>>;
/**
 * Units a v1.7.x installation understands, per legacy `units.*` key.
 * The legacy mirror (legacyMirror.ts) may only project display units
 * from THIS set into a rollback config: a v2-only unit (mmHg, fps)
 * written into `units.*` would make 1.7's converters mislabel values
 * (they predate the unit and fall back to the AWN-native conversion
 * while the formatter prints the new unit's name — a silent 25.4×-class
 * error). Omitting the key instead makes 1.7 fall back to its default
 * display unit: a display-only fallback, never accessory loss.
 */
export declare const V17_LEGAL_LEGACY_UNITS: Readonly<Record<'windSpeed' | 'rain' | 'pressure' | 'distance', ReadonlyArray<SensorUnit>>>;
//# sourceMappingURL=unitVocabulary.d.ts.map
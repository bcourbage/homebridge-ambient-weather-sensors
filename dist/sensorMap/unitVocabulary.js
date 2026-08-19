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
/**
 * Ordered vocabulary per measurement. Order is meaningful: it is the
 * order pickers present options in, and it matches AWN's units page
 * where the category exists there. The bijection test asserts the
 * `unit` ids here equal `LEGAL_UNITS_FOR_MEASUREMENT[m]` exactly,
 * including order and uniqueness.
 */
export const UNIT_VOCABULARY = {
    temperature: [
        // Native HAP display (client locale renders °F/°C); source-selectable only.
        { unit: 'fahrenheit', label: '°F', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
        { unit: 'celsius', label: '°C', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    humidity: [
        { unit: 'percent', label: '%', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    illuminance: [
        // Native HAP display (CurrentAmbientLightLevel is fixed to lux);
        // source-selectable only. fc is device-console vocabulary — not on
        // the AWN site — kept as a custom-row source choice.
        { unit: 'wm2', label: 'W/m^2', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
        { unit: 'lux', label: 'lux', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
        { unit: 'fc', label: 'fc', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    co2: [
        { unit: 'ppm', label: 'ppm', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    co: [
        { unit: 'ppm', label: 'ppm', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    pm25: [
        { unit: 'ugm3', label: 'µg/m³', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    pm10: [
        { unit: 'ugm3', label: 'µg/m³', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: false },
    ],
    // AWN order: mph, ft/sec, m/sec, km/hr, knots.
    'wind-speed': [
        { unit: 'mph', label: 'mph', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'fps', label: 'ft/sec', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'mps', label: 'm/sec', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'kph', label: 'km/hr', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'kts', label: 'knots', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    // AWN's single Rainfall toggle (in/hr, mm/hr) covers BOTH rain
    // measurements: rate carries the /hr labels, accumulation the bases.
    'rain-rate': [
        { unit: 'in_per_hr', label: 'in/hr', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'mm_per_hr', label: 'mm/hr', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    'rain-accumulation': [
        { unit: 'in', label: 'in', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'mm', label: 'mm', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    // AWN order: inHg, mmHg, hPa.
    pressure: [
        { unit: 'inHg', label: 'inHg', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'mmHg', label: 'mmHg', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'hPa', label: 'hPa', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    // AWN groups distance as imperial/metric; per-unit this is mi/km,
    // with nm a plugin extra beyond AWN.
    distance: [
        { unit: 'mi', label: 'mi', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'km', label: 'km', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
        { unit: 'nm', label: 'nm', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    'uv-index': [
        { unit: 'index', label: 'index', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    count: [
        { unit: 'count', label: 'count', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    direction: [
        { unit: 'degrees', label: '°', selectableAsCustomSourceUnit: true, selectableAsExtendedDisplayUnit: true },
    ],
    timestamp: [
        // sourceUnit is FIXED to 'ms' by contract (§3.4) — present in the
        // vocabulary for bijection completeness, never user-selectable.
        { unit: 'ms', label: 'ms', selectableAsCustomSourceUnit: false, selectableAsExtendedDisplayUnit: false },
    ],
    boolean: [],
};
/** Ordered options for a measurement, filtered to a selection context. */
export function unitOptionsFor(measurement, context) {
    return UNIT_VOCABULARY[measurement].filter(o => context === 'custom-source' ? o.selectableAsCustomSourceUnit : o.selectableAsExtendedDisplayUnit);
}
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
export const AWN_UNITS_PAGE = {
    observedAt: '2026-08-18',
    awnVersion: 'v4.19.9',
    source: 'https://ambientweather.net/account/units',
    categories: [
        {
            awnCategory: 'Temperature', awnOptions: ['°F', '°C'],
            classification: 'client-controlled-display',
            mapping: 'measurement temperature. CurrentTemperature is °C on the wire; '
                + 'HomeKit clients render per device locale. fahrenheit/celsius stay '
                + 'selectable as custom-row source units.',
        },
        {
            awnCategory: 'Barometer', awnOptions: ['inHg', 'mmHg', 'hPa'],
            classification: 'supported',
            mapping: 'measurement pressure, displayUnit inHg | mmHg | hPa (mmHg added for AWN parity).',
        },
        {
            awnCategory: 'Wind Speed', awnOptions: ['mph', 'ft/sec', 'm/sec', 'km/hr', 'knots'],
            classification: 'supported',
            mapping: 'measurement wind-speed, displayUnit mph | fps | mps | kph | kts (fps added for AWN parity).',
        },
        {
            awnCategory: 'Rainfall', awnOptions: ['in/hr', 'mm/hr'],
            classification: 'supported',
            mapping: 'one AWN toggle spans two measurements: rain-rate (in_per_hr | mm_per_hr) '
                + 'and rain-accumulation (in | mm).',
        },
        {
            awnCategory: 'Solar Radiation', awnOptions: ['W/m^2', 'lux'],
            classification: 'client-controlled-display',
            mapping: 'measurement illuminance. CurrentAmbientLightLevel is fixed to lux; '
                + 'wm2/lux (and plugin-extra fc) stay selectable as custom-row source units.',
        },
        {
            awnCategory: 'Soil Moisture', awnOptions: ['%', 'index'],
            classification: 'deferred',
            mapping: 'no soil-moisture measurement exists in the plugin yet; AWN soil fields '
                + 'surface as unrecognized rows until one is added.',
        },
        {
            awnCategory: 'Time Format', awnOptions: ['12hr', '24hr'],
            classification: 'not-applicable',
            mapping: 'timestamp rows render as relative time ("time since"); absolute clock '
                + 'format is a HomeKit-client concern.',
        },
        {
            awnCategory: 'Distance', awnOptions: ['imperial', 'metric'],
            classification: 'supported',
            mapping: 'measurement distance: imperial → mi, metric → km; nm is a plugin extra beyond AWN.',
        },
    ],
    notes: [
        'Beaufort: offered on some Ambient device consoles, NOT on the AWN site page. '
            + 'It is a classification scale, not a unit — this plugin surfaces it through the '
            + "extended wind wrappers' Intensity characteristic (bucket-only), never as a displayUnit.",
        'fc (foot-candles): device-console vocabulary, not on the AWN site page. Kept as a '
            + 'custom-row SOURCE unit only (lux = fc × 10.7639104167); never a display selection.',
    ],
};
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
export const LEGACY_SCHEMA_UNIT_EXPOSURE = {
    windSpeed: {
        measurement: 'wind-speed',
        title: 'Wind speed',
        default: 'mph',
        options: [
            { unit: 'mph', title: 'mph (miles per hour)' },
            { unit: 'kph', title: 'kph (kilometers per hour)' },
            { unit: 'mps', title: 'm/s (meters per second)' },
            { unit: 'kts', title: 'kts (knots)' },
        ],
    },
    rain: {
        measurement: 'rain-accumulation',
        title: 'Rain',
        default: 'in',
        options: [
            { unit: 'in', title: 'in (inches)' },
            { unit: 'mm', title: 'mm (millimeters)' },
        ],
    },
    pressure: {
        measurement: 'pressure',
        title: 'Barometric pressure',
        default: 'inHg',
        options: [
            { unit: 'inHg', title: 'inHg (inches of mercury)' },
            { unit: 'hPa', title: 'hPa (hectopascals, same as millibars)' },
        ],
    },
    distance: {
        measurement: 'distance',
        title: 'Lightning distance',
        default: 'mi',
        options: [
            { unit: 'mi', title: 'mi (statute miles)' },
            { unit: 'km', title: 'km (kilometers)' },
            { unit: 'nm', title: 'nm (nautical miles)' },
        ],
    },
};
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
export const V17_LEGAL_LEGACY_UNITS = {
    windSpeed: ['mph', 'kph', 'mps', 'kts'],
    rain: ['in', 'mm'],
    pressure: ['inHg', 'hPa'],
    distance: ['mi', 'km', 'nm'],
};
//# sourceMappingURL=unitVocabulary.js.map
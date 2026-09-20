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
import { batteryFieldForSensor, isCanonicalSensorForBattery } from '../batteryFields.js';
import { friendlySensorName } from '../sensorNames.js';
import { TEMPERATURE_WRAPPER, HUMIDITY_WRAPPER, SOLAR_RADIATION_WRAPPER, CO2_WRAPPER, AIR_QUALITY_PM25_WRAPPER, AIR_QUALITY_PM10_WRAPPER, UV_WRAPPER, WIND_SPEED_WRAPPER, WIND_GUST_WRAPPER, WIND_MAX_DAILY_GUST_WRAPPER, WIND_DIRECTION_WRAPPER, WIND_DIRECTION_10M_WRAPPER, PRESSURE_RELATIVE_WRAPPER, PRESSURE_ABSOLUTE_WRAPPER, RAIN_RATE_WRAPPER, RAIN_EVENT_WRAPPER, RAIN_DAILY_WRAPPER, RAIN_WEEKLY_WRAPPER, RAIN_MONTHLY_WRAPPER, RAIN_YEARLY_WRAPPER, LAST_RAIN_WRAPPER, LIGHTNING_DAY_WRAPPER, LIGHTNING_HOUR_WRAPPER, LIGHTNING_DISTANCE_WRAPPER, LIGHTNING_LAST_STRIKE_WRAPPER, } from './wrappers.js';
const STATIC_ROWS = [
    // Outdoor combo array — battout, canonical row is tempf
    {
        dataPoint: 'tempf',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'Outdoor Temperature',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'battout',
        canonicalForBattery: true,
    },
    {
        dataPoint: 'humidity',
        kind: 'humidity',
        measurement: 'humidity',
        wrapper: HUMIDITY_WRAPPER,
        name: 'Outdoor Humidity',
        sourceUnit: 'percent',
        displayUnit: 'percent',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'feelsLike',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'Outdoor Feels Like',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'dewPoint',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'Outdoor Dew Point',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'solarradiation',
        kind: 'light',
        measurement: 'illuminance',
        wrapper: SOLAR_RADIATION_WRAPPER,
        name: 'Solar Radiation',
        sourceUnit: 'wm2',
        displayUnit: 'lux',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'uv',
        kind: 'motion',
        measurement: 'uv-index',
        wrapper: UV_WRAPPER,
        name: 'UV Index',
        sourceUnit: 'index',
        displayUnit: 'index',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'windspeedmph',
        kind: 'motion',
        measurement: 'wind-speed',
        wrapper: WIND_SPEED_WRAPPER,
        name: 'Wind Speed',
        sourceUnit: 'mph',
        displayUnit: 'mph',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'windgustmph',
        kind: 'motion',
        measurement: 'wind-speed',
        wrapper: WIND_GUST_WRAPPER,
        name: 'Wind Gust',
        sourceUnit: 'mph',
        displayUnit: 'mph',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'maxdailygust',
        kind: 'motion',
        measurement: 'wind-speed',
        wrapper: WIND_MAX_DAILY_GUST_WRAPPER,
        name: 'Max Daily Gust',
        sourceUnit: 'mph',
        displayUnit: 'mph',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'winddir',
        kind: 'motion',
        measurement: 'direction',
        wrapper: WIND_DIRECTION_WRAPPER,
        name: 'Wind Direction',
        sourceUnit: 'degrees',
        displayUnit: 'degrees',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'winddir_avg10m',
        kind: 'motion',
        measurement: 'direction',
        wrapper: WIND_DIRECTION_10M_WRAPPER,
        name: 'Wind Direction 10m Avg',
        sourceUnit: 'degrees',
        displayUnit: 'degrees',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'hourlyrainin',
        kind: 'motion',
        measurement: 'rain-rate',
        wrapper: RAIN_RATE_WRAPPER,
        name: 'Rain Rate',
        sourceUnit: 'in_per_hr',
        displayUnit: 'in_per_hr',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'eventrainin',
        kind: 'motion',
        measurement: 'rain-accumulation',
        threshold: 0.01,
        wrapper: RAIN_EVENT_WRAPPER,
        name: 'Rain Event',
        sourceUnit: 'in',
        displayUnit: 'in',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'dailyrainin',
        kind: 'motion',
        measurement: 'rain-accumulation',
        threshold: 0.01,
        wrapper: RAIN_DAILY_WRAPPER,
        name: 'Rain Daily',
        sourceUnit: 'in',
        displayUnit: 'in',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'weeklyrainin',
        kind: 'motion',
        measurement: 'rain-accumulation',
        threshold: 0.01,
        wrapper: RAIN_WEEKLY_WRAPPER,
        name: 'Rain Weekly',
        sourceUnit: 'in',
        displayUnit: 'in',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'monthlyrainin',
        kind: 'motion',
        measurement: 'rain-accumulation',
        threshold: 0.01,
        wrapper: RAIN_MONTHLY_WRAPPER,
        name: 'Rain Monthly',
        sourceUnit: 'in',
        displayUnit: 'in',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'yearlyrainin',
        kind: 'motion',
        measurement: 'rain-accumulation',
        threshold: 0.01,
        wrapper: RAIN_YEARLY_WRAPPER,
        name: 'Rain Yearly',
        sourceUnit: 'in',
        displayUnit: 'in',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'lastRain',
        kind: 'motion',
        measurement: 'timestamp',
        wrapper: LAST_RAIN_WRAPPER,
        name: 'Last Rain',
        sourceUnit: 'ms',
        displayUnit: 'ms',
        batteryField: 'battout',
        canonicalForBattery: false,
    },
    // Indoor display console — battin, canonical row is tempinf
    {
        dataPoint: 'tempinf',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'Indoor Temperature',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'battin',
        canonicalForBattery: true,
    },
    {
        dataPoint: 'humidityin',
        kind: 'humidity',
        measurement: 'humidity',
        wrapper: HUMIDITY_WRAPPER,
        name: 'Indoor Humidity',
        sourceUnit: 'percent',
        displayUnit: 'percent',
        batteryField: 'battin',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'feelsLikein',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'Indoor Feels Like',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'battin',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'dewPointin',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'Indoor Dew Point',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'battin',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'baromrelin',
        kind: 'motion',
        measurement: 'pressure',
        triggerDirection: 'below',
        wrapper: PRESSURE_RELATIVE_WRAPPER,
        name: 'Pressure (Sea Level)',
        sourceUnit: 'inHg',
        displayUnit: 'inHg',
        batteryField: 'battin',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'baromabsin',
        kind: 'motion',
        measurement: 'pressure',
        triggerDirection: 'below',
        wrapper: PRESSURE_ABSOLUTE_WRAPPER,
        name: 'Pressure (Station)',
        sourceUnit: 'inHg',
        displayUnit: 'inHg',
        batteryField: 'battin',
        canonicalForBattery: false,
    },
    // AQIN module — batt_co2, canonical row is co2_in_aqin
    {
        dataPoint: 'co2',
        kind: 'co2',
        measurement: 'co2',
        wrapper: CO2_WRAPPER,
        name: 'CO2',
        sourceUnit: 'ppm',
        displayUnit: 'ppm',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        // `co2_in` (no `_aqin` suffix) doesn't match any battery rule in
        // batteryFields.ts. Preserve v1.6.0 behavior: no battery sub-service.
        dataPoint: 'co2_in',
        kind: 'co2',
        measurement: 'co2',
        wrapper: CO2_WRAPPER,
        name: 'Indoor CO2',
        sourceUnit: 'ppm',
        displayUnit: 'ppm',
        batteryField: null,
        canonicalForBattery: false,
    },
    {
        dataPoint: 'co2_in_aqin',
        kind: 'co2',
        measurement: 'co2',
        wrapper: CO2_WRAPPER,
        name: 'Indoor CO2',
        sourceUnit: 'ppm',
        displayUnit: 'ppm',
        batteryField: 'batt_co2',
        canonicalForBattery: true,
    },
    {
        dataPoint: 'co2_in_24h_aqin',
        kind: 'co2',
        measurement: 'co2',
        wrapper: CO2_WRAPPER,
        name: 'Indoor CO2 24h Average',
        sourceUnit: 'ppm',
        displayUnit: 'ppm',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        // pm25 is the outdoor PM2.5 sensor. batteryField undefined per
        // batteryFields.ts (WH41 outdoor battery convention TBD).
        dataPoint: 'pm25',
        kind: 'air-quality-pm25',
        measurement: 'pm25',
        wrapper: AIR_QUALITY_PM25_WRAPPER,
        name: 'Outdoor PM2.5',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: null,
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm25_24h',
        kind: 'air-quality-pm25',
        measurement: 'pm25',
        wrapper: AIR_QUALITY_PM25_WRAPPER,
        name: 'Outdoor PM2.5 24h Average',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: null,
        canonicalForBattery: false,
    },
    {
        // `pm25_in` (no `_aqin` suffix) doesn't match any battery rule in
        // batteryFields.ts — its physical source is ambiguous across AWN
        // firmwares. Preserve v1.6.0 behavior: no battery sub-service.
        dataPoint: 'pm25_in',
        kind: 'air-quality-pm25',
        measurement: 'pm25',
        wrapper: AIR_QUALITY_PM25_WRAPPER,
        name: 'Indoor PM2.5',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: null,
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm25_in_aqin',
        kind: 'air-quality-pm25',
        measurement: 'pm25',
        wrapper: AIR_QUALITY_PM25_WRAPPER,
        name: 'Indoor PM2.5',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm25_in_24h_aqin',
        kind: 'air-quality-pm25',
        measurement: 'pm25',
        wrapper: AIR_QUALITY_PM25_WRAPPER,
        name: 'Indoor PM2.5 24h Average',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm10_in_aqin',
        kind: 'air-quality-pm10',
        measurement: 'pm10',
        wrapper: AIR_QUALITY_PM10_WRAPPER,
        name: 'Indoor PM10',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm10_in_24h_aqin',
        kind: 'air-quality-pm10',
        measurement: 'pm10',
        wrapper: AIR_QUALITY_PM10_WRAPPER,
        name: 'Indoor PM10 24h Average',
        sourceUnit: 'ugm3',
        displayUnit: 'ugm3',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm_in_temp_aqin',
        kind: 'temperature',
        measurement: 'temperature',
        wrapper: TEMPERATURE_WRAPPER,
        name: 'AQIN Temperature',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'pm_in_humidity_aqin',
        kind: 'humidity',
        measurement: 'humidity',
        wrapper: HUMIDITY_WRAPPER,
        name: 'AQIN Humidity',
        sourceUnit: 'percent',
        displayUnit: 'percent',
        batteryField: 'batt_co2',
        canonicalForBattery: false,
    },
    // WH31L lightning sensor — batt_lightning, canonical row is lightning_day
    {
        dataPoint: 'lightning_day',
        kind: 'motion',
        measurement: 'count',
        threshold: 1,
        wrapper: LIGHTNING_DAY_WRAPPER,
        name: 'Lightning Strikes Today',
        sourceUnit: 'count',
        displayUnit: 'count',
        batteryField: 'batt_lightning',
        canonicalForBattery: true,
    },
    {
        dataPoint: 'lightning_hour',
        kind: 'motion',
        measurement: 'count',
        threshold: 1,
        wrapper: LIGHTNING_HOUR_WRAPPER,
        name: 'Lightning Strikes This Hour',
        sourceUnit: 'count',
        displayUnit: 'count',
        batteryField: 'batt_lightning',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'lightning_distance',
        kind: 'motion',
        measurement: 'distance',
        triggerDirection: 'below',
        wrapper: LIGHTNING_DISTANCE_WRAPPER,
        name: 'Lightning Distance',
        sourceUnit: 'mi',
        displayUnit: 'mi',
        batteryField: 'batt_lightning',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'lightning_time',
        kind: 'motion',
        measurement: 'timestamp',
        wrapper: LIGHTNING_LAST_STRIKE_WRAPPER,
        name: 'Last Lightning Strike',
        sourceUnit: 'ms',
        displayUnit: 'ms',
        batteryField: 'batt_lightning',
        canonicalForBattery: false,
    },
];
/*
 * Numbered-probe rows — WH31 channel probes 1..10. Each channel
 * has its own battN battery field; the canonical row per channel
 * is temp{N}f, matching CANONICAL_SENSOR_FOR_BATTERY in
 * batteryFields.ts.
 *
 * humidity{N}, feelsLike{N} (1..4 only per AWN payload shape),
 * dewPoint{N} (1..4 only) carry the same batteryField but are
 * NOT canonical.
 */
function makeNumberedRows() {
    const rows = [];
    for (let n = 1; n <= 10; n++) {
        rows.push({
            dataPoint: `temp${n}f`,
            kind: 'temperature',
            measurement: 'temperature',
            wrapper: TEMPERATURE_WRAPPER,
            name: `Temperature ${n}`,
            sourceUnit: 'fahrenheit',
            displayUnit: 'fahrenheit',
            batteryField: `batt${n}`,
            canonicalForBattery: true,
        });
        rows.push({
            dataPoint: `humidity${n}`,
            kind: 'humidity',
            measurement: 'humidity',
            wrapper: HUMIDITY_WRAPPER,
            name: `Humidity ${n}`,
            sourceUnit: 'percent',
            displayUnit: 'percent',
            batteryField: `batt${n}`,
            canonicalForBattery: false,
        });
    }
    for (let n = 1; n <= 4; n++) {
        rows.push({
            dataPoint: `feelsLike${n}`,
            kind: 'temperature',
            measurement: 'temperature',
            wrapper: TEMPERATURE_WRAPPER,
            name: `Feels Like ${n}`,
            sourceUnit: 'fahrenheit',
            displayUnit: 'fahrenheit',
            batteryField: `batt${n}`,
            canonicalForBattery: false,
        });
        rows.push({
            dataPoint: `dewPoint${n}`,
            kind: 'temperature',
            measurement: 'temperature',
            wrapper: TEMPERATURE_WRAPPER,
            name: `Dew Point ${n}`,
            sourceUnit: 'fahrenheit',
            displayUnit: 'fahrenheit',
            batteryField: `batt${n}`,
            canonicalForBattery: false,
        });
    }
    return rows;
}
export const DEFAULT_SENSOR_MAP = [
    ...STATIC_ROWS,
    ...makeNumberedRows(),
];
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
export const LEGACY_FIELD_MATCHERS = [
    {
        kind: 'temperature', legacyType: 'Temperature',
        test: dp => dp.includes('temp') || dp.includes('feelsLike') || dp.includes('dewPoint'),
    },
    { kind: 'humidity', legacyType: 'Humidity', test: dp => dp.includes('humid') },
    { kind: 'light', legacyType: 'Solar Radiation', test: dp => dp.includes('solar') },
    { kind: 'co2', legacyType: 'CO2', test: dp => /^co2($|_)/.test(dp) },
    { kind: 'air-quality-pm25', legacyType: 'PM2.5', test: dp => /^pm25($|_)/.test(dp) },
    { kind: 'air-quality-pm10', legacyType: 'PM10', test: dp => /^pm10($|_)/.test(dp) },
];
/** Row-shape ingredients per legacy-matched kind. */
const SYNTH_SHAPE = {
    'temperature': { kind: 'temperature', measurement: 'temperature', wrapper: TEMPERATURE_WRAPPER, sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit' },
    'humidity': { kind: 'humidity', measurement: 'humidity', wrapper: HUMIDITY_WRAPPER, sourceUnit: 'percent', displayUnit: 'percent' },
    'light': { kind: 'light', measurement: 'illuminance', wrapper: SOLAR_RADIATION_WRAPPER, sourceUnit: 'wm2', displayUnit: 'lux' },
    'co2': { kind: 'co2', measurement: 'co2', wrapper: CO2_WRAPPER, sourceUnit: 'ppm', displayUnit: 'ppm' },
    'air-quality-pm25': { kind: 'air-quality-pm25', measurement: 'pm25', wrapper: AIR_QUALITY_PM25_WRAPPER, sourceUnit: 'ugm3', displayUnit: 'ugm3' },
    'air-quality-pm10': { kind: 'air-quality-pm10', measurement: 'pm10', wrapper: AIR_QUALITY_PM10_WRAPPER, sourceUnit: 'ugm3', displayUnit: 'ugm3' },
};
/**
 * Synthesize the default row for a field the legacy matcher accepts
 * but the static table lacks (a WH31 channel beyond the table's
 * range, a soil-probe temperature, any future AWN field a substring
 * family covers). Name, battery field, and battery canonicality come
 * from the SAME legacy functions the v1.7 runtime uses, so the
 * synthesized row registers exactly what v1.7 registers.
 */
function synthesizeLegacyRow(dataPoint) {
    const match = LEGACY_FIELD_MATCHERS.find(m => m.test(dataPoint));
    if (!match) {
        return undefined;
    }
    const battery = batteryFieldForSensor(dataPoint) ?? null;
    return {
        dataPoint,
        ...SYNTH_SHAPE[match.kind],
        name: friendlySensorName(dataPoint),
        batteryField: battery,
        canonicalForBattery: battery !== null && isCanonicalSensorForBattery(dataPoint, battery),
    };
}
/**
 * Whether an authored override carries EXPLICIT identity intent: any
 * presence of kind, measurement, or sourceUnit — wrong-typed and null
 * values included, because an invalid explicit assignment must surface
 * as a diagnostic, never be silently replaced by a guess (#63 P0).
 */
export function hasAuthoredIdentity(override) {
    return !!override && typeof override === 'object'
        && ('kind' in override || 'measurement' in override || 'sourceUnit' in override);
}
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
export function defaultRowForOverride(dataPoint, ...overrideLayers) {
    const staticRow = staticDefaultRowFor(dataPoint);
    if (staticRow) {
        return staticRow;
    }
    if (overrideLayers.some(hasAuthoredIdentity)) {
        return undefined;
    }
    return defaultRowFor(dataPoint);
}
let _byDataPoint;
const _synthesized = new Map();
/** The STATIC table lookup only — no dynamic fallback. */
export function staticDefaultRowFor(dataPoint) {
    if (!_byDataPoint) {
        _byDataPoint = new Map(DEFAULT_SENSOR_MAP.map(r => [r.dataPoint, r]));
    }
    return _byDataPoint.get(dataPoint);
}
export function defaultRowFor(dataPoint) {
    if (!_byDataPoint) {
        _byDataPoint = new Map(DEFAULT_SENSOR_MAP.map(r => [r.dataPoint, r]));
    }
    const staticRow = _byDataPoint.get(dataPoint);
    if (staticRow) {
        return staticRow;
    }
    // Dynamic fallback (GA review P1-1): the legacy matcher's
    // acceptance is substring-based and unbounded; a finite table
    // cannot mirror it. Synthesized rows are cached so repeated
    // resolution sees one stable object per dataPoint.
    if (!_synthesized.has(dataPoint)) {
        _synthesized.set(dataPoint, synthesizeLegacyRow(dataPoint));
    }
    return _synthesized.get(dataPoint);
}
//# sourceMappingURL=defaultMap.js.map
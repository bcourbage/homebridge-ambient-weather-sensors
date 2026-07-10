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
import { TEMPERATURE_WRAPPER, HUMIDITY_WRAPPER, LIGHT_WM2_WRAPPER, CO2_WRAPPER, PM25_WRAPPER, PM10_WRAPPER, UV_INDEX_WRAPPER, WIND_SPEED_WRAPPER, WIND_GUST_WRAPPER, WIND_MAX_DAILY_GUST_WRAPPER, WIND_DIRECTION_WRAPPER, WIND_DIRECTION_10M_WRAPPER, PRESSURE_RELATIVE_WRAPPER, PRESSURE_ABSOLUTE_WRAPPER, RAIN_RATE_WRAPPER, RAIN_EVENT_WRAPPER, RAIN_DAILY_WRAPPER, RAIN_WEEKLY_WRAPPER, RAIN_MONTHLY_WRAPPER, RAIN_YEARLY_WRAPPER, LAST_RAIN_WRAPPER, LIGHTNING_DAY_WRAPPER, LIGHTNING_HOUR_WRAPPER, LIGHTNING_DISTANCE_WRAPPER, LIGHTNING_LAST_STRIKE_WRAPPER, } from './wrappers.js';
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
        wrapper: LIGHT_WM2_WRAPPER,
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
        wrapper: UV_INDEX_WRAPPER,
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
        wrapper: PRESSURE_RELATIVE_WRAPPER,
        name: 'Pressure Sea Level',
        sourceUnit: 'inHg',
        displayUnit: 'inHg',
        batteryField: 'battin',
        canonicalForBattery: false,
    },
    {
        dataPoint: 'baromabsin',
        kind: 'motion',
        measurement: 'pressure',
        wrapper: PRESSURE_ABSOLUTE_WRAPPER,
        name: 'Pressure Station',
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
        wrapper: PM25_WRAPPER,
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
        wrapper: PM25_WRAPPER,
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
        wrapper: PM25_WRAPPER,
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
        wrapper: PM25_WRAPPER,
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
        wrapper: PM25_WRAPPER,
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
        wrapper: PM10_WRAPPER,
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
        wrapper: PM10_WRAPPER,
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
let _byDataPoint;
export function defaultRowFor(dataPoint) {
    if (!_byDataPoint) {
        _byDataPoint = new Map(DEFAULT_SENSOR_MAP.map(r => [r.dataPoint, r]));
    }
    return _byDataPoint.get(dataPoint);
}
//# sourceMappingURL=defaultMap.js.map
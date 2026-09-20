/**
 * Wrapper descriptors — stable identity for accessory-wrapper classes.
 *
 * See docs/future/sensor-map.md §3.9 and §9. Every distinct
 * `(kind, measurement)` pair the plugin can render maps to exactly one
 * WrapperDescriptor. `id` is baked into the row's
 * `structuralSignature`, so:
 *
 *   1. Renaming a wrapper class (TS refactor) does NOT invalidate
 *      cached accessories — the id is what persists.
 *   2. Changing a wrapper's HAP service graph (adding a characteristic,
 *      swapping a service type) is signaled by bumping `schemaVersion`,
 *      which invalidates ONLY that wrapper's accessories on next launch.
 *
 * The first 25 ids below are the FROZEN v2.0 vocabulary — matching
 * the design doc §3.9 table exactly. The catalog-3 additions (§19)
 * follow the same rule from the moment they ship. Changing an id
 * after it ships silently invalidates every user's accessory cache.
 *
 * `WRAPPER_FOR_KIND_AND_MEASUREMENT` resolves the wrapper for a custom
 * sensor from its user-declared `(kind, measurement)`. Known-datapoint
 * rows carry their wrapper directly in the default map (see
 * `defaultMap.ts`); this lookup only matters for custom sensors.
 *
 * Catalog-3 pairs (§19.2) are STAMP-GATED: they exist in the table,
 * but `wrapperFor` resolves them only for configs whose
 * `catalogAdopted` covers their `sinceCatalogVersion` — a dormant
 * authored row with a new kind keeps failing `no-wrapper` until the
 * config explicitly adopts, because silently registering it on
 * upgrade would be new exposure.
 */
import { TemperatureAccessory } from '../temperatureAccessory.js';
import { HumidityAccessory } from '../humidityAccessory.js';
import { SolarRadiationAccessory } from '../solarRadiationAccessory.js';
import { Co2Accessory } from '../co2Accessory.js';
import { AirQualityAccessory } from '../airQualityAccessory.js';
import { UvAccessory } from '../extendedSensors/uvAccessory.js';
import { WindSpeedAccessory, WindGustAccessory, WindMaxDailyGustAccessory, WindDirectionAccessory, WindDirection10mAccessory, } from '../extendedSensors/windAccessory.js';
import { PressureRelativeAccessory, PressureAbsoluteAccessory, } from '../extendedSensors/pressureAccessory.js';
import { RainRateAccessory, RainEventAccessory, RainDailyAccessory, RainWeeklyAccessory, RainMonthlyAccessory, RainYearlyAccessory, LastRainAccessory, } from '../extendedSensors/rainAccessory.js';
import { LightningDayAccessory, LightningHourAccessory, LightningDistanceAccessory, LightningLastStrikeAccessory, } from '../extendedSensors/lightningAccessory.js';
import { LeakAccessory, ContactAccessory, OccupancyAccessory, SmokeAccessory, MotionBooleanAccessory, } from '../booleanStateAccessory.js';
import { CoAccessory } from '../coAccessory.js';
import { SoilMoistureAccessory, LeafWetnessAccessory, SoilTensionAccessory, EvapotranspirationAccessory, AqiAccessory, } from '../extendedSensors/genericValueAccessory.js';
// Value-tile wrappers — Apple Home renders reading directly.
export const TEMPERATURE_WRAPPER = {
    id: 'temperature',
    schemaVersion: 1,
    constructor: TemperatureAccessory,
};
export const HUMIDITY_WRAPPER = {
    id: 'humidity',
    schemaVersion: 1,
    constructor: HumidityAccessory,
};
export const SOLAR_RADIATION_WRAPPER = {
    id: 'solar-radiation',
    schemaVersion: 1,
    constructor: SolarRadiationAccessory,
};
export const CO2_WRAPPER = {
    id: 'co2',
    schemaVersion: 1,
    constructor: Co2Accessory,
};
// PM2.5 and PM10 share the AirQualityAccessory class but have
// distinct ids because their HAP characteristic set differs
// (PM2_5Density vs. PM10Density).
export const AIR_QUALITY_PM25_WRAPPER = {
    id: 'air-quality-pm25',
    schemaVersion: 1,
    constructor: AirQualityAccessory,
};
export const AIR_QUALITY_PM10_WRAPPER = {
    id: 'air-quality-pm10',
    schemaVersion: 1,
    constructor: AirQualityAccessory,
};
// State-tile / motion-family wrappers — every non-value HAP sensor
// (wind, rain, pressure, UV, lightning) is rendered as MotionSensor.
// Each measurement has its own wrapper class with distinct threshold
// semantics and value shape.
export const UV_WRAPPER = {
    id: 'uv',
    schemaVersion: 1,
    constructor: UvAccessory,
};
export const WIND_SPEED_WRAPPER = {
    id: 'wind-speed',
    schemaVersion: 1,
    constructor: WindSpeedAccessory,
};
export const WIND_GUST_WRAPPER = {
    id: 'wind-gust',
    schemaVersion: 1,
    constructor: WindGustAccessory,
};
export const WIND_MAX_DAILY_GUST_WRAPPER = {
    id: 'wind-max-daily-gust',
    schemaVersion: 1,
    constructor: WindMaxDailyGustAccessory,
};
export const WIND_DIRECTION_WRAPPER = {
    id: 'wind-direction',
    schemaVersion: 1,
    constructor: WindDirectionAccessory,
};
export const WIND_DIRECTION_10M_WRAPPER = {
    id: 'wind-direction-10m',
    schemaVersion: 1,
    constructor: WindDirection10mAccessory,
};
export const PRESSURE_RELATIVE_WRAPPER = {
    id: 'pressure-relative',
    schemaVersion: 1,
    constructor: PressureRelativeAccessory,
};
export const PRESSURE_ABSOLUTE_WRAPPER = {
    id: 'pressure-absolute',
    schemaVersion: 1,
    constructor: PressureAbsoluteAccessory,
};
export const RAIN_RATE_WRAPPER = {
    id: 'rain-rate',
    schemaVersion: 1,
    constructor: RainRateAccessory,
};
export const RAIN_EVENT_WRAPPER = {
    id: 'rain-event',
    schemaVersion: 1,
    constructor: RainEventAccessory,
};
export const RAIN_DAILY_WRAPPER = {
    id: 'rain-daily',
    schemaVersion: 1,
    constructor: RainDailyAccessory,
};
export const RAIN_WEEKLY_WRAPPER = {
    id: 'rain-weekly',
    schemaVersion: 1,
    constructor: RainWeeklyAccessory,
};
export const RAIN_MONTHLY_WRAPPER = {
    id: 'rain-monthly',
    schemaVersion: 1,
    constructor: RainMonthlyAccessory,
};
export const RAIN_YEARLY_WRAPPER = {
    id: 'rain-yearly',
    schemaVersion: 1,
    constructor: RainYearlyAccessory,
};
export const LAST_RAIN_WRAPPER = {
    id: 'last-rain',
    schemaVersion: 1,
    constructor: LastRainAccessory,
};
export const LIGHTNING_DAY_WRAPPER = {
    id: 'lightning-day',
    schemaVersion: 1,
    constructor: LightningDayAccessory,
};
export const LIGHTNING_HOUR_WRAPPER = {
    id: 'lightning-hour',
    schemaVersion: 1,
    constructor: LightningHourAccessory,
};
export const LIGHTNING_DISTANCE_WRAPPER = {
    id: 'lightning-distance',
    schemaVersion: 1,
    constructor: LightningDistanceAccessory,
};
export const LIGHTNING_LAST_STRIKE_WRAPPER = {
    id: 'lightning-last-strike',
    schemaVersion: 1,
    constructor: LightningLastStrikeAccessory,
};
/**
 * The frozen, ordered registry of every wrapper the plugin ships.
 * Order is stable — the snapshot test in `wrappers.test.ts` locks
 * both the exact set of (id, schemaVersion) pairs and their order,
 * so a well-meaning rename or reorder breaks CI instead of silently
 * invalidating user caches. See review finding #14.
 *
 * Runtime `Object.freeze` on the array + each descriptor (applied
 * at module load, below) guards against accidental in-place
 * mutation of descriptor fields — the `readonly` compile-time
 * annotations already do most of the work; the freeze is
 * belt-and-suspenders for anything reaching the registry through
 * an untyped path.
 */
// ---- Catalog-3 wrappers (§19) ------------------------------------
export const LEAK_WRAPPER = {
    id: 'leak', schemaVersion: 1, constructor: LeakAccessory,
};
export const CONTACT_WRAPPER = {
    id: 'contact', schemaVersion: 1, constructor: ContactAccessory,
};
export const OCCUPANCY_WRAPPER = {
    id: 'occupancy', schemaVersion: 1, constructor: OccupancyAccessory,
};
export const SMOKE_WRAPPER = {
    id: 'smoke', schemaVersion: 1, constructor: SmokeAccessory,
};
export const MOTION_BOOLEAN_WRAPPER = {
    id: 'motion-boolean', schemaVersion: 1, constructor: MotionBooleanAccessory,
};
export const CO_WRAPPER = {
    id: 'co', schemaVersion: 1, constructor: CoAccessory,
};
export const SOIL_MOISTURE_WRAPPER = {
    id: 'soil-moisture', schemaVersion: 1, constructor: SoilMoistureAccessory,
};
export const LEAF_WETNESS_WRAPPER = {
    id: 'leaf-wetness', schemaVersion: 1, constructor: LeafWetnessAccessory,
};
export const SOIL_TENSION_WRAPPER = {
    id: 'soil-tension', schemaVersion: 1, constructor: SoilTensionAccessory,
};
export const EVAPOTRANSPIRATION_WRAPPER = {
    id: 'evapotranspiration', schemaVersion: 1, constructor: EvapotranspirationAccessory,
};
export const AQI_WRAPPER = {
    id: 'aqi', schemaVersion: 1, constructor: AqiAccessory,
};
export const ALL_WRAPPERS = [
    TEMPERATURE_WRAPPER,
    HUMIDITY_WRAPPER,
    SOLAR_RADIATION_WRAPPER,
    CO2_WRAPPER,
    AIR_QUALITY_PM25_WRAPPER,
    AIR_QUALITY_PM10_WRAPPER,
    UV_WRAPPER,
    WIND_SPEED_WRAPPER,
    WIND_GUST_WRAPPER,
    WIND_MAX_DAILY_GUST_WRAPPER,
    WIND_DIRECTION_WRAPPER,
    WIND_DIRECTION_10M_WRAPPER,
    PRESSURE_RELATIVE_WRAPPER,
    PRESSURE_ABSOLUTE_WRAPPER,
    RAIN_RATE_WRAPPER,
    RAIN_EVENT_WRAPPER,
    RAIN_DAILY_WRAPPER,
    RAIN_WEEKLY_WRAPPER,
    RAIN_MONTHLY_WRAPPER,
    RAIN_YEARLY_WRAPPER,
    LAST_RAIN_WRAPPER,
    LIGHTNING_DAY_WRAPPER,
    LIGHTNING_HOUR_WRAPPER,
    LIGHTNING_DISTANCE_WRAPPER,
    LIGHTNING_LAST_STRIKE_WRAPPER,
    LEAK_WRAPPER,
    CONTACT_WRAPPER,
    OCCUPANCY_WRAPPER,
    SMOKE_WRAPPER,
    MOTION_BOOLEAN_WRAPPER,
    CO_WRAPPER,
    SOIL_MOISTURE_WRAPPER,
    LEAF_WETNESS_WRAPPER,
    SOIL_TENSION_WRAPPER,
    EVAPOTRANSPIRATION_WRAPPER,
    AQI_WRAPPER,
];
/**
 * Custom-sensor `(kind, measurement)` → wrapper resolution table —
 * RESTORED in finding-#4 Stage 4, after the interim Stage-0 emptying.
 *
 * Given a custom row's user-declared `(kind, measurement)`, this
 * resolves the wrapper the plugin uses. The prerequisites that gated
 * the restore are all live: Stage 1's factory registry, Stage 2's
 * row-consuming constructors (a custom row's `dataPoint` / `threshold`
 * / units / name all flow from the row, never a hardcoded AWN key),
 * Stage 3's value routing, and Stage 4's platform boundary
 * (`discoverDevicesV2` registers and routes custom rows end-to-end).
 * The 15 entries are byte-identical to the pre-Stage-0 table.
 *
 * `motion`-kind rows disambiguate on measurement alone. Where a
 * measurement has multiple candidate wrappers (rain-accumulation
 * covers event/daily/weekly/monthly/yearly; count covers day/hour;
 * timestamp covers last-rain / last-strike), the lookup picks the
 * most "generic" — the top-level accumulation / count / timestamp
 * variant. Users wanting a sub-flavor declare the row against the
 * matching known dataPoint via the default map instead.
 *
 * Kinds without a concrete wrapper class (co, leak, contact,
 * occupancy) remain absent — a custom row declaring one still fails
 * with a `no-wrapper` error until concrete classes land.
 *
 * KNOWN dataPoints never consult this table — they resolve their
 * wrapper via `defaultMap.wrapper` (a direct descriptor reference on
 * the default row).
 *
 * `wrappers.test.ts` pins the exact 15-entry shape AND that every
 * entry's descriptor agrees with the key's `(kind, measurement)` per
 * `WRAPPER_SPEC`, so a drifted entry breaks CI instead of registering
 * a mis-typed accessory.
 */
export const WRAPPER_FOR_KIND_AND_MEASUREMENT = {
    'temperature|temperature': TEMPERATURE_WRAPPER,
    'humidity|humidity': HUMIDITY_WRAPPER,
    'light|illuminance': SOLAR_RADIATION_WRAPPER,
    'co2|co2': CO2_WRAPPER,
    'air-quality-pm25|pm25': AIR_QUALITY_PM25_WRAPPER,
    'air-quality-pm10|pm10': AIR_QUALITY_PM10_WRAPPER,
    'motion|uv-index': UV_WRAPPER,
    'motion|wind-speed': WIND_SPEED_WRAPPER,
    'motion|direction': WIND_DIRECTION_WRAPPER,
    'motion|pressure': PRESSURE_RELATIVE_WRAPPER,
    'motion|rain-rate': RAIN_RATE_WRAPPER,
    'motion|rain-accumulation': RAIN_EVENT_WRAPPER,
    'motion|distance': LIGHTNING_DISTANCE_WRAPPER,
    'motion|count': LIGHTNING_DAY_WRAPPER,
    'motion|timestamp': LAST_RAIN_WRAPPER,
    // Catalog-3 pairs (§19.2) — stamp-gated via WRAPPER_PAIR_SINCE.
    'leak|boolean': LEAK_WRAPPER,
    'contact|boolean': CONTACT_WRAPPER,
    'occupancy|boolean': OCCUPANCY_WRAPPER,
    'smoke|boolean': SMOKE_WRAPPER,
    'motion|boolean': MOTION_BOOLEAN_WRAPPER,
    'co|co': CO_WRAPPER,
    'motion|soil-moisture': SOIL_MOISTURE_WRAPPER,
    'motion|leaf-wetness': LEAF_WETNESS_WRAPPER,
    'motion|soil-tension': SOIL_TENSION_WRAPPER,
    'motion|evapotranspiration': EVAPOTRANSPIRATION_WRAPPER,
    'motion|aqi': AQI_WRAPPER,
};
/**
 * The catalog version each pair arrived in (§19.2). Absent = 1, the
 * frozen v2.0 set. `wrapperFor` gates on it so an authored row with a
 * later kind stays `no-wrapper` until the config adopts — adoption's
 * preview then names any newly-resolving row as an added consequence.
 */
export const WRAPPER_PAIR_SINCE = {
    'leak|boolean': 3,
    'contact|boolean': 3,
    'occupancy|boolean': 3,
    'smoke|boolean': 3,
    'motion|boolean': 3,
    'co|co': 3,
    'motion|soil-moisture': 3,
    'motion|leaf-wetness': 3,
    'motion|soil-tension': 3,
    'motion|evapotranspiration': 3,
    'motion|aqi': 3,
};
export function wrapperFor(kind, measurement, catalogAdopted = 1) {
    const key = `${kind}|${measurement}`;
    const descriptor = WRAPPER_FOR_KIND_AND_MEASUREMENT[key];
    if (descriptor === undefined || (WRAPPER_PAIR_SINCE[key] ?? 1) > catalogAdopted) {
        return undefined;
    }
    return descriptor;
}
// id → descriptor lookup. Used by the platform's structural-signature
// reconciliation (finding-#4 Stage 4, review P1-2) to derive a cached
// accessory's signature when its context predates v2 (no stored
// signature). Keyed by the frozen WrapperId union, so an unregistered
// id is a compile error at the call site.
const WRAPPER_BY_ID = new Map(ALL_WRAPPERS.map(w => [w.id, w]));
export function wrapperById(id) {
    // Every WrapperId has exactly one ALL_WRAPPERS entry (locked by the
    // registry snapshot test), so the lookup cannot miss at runtime.
    return WRAPPER_BY_ID.get(id);
}
// Deep-freeze the registry so any code path that receives a
// descriptor (including untyped MCP boundaries or future dynamic
// lookups) cannot mutate `id` or `schemaVersion`. Applied once at
// module load. See review finding #14.
for (const w of ALL_WRAPPERS) {
    Object.freeze(w);
}
Object.freeze(ALL_WRAPPERS);
Object.freeze(WRAPPER_FOR_KIND_AND_MEASUREMENT);
//# sourceMappingURL=wrappers.js.map
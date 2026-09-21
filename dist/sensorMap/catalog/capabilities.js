/**
 * The output-capability specification (issue #63, package P1): which
 * native HomeKit sensor representations exist, which the plugin
 * actually implements, and where the extended (threshold-shell)
 * representation stands in. The INPUT side (what an AWN field means)
 * lives in awnCatalog.ts; whether an installation exposes a row is the
 * exposure policy (sensor-map.md §18). Design-checkpoint data,
 * consumed by tests only — the runtime's single authority on
 * implemented pairs remains WRAPPER_FOR_KIND_AND_MEASUREMENT.
 *
 * The specification states the EXACT mappings, not counts: every
 * implemented `(kind, measurement)` pair is listed with the WrapperId
 * the registry must resolve for it, under the HAP service the wrapper
 * must instantiate. The coverage suite cross-checks all three against
 * the runtime — set equality with the wrapper registry, per-pair
 * descriptor identity, and REAL HAP instantiation of each pair
 * asserting the declared service is present in the accessory's
 * service graph — so a swapped service claim, a renamed measurement,
 * or a drifted wrapper binding fails CI instead of passing on shape.
 *
 * Native HAP support is not a promise that Apple's Home app renders a
 * characteristic as a tile; Apple Home versus other HomeKit clients is
 * documented separately (plugin-ui.md / README), not promised here.
 */
/**
 * The 11 native sensor service families the installed HAP library
 * declares — the sensor-only scope, not every HomeKit actuator,
 * camera, or bridge service.
 */
export const NATIVE_SENSOR_SERVICES = [
    { service: 'TemperatureSensor', kinds: ['temperature'], status: 'implemented',
        pairs: [{ pair: 'temperature|temperature', wrapperId: 'temperature' }],
        scope: 'Temperature measurements; source units convert to HAP Celsius.' },
    { service: 'HumiditySensor', kinds: ['humidity'], status: 'implemented',
        pairs: [{ pair: 'humidity|humidity', wrapperId: 'humidity' }],
        scope: 'Relative humidity in percent.' },
    { service: 'LightSensor', kinds: ['light'], status: 'implemented',
        pairs: [{ pair: 'light|illuminance', wrapperId: 'solar-radiation' }],
        scope: 'Illuminance; solar irradiance renders via the deployed W/m2-to-lux approximation (documented assumption).' },
    { service: 'CarbonDioxideSensor', kinds: ['co2'], status: 'implemented',
        pairs: [{ pair: 'co2|co2', wrapperId: 'co2' }],
        scope: 'CO2 concentration in ppm.' },
    { service: 'AirQualitySensor', kinds: ['air-quality-pm25', 'air-quality-pm10'], status: 'implemented-narrow',
        pairs: [
            { pair: 'air-quality-pm25|pm25', wrapperId: 'air-quality-pm25' },
            { pair: 'air-quality-pm10|pm10', wrapperId: 'air-quality-pm10' },
        ],
        scope: 'PM2.5/PM10 mass densities only (kinds air-quality-pm25 and air-quality-pm10) — not a general AQI or arbitrary-pollutant mapping. AQI index fields are a catalog gap (P3).' },
    { service: 'MotionSensor', kinds: ['motion'], status: 'implemented-narrow',
        pairs: [
            { pair: 'motion|uv-index', wrapperId: 'uv' },
            { pair: 'motion|wind-speed', wrapperId: 'wind-speed' },
            { pair: 'motion|direction', wrapperId: 'wind-direction' },
            { pair: 'motion|pressure', wrapperId: 'pressure-relative' },
            { pair: 'motion|rain-rate', wrapperId: 'rain-rate' },
            { pair: 'motion|rain-accumulation', wrapperId: 'rain-event' },
            { pair: 'motion|distance', wrapperId: 'lightning-distance' },
            { pair: 'motion|count', wrapperId: 'lightning-day' },
            { pair: 'motion|timestamp', wrapperId: 'last-rain' },
            { pair: 'motion|boolean', wrapperId: 'motion-boolean', since: 3 },
            { pair: 'motion|soil-moisture', wrapperId: 'soil-moisture', since: 3 },
            { pair: 'motion|leaf-wetness', wrapperId: 'leaf-wetness', since: 3 },
            { pair: 'motion|soil-tension', wrapperId: 'soil-tension', since: 3 },
            { pair: 'motion|evapotranspiration', wrapperId: 'evapotranspiration', since: 3 },
            { pair: 'motion|aqi', wrapperId: 'aqi', since: 3 },
        ],
        scope: 'The weather-value/threshold shell (extended representation): a numeric measurement with an optional threshold trigger. Catalog 3 adds the DIRECT boolean mapping (motion|boolean, §19.1) and the agronomic/AQI numeric measurements (§19.4). Custom pairs resolve the most generic wrapper of each measurement; sub-flavors ride known dataPoints.' },
    { service: 'CarbonMonoxideSensor', kinds: ['co'], status: 'reserved-no-wrapper',
        scope: 'Kind reserved; the native co|co mapping is DEFERRED past P3 (PR #67 review F2 / maintainer decision). An honest CO alarm needs a supplied detector alarm state with explicit unknown/fault handling — not an invented concentration/exposure algorithm — so assignment fails no-wrapper. Numeric CO readings will use the generic non-alarm numeric path (P3.1); that is not a CO alarm.' },
    { service: 'LeakSensor', kinds: ['leak'], status: 'implemented',
        pairs: [{ pair: 'leak|boolean', wrapperId: 'leak', since: 3 }],
        scope: 'Boolean state with the explicit §19.1 decode: 0 normal, 1 leak, anything else StatusFault with the alert forced clear — an offline detector (declared 2) never reads as a leak.' },
    { service: 'ContactSensor', kinds: ['contact'], status: 'implemented',
        pairs: [{ pair: 'contact|boolean', wrapperId: 'contact', since: 3 }],
        scope: 'Boolean state (§19.1 decode); raw 1 = triggered = contact open.' },
    { service: 'OccupancySensor', kinds: ['occupancy'], status: 'implemented',
        pairs: [{ pair: 'occupancy|boolean', wrapperId: 'occupancy', since: 3 }],
        scope: 'Boolean state (§19.1 decode).' },
    { service: 'SmokeSensor', kinds: ['smoke'], status: 'implemented',
        pairs: [{ pair: 'smoke|boolean', wrapperId: 'smoke', since: 3 }],
        scope: 'Boolean state (§19.1 decode); the smoke kind joined the vocabulary at catalog 3, closing the §18 capability gap.' },
];
//# sourceMappingURL=capabilities.js.map
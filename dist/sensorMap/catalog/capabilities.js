/**
 * The output-capability specification (issue #63, package P1): which
 * native HomeKit sensor representations exist, which the plugin
 * actually implements, and where the extended (threshold-shell)
 * representation stands in. The INPUT side (what an AWN field means)
 * lives in awnCatalog.ts; whether an installation exposes a row is the
 * exposure policy (sensor-map.md §18). Design-checkpoint data,
 * consumed by tests only — the runtime's single authority on
 * implemented pairs remains WRAPPER_FOR_KIND_AND_MEASUREMENT, and the
 * coverage suite cross-checks this specification against it so the two
 * cannot drift.
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
        scope: 'Temperature measurements; source units convert to HAP Celsius.' },
    { service: 'HumiditySensor', kinds: ['humidity'], status: 'implemented',
        scope: 'Relative humidity in percent.' },
    { service: 'LightSensor', kinds: ['light'], status: 'implemented',
        scope: 'Illuminance; solar irradiance renders via the deployed W/m2-to-lux approximation (documented assumption).' },
    { service: 'CarbonDioxideSensor', kinds: ['co2'], status: 'implemented',
        scope: 'CO2 concentration in ppm.' },
    { service: 'AirQualitySensor', kinds: ['air-quality-pm25', 'air-quality-pm10'], status: 'implemented-narrow',
        scope: 'PM2.5/PM10 mass densities only (kinds air-quality-pm25 and air-quality-pm10) — not a general AQI or arbitrary-pollutant mapping. AQI index fields are a catalog gap (P3).' },
    { service: 'MotionSensor', kinds: ['motion'], status: 'implemented-narrow',
        scope: 'The weather-value/threshold shell (extended representation): a numeric measurement with an optional threshold trigger. No general direct boolean-motion assignment exists.' },
    { service: 'CarbonMonoxideSensor', kinds: ['co'], status: 'reserved-no-wrapper',
        scope: 'Kind reserved in the vocabulary; assignment fails with no-wrapper until P3.' },
    { service: 'LeakSensor', kinds: ['leak'], status: 'reserved-no-wrapper',
        scope: 'Kind reserved; needs the wrapper AND an explicit normal/leak/offline decoder (generic boolean coercion maps 2 to true — an offline detector must never read as a leak).' },
    { service: 'ContactSensor', kinds: ['contact'], status: 'reserved-no-wrapper',
        scope: 'Kind reserved; no wrapper until P3.' },
    { service: 'OccupancySensor', kinds: ['occupancy'], status: 'reserved-no-wrapper',
        scope: 'Kind reserved; no wrapper until P3.' },
    { service: 'SmokeSensor', status: 'absent-from-vocabulary',
        scope: 'Native service exists; the kind/assignment vocabulary has no entry for it today.' },
];
//# sourceMappingURL=capabilities.js.map
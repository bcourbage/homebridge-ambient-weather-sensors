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

export type NativeServiceStatus =
  /** A plugin kind produces this service today. */
  | 'implemented'
  /** Implemented for specific measurements only; not a general mapping. */
  | 'implemented-narrow'
  /** The plugin reserves a kind, but no wrapper exists yet. */
  | 'reserved-no-wrapper'
  /** The native service exists; the plugin vocabulary has no kind for it. */
  | 'absent-from-vocabulary';

/** One implemented `(kind, measurement)` pair and its required wrapper. */
export interface ImplementedPairSpec {
  /** A `${kind}|${measurement}` key of WRAPPER_FOR_KIND_AND_MEASUREMENT. */
  pair: string;
  /** The frozen WrapperId the registry must resolve for this pair. */
  wrapperId: string;
}

export interface NativeServiceSpec {
  /** HAP service class name, as exposed on `platform.Service`. */
  service: string;
  /** The plugin kinds that map to it, where any exist. */
  kinds?: string[];
  /**
   * The implemented pairs rendering AS this service. Present exactly
   * when status is implemented / implemented-narrow.
   */
  pairs?: ImplementedPairSpec[];
  status: NativeServiceStatus;
  /** Honest statement of scope and limits. */
  scope: string;
}

/**
 * The 11 native sensor service families the installed HAP library
 * declares — the sensor-only scope, not every HomeKit actuator,
 * camera, or bridge service.
 */
export const NATIVE_SENSOR_SERVICES: ReadonlyArray<NativeServiceSpec> = [
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
    ],
    scope: 'The weather-value/threshold shell (extended representation): a numeric measurement with an optional threshold trigger. No general direct boolean-motion assignment exists. Custom pairs resolve the most generic wrapper of each measurement; sub-flavors ride known dataPoints.' },
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

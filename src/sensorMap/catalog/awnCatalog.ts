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
 *
 * Provenance: the published baseline is AWN's Device Data Specs wiki,
 * commit e1c13509fdcad8ad7b212e77b8193dac71e241b5 (last published edit
 * 2023-08-07). The published list is not proof that every firmware
 * field is documented; entries carry their own evidence notes where
 * they extend or contradict it. Recorded uncertainty is deliberate:
 * resolving it is P2/P3 work, not this file's job.
 */

/** Bump when entries/families are added, removed, or re-dispositioned. */
export const AWN_CATALOG_VERSION = 1;

/** The published baseline this inventory was audited against. */
export const AWN_WIKI_BASELINE = 'e1c13509fdcad8ad7b212e77b8193dac71e241b5';

export type CatalogClass =
  /** A quantity or state a sensor row could represent. */
  | 'measurement'
  /** Battery/status fields consumed by rows, never standalone tiles. */
  | 'battery-auxiliary'
  /** Reported relay state; read-only, no control contract exists. */
  | 'relay-state'
  /** Station/sample metadata; never an accessory. */
  | 'metadata';

export type CatalogDisposition =
  /** In the static table with a native HomeKit service. */
  | 'implemented-native'
  /** In the static table with the extended (threshold-shell) representation. */
  | 'implemented-extended'
  /**
   * Recognized today ONLY through the legacy substring fallback (or
   * partly static, partly fallback for an indexed family). Needs an
   * anchored catalog definition (P2) — landing AFTER the
   * assignment-preservation mechanism, per the design checkpoint.
   */
  | 'compat-fallback'
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
  indexed?: { prefix: string; suffix?: string; from: number; to: number; staticThrough?: number };
  class: CatalogClass;
  disposition: CatalogDisposition;
  /** What the field means, per the published docs / device evidence. */
  meaning: string;
  /** AWN source unit where verified; absent when unverified. */
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

const WIKI = `AWN Device Data Specs wiki @ ${AWN_WIKI_BASELINE}`;

export const AWN_CATALOG: ReadonlyArray<CatalogEntry> = [
  // ---- Wind --------------------------------------------------------
  { family: 'winddir', keys: ['winddir'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Instantaneous wind direction', sourceUnit: 'degrees', batteryField: 'battout', evidence: WIKI },
  { family: 'windspeedmph', keys: ['windspeedmph'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Instantaneous wind speed', sourceUnit: 'mph', batteryField: 'battout', evidence: WIKI },
  { family: 'windgustmph', keys: ['windgustmph'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Maximum wind speed in the last 10 minutes', sourceUnit: 'mph', batteryField: 'battout', evidence: WIKI },
  { family: 'maxdailygust', keys: ['maxdailygust'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Maximum wind speed since local midnight', sourceUnit: 'mph', batteryField: 'battout', evidence: WIKI },
  { family: 'windgustdir', keys: ['windgustdir'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Wind direction at maximum gust', sourceUnit: 'degrees', evidence: WIKI,
    notes: 'Existing direction wrapper can render (P2).' },
  { family: 'windspdmph_avg2m', keys: ['windspdmph_avg2m'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Average wind speed, 2-minute window', sourceUnit: 'mph', evidence: WIKI,
    notes: 'Existing wind wrapper can render (P2).' },
  { family: 'winddir_avg2m', keys: ['winddir_avg2m'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Average wind direction, 2-minute window', sourceUnit: 'degrees', evidence: WIKI,
    notes: 'Existing direction wrapper can render (P2).' },
  { family: 'windspdmph_avg10m', keys: ['windspdmph_avg10m'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Average wind speed, 10-minute window', sourceUnit: 'mph', evidence: WIKI,
    notes: 'Existing wind wrapper can render (P2). PRESERVATION FIXTURE: a live installation carries an '
      + 'explicit assignment ("Wind Speed Average"); the P2 definition must not replace it (sensor-map.md §18.4).' },
  { family: 'winddir_avg10m', keys: ['winddir_avg10m'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Average wind direction, 10-minute window', sourceUnit: 'degrees', batteryField: 'battout', evidence: WIKI },

  // ---- Temperature / humidity (outdoor, indoor, channels) ----------
  { family: 'tempf', keys: ['tempf'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Outdoor temperature', sourceUnit: 'fahrenheit', batteryField: 'battout', evidence: WIKI },
  { family: 'tempinf', keys: ['tempinf'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Indoor (console) temperature', sourceUnit: 'fahrenheit', batteryField: 'battin', evidence: WIKI },
  { family: 'temp1f...temp10f', indexed: { prefix: 'temp', suffix: 'f', from: 1, to: 10, staticThrough: 10 },
    class: 'measurement', disposition: 'implemented-native',
    meaning: 'WH31 channel temperature', sourceUnit: 'fahrenheit', batteryField: 'batt{n}', evidence: WIKI },
  { family: 'humidity', keys: ['humidity'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Outdoor relative humidity', sourceUnit: 'percent', batteryField: 'battout', evidence: WIKI },
  { family: 'humidityin', keys: ['humidityin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Indoor (console) relative humidity', sourceUnit: 'percent', batteryField: 'battin', evidence: WIKI },
  { family: 'humidity1...humidity10', indexed: { prefix: 'humidity', from: 1, to: 10, staticThrough: 10 },
    class: 'measurement', disposition: 'implemented-native',
    meaning: 'WH31 channel relative humidity', sourceUnit: 'percent', batteryField: 'batt{n}', evidence: WIKI },
  { family: 'feelsLike', keys: ['feelsLike'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Outdoor feels-like temperature (derived)', sourceUnit: 'fahrenheit', batteryField: 'battout', evidence: WIKI },
  { family: 'feelsLikein', keys: ['feelsLikein'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Indoor feels-like temperature (derived)', sourceUnit: 'fahrenheit', batteryField: 'battin', evidence: WIKI },
  { family: 'feelsLike1...feelsLike10', indexed: { prefix: 'feelsLike', from: 1, to: 10, staticThrough: 4 },
    class: 'measurement', disposition: 'compat-fallback',
    meaning: 'Channel feels-like temperature (derived)', sourceUnit: 'fahrenheit', batteryField: 'batt{n}', evidence: WIKI,
    notes: 'Indexes 1..4 are static; 5..10 resolve via the fallback. Anchored definition in P2.' },
  { family: 'dewPoint', keys: ['dewPoint'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Outdoor dew point (derived)', sourceUnit: 'fahrenheit', batteryField: 'battout', evidence: WIKI },
  { family: 'dewPointin', keys: ['dewPointin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Indoor dew point (derived)', sourceUnit: 'fahrenheit', batteryField: 'battin', evidence: WIKI },
  { family: 'dewPoint1...dewPoint10', indexed: { prefix: 'dewPoint', from: 1, to: 10, staticThrough: 4 },
    class: 'measurement', disposition: 'compat-fallback',
    meaning: 'Channel dew point (derived)', sourceUnit: 'fahrenheit', batteryField: 'batt{n}', evidence: WIKI,
    notes: 'Indexes 1..4 are static; 5..10 resolve via the fallback. Anchored definition in P2.' },
  { family: 'soiltemp1f...soiltemp10f', indexed: { prefix: 'soiltemp', suffix: 'f', from: 1, to: 10 },
    class: 'measurement', disposition: 'compat-fallback',
    meaning: 'Soil temperature probe', sourceUnit: 'fahrenheit', batteryField: null, evidence: WIKI,
    notes: 'Recognized only via the fallback today. Anchored definition in P2; battery family (battsm{n}?) needs device evidence.' },

  // ---- Soil / leaf / agronomic gaps --------------------------------
  { family: 'soilhum1...soilhum10', indexed: { prefix: 'soilhum', from: 1, to: 10 },
    class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Soil moisture', sourceUnit: 'percent', evidence: WIKI,
    notes: 'Soil-moisture semantics and extended output required — NOT air humidity merely because both use %.' },
  { family: 'leafwetness1...leafwetness8', indexed: { prefix: 'leafwetness', from: 1, to: 8 },
    class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Leaf wetness', evidence: WIKI,
    notes: 'Leaf-wetness semantics and extended output required.' },
  { family: 'soiltens1...soiltens4', indexed: { prefix: 'soiltens', from: 1, to: 4 },
    class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Soil tension', evidence: WIKI,
    notes: 'Soil-tension units and presentation required — not weather-pressure wording.' },
  { family: 'gdd', keys: ['gdd'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Growing degree days (accumulation)', evidence: WIKI,
    notes: 'Published-unit ambiguity must be resolved against vendor/device evidence before conversions exist.' },
  { family: 'etos', keys: ['etos'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Evapotranspiration, short reference crop', evidence: WIKI,
    notes: 'Time-base must be verified — a daily rate must not be reinterpreted as hourly.' },
  { family: 'etrs', keys: ['etrs'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Evapotranspiration, tall reference crop', evidence: WIKI,
    notes: 'Time-base must be verified — a daily rate must not be reinterpreted as hourly.' },

  // ---- Leak sensors -------------------------------------------------
  { family: 'leak1...leak4', indexed: { prefix: 'leak', from: 1, to: 4 },
    class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Leak detector state', encoding: '0 normal, 1 leak, 2 offline (per published docs)',
    batteryField: null, evidence: WIKI,
    notes: 'Needs the native LeakSensor wrapper AND an explicit normal/leak/offline decoder: generic boolean '
      + 'coercion maps 2 to true, which would report an OFFLINE detector as a leak. The documented battery '
      + 'family is batleak{n}; the production binding is deliberately absent until that design lands (P3).' },

  // ---- Rain ---------------------------------------------------------
  { family: 'hourlyrainin', keys: ['hourlyrainin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Rain rate (hourly)', sourceUnit: 'in_per_hr', batteryField: 'battout', evidence: WIKI },
  { family: 'dailyrainin', keys: ['dailyrainin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Rain since local midnight', sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
  { family: '24hourrainin', keys: ['24hourrainin'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Rain in the last 24 hours (rolling)', sourceUnit: 'in', evidence: WIKI,
    notes: 'Existing accumulation wrapper can render (P2).' },
  { family: 'weeklyrainin', keys: ['weeklyrainin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Rain this week', sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
  { family: 'monthlyrainin', keys: ['monthlyrainin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Rain this month', sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
  { family: 'yearlyrainin', keys: ['yearlyrainin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Rain this year', sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
  { family: 'eventrainin', keys: ['eventrainin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Rain in the current event', sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
  { family: 'totalrainin', keys: ['totalrainin'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Rain since last factory reset (lifetime)', sourceUnit: 'in', evidence: WIKI,
    notes: 'Existing accumulation wrapper can render (P2).' },
  { family: 'lastRain', keys: ['lastRain'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Time of last recorded rain', encoding: 'ISO-8601 string; the plugin parses to epoch ms ("never" invalid-string parses to 0, v1.7 parity)',
    batteryField: 'battout', evidence: WIKI },

  // ---- Pressure / sun -----------------------------------------------
  { family: 'baromrelin', keys: ['baromrelin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Relative (sea-level) barometric pressure', sourceUnit: 'inHg', batteryField: 'battin', evidence: WIKI },
  { family: 'baromabsin', keys: ['baromabsin'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Absolute (station) barometric pressure', sourceUnit: 'inHg', batteryField: 'battin', evidence: WIKI },
  { family: 'uv', keys: ['uv'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'UV index', sourceUnit: 'index', batteryField: 'battout', evidence: WIKI },
  { family: 'solarradiation', keys: ['solarradiation'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Solar irradiance', sourceUnit: 'wm2',
    encoding: 'Rendered as illuminance via the deployed W/m2-to-lux approximation (a documented assumption, not a universal physical conversion)',
    batteryField: 'battout', evidence: WIKI },

  // ---- CO2 / particulates / AQIN ------------------------------------
  { family: 'co2', keys: ['co2'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Carbon dioxide concentration', sourceUnit: 'ppm', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'co2_in (plugin extra)', keys: ['co2_in'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Indoor carbon dioxide concentration', sourceUnit: 'ppm', batteryField: null,
    evidence: 'Plugin catalog with real-device provenance; ABSENT from the published wiki baseline. Working definitions are not removed because the published list omits them (#63).' },
  { family: 'pm25', keys: ['pm25'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Outdoor PM2.5 mass density', sourceUnit: 'ugm3', batteryField: null, evidence: WIKI,
    notes: 'Standalone-PM battery mapping (batt_25) deliberately unbound pending device evidence (existing policy).' },
  { family: 'pm25_24h', keys: ['pm25_24h'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Outdoor PM2.5, 24h average', sourceUnit: 'ugm3', batteryField: null, evidence: WIKI },
  { family: 'pm25_in', keys: ['pm25_in'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'Indoor PM2.5 mass density', sourceUnit: 'ugm3', batteryField: null, evidence: WIKI },
  { family: 'pm25_in_24h', keys: ['pm25_in_24h'], class: 'measurement', disposition: 'compat-fallback',
    meaning: 'Indoor PM2.5, 24h average', sourceUnit: 'ugm3', batteryField: null, evidence: WIKI,
    notes: 'Recognized only via the fallback today. Anchored definition in P2.' },
  { family: 'pm25_in_aqin', keys: ['pm25_in_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN indoor PM2.5 mass density', sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'pm25_in_24h_aqin', keys: ['pm25_in_24h_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN indoor PM2.5, 24h average', sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'pm10_in_aqin', keys: ['pm10_in_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN indoor PM10 mass density', sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'pm10_in_24h_aqin', keys: ['pm10_in_24h_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN indoor PM10, 24h average', sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'co2_in_aqin', keys: ['co2_in_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN indoor CO2 concentration', sourceUnit: 'ppm', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'co2_in_24h_aqin', keys: ['co2_in_24h_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN indoor CO2, 24h average', sourceUnit: 'ppm', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'pm_in_temp_aqin', keys: ['pm_in_temp_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN internal temperature', sourceUnit: 'fahrenheit', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'pm_in_humidity_aqin', keys: ['pm_in_humidity_aqin'], class: 'measurement', disposition: 'implemented-native',
    meaning: 'AQIN internal relative humidity', sourceUnit: 'percent', batteryField: 'batt_co2', evidence: WIKI },
  { family: 'aqi_pm25_aqin', keys: ['aqi_pm25_aqin'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'AQIN PM2.5 air-quality INDEX', evidence: WIKI,
    notes: 'Index semantics, not mass density: needs a verified AirQuality categorization and/or an extended numeric index (P3).' },
  { family: 'aqi_pm25_24h_aqin', keys: ['aqi_pm25_24h_aqin'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'AQIN PM2.5 AQI, 24h average', evidence: WIKI, notes: 'Index semantics, not mass density (P3).' },
  { family: 'aqi_pm10_aqin', keys: ['aqi_pm10_aqin'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'AQIN PM10 AQI', evidence: WIKI, notes: 'Index semantics, not mass density (P3).' },
  { family: 'aqi_pm10_24h_aqin', keys: ['aqi_pm10_24h_aqin'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'AQIN PM10 AQI, 24h average', evidence: WIKI, notes: 'Index semantics, not mass density (P3).' },
  { family: 'aqi_pm25_in', keys: ['aqi_pm25_in'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Indoor PM2.5 AQI', evidence: WIKI, notes: 'Index semantics, not mass density (P3).' },
  { family: 'aqi_pm25_in_24h', keys: ['aqi_pm25_in_24h'], class: 'measurement', disposition: 'catalog-gap',
    meaning: 'Indoor PM2.5 AQI, 24h average', evidence: WIKI, notes: 'Index semantics, not mass density (P3).' },

  // ---- Lightning -----------------------------------------------------
  { family: 'lightning_day', keys: ['lightning_day'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Lightning strikes since local midnight', sourceUnit: 'count', batteryField: 'batt_lightning', evidence: WIKI },
  { family: 'lightning_hour', keys: ['lightning_hour'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Lightning strikes in the last hour', sourceUnit: 'count', batteryField: 'batt_lightning', evidence: WIKI },
  { family: 'lightning_time', keys: ['lightning_time'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Time of last strike', encoding: 'epoch ms', batteryField: 'batt_lightning', evidence: WIKI },
  { family: 'lightning_distance', keys: ['lightning_distance'], class: 'measurement', disposition: 'implemented-extended',
    meaning: 'Distance of last strike', sourceUnit: 'mi', batteryField: 'batt_lightning', evidence: WIKI },

  // ---- Battery / status auxiliaries ---------------------------------
  { family: 'battout', keys: ['battout'], class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Outdoor sensor array battery status', encoding: 'Documented as 0/1; polarity NOT uniform across fields/devices — verify per field before decoding changes', evidence: WIKI },
  { family: 'battin', keys: ['battin'], class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Indoor console battery status', encoding: 'Documented as 0/1; polarity needs per-field verification', evidence: WIKI },
  { family: 'batt1...batt10', indexed: { prefix: 'batt', from: 1, to: 10 }, class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'WH31 channel battery status', encoding: 'Documented as 0/1; polarity needs per-field verification', evidence: WIKI },
  { family: 'batt_25', keys: ['batt_25'], class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Standalone PM2.5 sensor battery status', encoding: 'Deliberately unbound to rows pending device evidence', evidence: WIKI },
  { family: 'batt_lightning', keys: ['batt_lightning'], class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Lightning detector battery status',
    encoding: 'EVIDENCE CONFLICT: the deployed decoder reads 0 as low, yet a real device reports batt_lightning=1 with '
      + 'healthy batteries shown low upstream — field/device-specific verification required before any polarity change',
    evidence: WIKI + ' + live-device observation (README lightning-battery note)' },
  { family: 'batleak1...batleak4', indexed: { prefix: 'batleak', from: 1, to: 4 }, class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Leak detector battery status', encoding: 'Association/polarity/ownership design pending (with leak support, P3)', evidence: WIKI },
  { family: 'battsm1...battsm4', indexed: { prefix: 'battsm', from: 1, to: 4 }, class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Soil-moisture sensor battery status', encoding: 'Association/polarity/ownership design pending (with soil support, P3)', evidence: WIKI },
  { family: 'batt_co2', keys: ['batt_co2'], class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'AQIN / CO2 sensor battery status', encoding: 'Documented as 0/1; polarity needs per-field verification', evidence: WIKI },
  { family: 'batt_cellgateway', keys: ['batt_cellgateway'], class: 'battery-auxiliary', disposition: 'auxiliary',
    meaning: 'Cellular gateway battery/status', encoding: 'Gateway status needs an explicit auxiliary disposition (P3)', evidence: WIKI },

  // ---- Relays ---------------------------------------------------------
  { family: 'relay1...relay10', indexed: { prefix: 'relay', from: 1, to: 10 }, class: 'relay-state', disposition: 'state-unsupported',
    meaning: 'Reported relay state', encoding: 'Read-only reported state; NOT evidence of a writable control API — no switch commands are invented', evidence: WIKI },

  // ---- Metadata -------------------------------------------------------
  { family: 'tz', keys: ['tz'], class: 'metadata', disposition: 'metadata',
    meaning: 'Station timezone name', encoding: 'text', evidence: WIKI },
  { family: 'dateutc', keys: ['dateutc'], class: 'metadata', disposition: 'metadata',
    meaning: 'Sample timestamp', encoding: 'epoch ms', evidence: WIKI,
    notes: 'Never an AUTOMATIC accessory. Explicit user assignment remains possible (a live installation assigns it as "Last Report") — assignments outrank the catalog by design.' },
  { family: 'date', keys: ['date'], class: 'metadata', disposition: 'metadata',
    meaning: 'Sample timestamp', encoding: 'ISO-8601 string', evidence: WIKI },
];

/** Expand an entry to its concrete keys. */
export function expandCatalogKeys(entry: CatalogEntry): string[] {
  if (entry.keys) {
    return [...entry.keys];
  }
  const { prefix, suffix = '', from, to } = entry.indexed!;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    out.push(`${prefix}${n}${suffix}`);
  }
  return out;
}

/** The battery field an entry declares for a concrete key, if any. */
export function catalogBatteryFieldFor(entry: CatalogEntry, key: string): string | null | undefined {
  if (entry.batteryField === undefined || entry.batteryField === null) {
    return entry.batteryField;
  }
  if (!entry.indexed) {
    return entry.batteryField;
  }
  const { prefix, suffix = '' } = entry.indexed;
  const n = key.slice(prefix.length, suffix ? -suffix.length : undefined);
  return entry.batteryField.replace('{n}', n);
}

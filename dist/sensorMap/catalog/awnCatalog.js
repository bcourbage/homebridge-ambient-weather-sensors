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
 * Implemented and compat entries state their expected resolved
 * identity (`kind` / `measurement` / `sourceUnit`), and the suite
 * compares the VALUES against the production resolution — presence
 * alone proves nothing.
 *
 * Provenance: the published baseline is AWN's Device Data Specs wiki,
 * commit e1c13509fdcad8ad7b212e77b8193dac71e241b5 (last published edit
 * 2023-08-07). The published list is not proof that every firmware
 * field is documented; entries carry their own evidence notes where
 * they extend or contradict it. Evidence sources are kept SEPARATE and
 * verbatim — the vendor's declared encoding, the deployed decoder's
 * behavior, and any live-device observation are three distinct facts,
 * recorded as such even (especially) where they disagree. Recorded
 * uncertainty is deliberate: resolving it is P2/P3 work, not this
 * file's job.
 */
/** Bump when entries/families are added, removed, or re-dispositioned. */
export const AWN_CATALOG_VERSION = 1;
/** The published baseline this inventory was audited against. */
export const AWN_WIKI_BASELINE = 'e1c13509fdcad8ad7b212e77b8193dac71e241b5';
const WIKI = `AWN Device Data Specs wiki @ ${AWN_WIKI_BASELINE}`;
export const AWN_CATALOG = [
    // ---- Wind --------------------------------------------------------
    { family: 'winddir', keys: ['winddir'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Instantaneous wind direction', kind: 'motion', measurement: 'direction',
        sourceUnit: 'degrees', batteryField: 'battout', evidence: WIKI },
    { family: 'windspeedmph', keys: ['windspeedmph'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Instantaneous wind speed', kind: 'motion', measurement: 'wind-speed',
        sourceUnit: 'mph', batteryField: 'battout', evidence: WIKI },
    { family: 'windgustmph', keys: ['windgustmph'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Maximum wind speed in the last 10 minutes', kind: 'motion', measurement: 'wind-speed',
        sourceUnit: 'mph', batteryField: 'battout', evidence: WIKI },
    { family: 'maxdailygust', keys: ['maxdailygust'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Maximum wind speed since local midnight', kind: 'motion', measurement: 'wind-speed',
        sourceUnit: 'mph', batteryField: 'battout', evidence: WIKI },
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
        meaning: 'Average wind direction, 10-minute window', kind: 'motion', measurement: 'direction',
        sourceUnit: 'degrees', batteryField: 'battout', evidence: WIKI },
    // ---- Temperature / humidity (outdoor, indoor, channels) ----------
    { family: 'tempf', keys: ['tempf'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Outdoor temperature', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'battout', evidence: WIKI },
    { family: 'tempinf', keys: ['tempinf'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Indoor (console) temperature', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'battin', evidence: WIKI },
    { family: 'temp1f...temp10f', indexed: { prefix: 'temp', suffix: 'f', from: 1, to: 10, staticThrough: 10 },
        class: 'measurement', disposition: 'implemented-native',
        meaning: 'WH31 channel temperature', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'batt{n}', evidence: WIKI },
    { family: 'humidity', keys: ['humidity'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Outdoor relative humidity', kind: 'humidity', measurement: 'humidity',
        sourceUnit: 'percent', batteryField: 'battout', evidence: WIKI },
    { family: 'humidityin', keys: ['humidityin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Indoor (console) relative humidity', kind: 'humidity', measurement: 'humidity',
        sourceUnit: 'percent', batteryField: 'battin', evidence: WIKI },
    { family: 'humidity1...humidity10', indexed: { prefix: 'humidity', from: 1, to: 10, staticThrough: 10 },
        class: 'measurement', disposition: 'implemented-native',
        meaning: 'WH31 channel relative humidity', kind: 'humidity', measurement: 'humidity',
        sourceUnit: 'percent', batteryField: 'batt{n}', evidence: WIKI },
    { family: 'feelsLike', keys: ['feelsLike'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Outdoor feels-like temperature (derived)', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'battout', evidence: WIKI },
    { family: 'feelsLikein', keys: ['feelsLikein'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Indoor feels-like temperature (derived)', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'battin', evidence: WIKI },
    { family: 'feelsLike1...feelsLike10', indexed: { prefix: 'feelsLike', from: 1, to: 10, staticThrough: 4 },
        class: 'measurement', disposition: 'compat-fallback',
        meaning: 'Channel feels-like temperature (derived)', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'batt{n}', evidence: WIKI,
        notes: 'Indexes 1..4 are static; 5..10 resolve via the fallback. Anchored definition in P2.' },
    { family: 'dewPoint', keys: ['dewPoint'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Outdoor dew point (derived)', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'battout', evidence: WIKI },
    { family: 'dewPointin', keys: ['dewPointin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Indoor dew point (derived)', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'battin', evidence: WIKI },
    { family: 'dewPoint1...dewPoint10', indexed: { prefix: 'dewPoint', from: 1, to: 10, staticThrough: 4 },
        class: 'measurement', disposition: 'compat-fallback',
        meaning: 'Channel dew point (derived)', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'batt{n}', evidence: WIKI,
        notes: 'Indexes 1..4 are static; 5..10 resolve via the fallback. Anchored definition in P2.' },
    { family: 'soiltemp1f...soiltemp10f', indexed: { prefix: 'soiltemp', suffix: 'f', from: 1, to: 10 },
        class: 'measurement', disposition: 'compat-fallback',
        meaning: 'Soil temperature probe', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: null, evidence: WIKI,
        notes: 'Recognized only via the fallback today. Anchored definition in P2; battery family (battsm{n}?) needs device evidence.' },
    // ---- Soil / leaf / agronomic gaps --------------------------------
    { family: 'soilhum1...soilhum10', indexed: { prefix: 'soilhum', from: 1, to: 10 },
        class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Soil moisture', sourceUnit: 'percent', evidence: WIKI,
        notes: 'Soil-moisture semantics and extended output required — NOT air humidity merely because both use %. '
            + 'The wiki row itself is mislabeled "Temperature 1...10" (source copy error); its declared unit % stands.' },
    { family: 'leafwetness1...leafwetness8', indexed: { prefix: 'leafwetness', from: 1, to: 8 },
        class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Leaf wetness', sourceUnit: 'percent', evidence: WIKI,
        notes: 'Declared "Int, %". Leaf-wetness semantics and extended output required.' },
    { family: 'soiltens1...soiltens4', indexed: { prefix: 'soiltens', from: 1, to: 4 },
        class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Soil tension', sourceUnit: 'cb', evidence: WIKI,
        notes: 'Declared "Float, cb" (centibar). Soil-tension presentation required — not weather-pressure wording.' },
    { family: 'gdd', keys: ['gdd'], class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Growing degree days (accumulation)', sourceUnit: 'days', evidence: WIKI,
        notes: 'Declared "Int, days" verbatim — dimensionally odd for a degree-day accumulation. '
            + 'Declared-vs-meaning discrepancy recorded; resolve against device evidence before conversions exist (P3).' },
    { family: 'etos', keys: ['etos'], class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Evapotranspiration, short reference crop', sourceUnit: 'in/day', evidence: WIKI,
        notes: 'Declared "Float, in/day" — a daily rate must not be reinterpreted as hourly (P3).' },
    { family: 'etrs', keys: ['etrs'], class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Evapotranspiration, tall reference crop', sourceUnit: 'in/day', evidence: WIKI,
        notes: 'Declared "Float, in/day" — a daily rate must not be reinterpreted as hourly (P3).' },
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
        meaning: 'Rain rate (hourly)', kind: 'motion', measurement: 'rain-rate',
        sourceUnit: 'in_per_hr', batteryField: 'battout', evidence: WIKI },
    { family: 'dailyrainin', keys: ['dailyrainin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Rain since local midnight', kind: 'motion', measurement: 'rain-accumulation',
        sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
    { family: '24hourrainin', keys: ['24hourrainin'], class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Rain in the last 24 hours (rolling)', sourceUnit: 'in', evidence: WIKI,
        notes: 'Existing accumulation wrapper can render (P2).' },
    { family: 'weeklyrainin', keys: ['weeklyrainin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Rain this week', kind: 'motion', measurement: 'rain-accumulation',
        sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
    { family: 'monthlyrainin', keys: ['monthlyrainin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Rain this month', kind: 'motion', measurement: 'rain-accumulation',
        sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
    { family: 'yearlyrainin', keys: ['yearlyrainin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Rain this year', kind: 'motion', measurement: 'rain-accumulation',
        sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
    { family: 'eventrainin', keys: ['eventrainin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Rain in the current event', kind: 'motion', measurement: 'rain-accumulation',
        sourceUnit: 'in', batteryField: 'battout', evidence: WIKI },
    { family: 'totalrainin', keys: ['totalrainin'], class: 'measurement', disposition: 'catalog-gap',
        meaning: 'Rain since last factory reset (lifetime)', sourceUnit: 'in', evidence: WIKI,
        notes: 'Existing accumulation wrapper can render (P2).' },
    { family: 'lastRain', keys: ['lastRain'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Time of last recorded rain', kind: 'motion', measurement: 'timestamp',
        encoding: 'ISO-8601 string; the plugin parses to epoch ms ("never" invalid-string parses to 0, v1.7 parity)',
        batteryField: 'battout', evidence: WIKI },
    // ---- Pressure / sun -----------------------------------------------
    { family: 'baromrelin', keys: ['baromrelin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Relative (sea-level) barometric pressure', kind: 'motion', measurement: 'pressure',
        sourceUnit: 'inHg', batteryField: 'battin', evidence: WIKI },
    { family: 'baromabsin', keys: ['baromabsin'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Absolute (station) barometric pressure', kind: 'motion', measurement: 'pressure',
        sourceUnit: 'inHg', batteryField: 'battin', evidence: WIKI },
    { family: 'uv', keys: ['uv'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'UV index', kind: 'motion', measurement: 'uv-index',
        sourceUnit: 'index', batteryField: 'battout', evidence: WIKI },
    { family: 'solarradiation', keys: ['solarradiation'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Solar irradiance', kind: 'light', measurement: 'illuminance', sourceUnit: 'wm2',
        encoding: 'Rendered as illuminance via the deployed W/m2-to-lux approximation (a documented assumption, not a universal physical conversion)',
        batteryField: 'battout', evidence: WIKI },
    // ---- CO2 / particulates / AQIN ------------------------------------
    { family: 'co2', keys: ['co2'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Carbon dioxide concentration', kind: 'co2', measurement: 'co2',
        sourceUnit: 'ppm', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'co2_in (plugin extra)', keys: ['co2_in'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Indoor carbon dioxide concentration', kind: 'co2', measurement: 'co2',
        sourceUnit: 'ppm', batteryField: null,
        evidence: 'Plugin catalog with real-device provenance; ABSENT from the published wiki baseline. Working definitions are not removed because the published list omits them (#63).' },
    { family: 'pm25', keys: ['pm25'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Outdoor PM2.5 mass density', kind: 'air-quality-pm25', measurement: 'pm25',
        sourceUnit: 'ugm3', batteryField: null, evidence: WIKI,
        notes: 'Standalone-PM battery mapping (batt_25) deliberately unbound pending device evidence (existing policy).' },
    { family: 'pm25_24h', keys: ['pm25_24h'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Outdoor PM2.5, 24h average', kind: 'air-quality-pm25', measurement: 'pm25',
        sourceUnit: 'ugm3', batteryField: null, evidence: WIKI },
    { family: 'pm25_in', keys: ['pm25_in'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'Indoor PM2.5 mass density', kind: 'air-quality-pm25', measurement: 'pm25',
        sourceUnit: 'ugm3', batteryField: null, evidence: WIKI },
    { family: 'pm25_in_24h', keys: ['pm25_in_24h'], class: 'measurement', disposition: 'compat-fallback',
        meaning: 'Indoor PM2.5, 24h average', kind: 'air-quality-pm25', measurement: 'pm25',
        sourceUnit: 'ugm3', batteryField: null, evidence: WIKI,
        notes: 'Recognized only via the fallback today. Anchored definition in P2.' },
    { family: 'pm25_in_aqin', keys: ['pm25_in_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN indoor PM2.5 mass density', kind: 'air-quality-pm25', measurement: 'pm25',
        sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'pm25_in_24h_aqin', keys: ['pm25_in_24h_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN indoor PM2.5, 24h average', kind: 'air-quality-pm25', measurement: 'pm25',
        sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'pm10_in_aqin', keys: ['pm10_in_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN indoor PM10 mass density', kind: 'air-quality-pm10', measurement: 'pm10',
        sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'pm10_in_24h_aqin', keys: ['pm10_in_24h_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN indoor PM10, 24h average', kind: 'air-quality-pm10', measurement: 'pm10',
        sourceUnit: 'ugm3', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'co2_in_aqin', keys: ['co2_in_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN indoor CO2 concentration', kind: 'co2', measurement: 'co2',
        sourceUnit: 'ppm', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'co2_in_24h_aqin', keys: ['co2_in_24h_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN indoor CO2, 24h average', kind: 'co2', measurement: 'co2',
        sourceUnit: 'ppm', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'pm_in_temp_aqin', keys: ['pm_in_temp_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN internal temperature', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', batteryField: 'batt_co2', evidence: WIKI },
    { family: 'pm_in_humidity_aqin', keys: ['pm_in_humidity_aqin'], class: 'measurement', disposition: 'implemented-native',
        meaning: 'AQIN internal relative humidity', kind: 'humidity', measurement: 'humidity',
        sourceUnit: 'percent', batteryField: 'batt_co2', evidence: WIKI },
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
        meaning: 'Lightning strikes since local midnight', kind: 'motion', measurement: 'count',
        sourceUnit: 'count', batteryField: 'batt_lightning', evidence: WIKI },
    { family: 'lightning_hour', keys: ['lightning_hour'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Lightning strikes in the last hour', kind: 'motion', measurement: 'count',
        sourceUnit: 'count', batteryField: 'batt_lightning', evidence: WIKI },
    { family: 'lightning_time', keys: ['lightning_time'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Time of last strike', kind: 'motion', measurement: 'timestamp',
        encoding: 'epoch ms', batteryField: 'batt_lightning', evidence: WIKI },
    { family: 'lightning_distance', keys: ['lightning_distance'], class: 'measurement', disposition: 'implemented-extended',
        meaning: 'Distance of last strike', kind: 'motion', measurement: 'distance',
        sourceUnit: 'mi', batteryField: 'batt_lightning', evidence: WIKI },
    // ---- Battery / status auxiliaries ---------------------------------
    // Encoding facts are recorded per source and kept separate: the
    // vendor's declared convention, the deployed decoder's behavior
    // (readBatteryLow in src/batteryFields.ts reads raw === 0 as low for
    // EVERY field), and live-device observations. Where they disagree,
    // the disagreement is the record — no polarity change in P1.
    { family: 'battout', keys: ['battout'], class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Outdoor sensor array battery status',
        encoding: 'Declared "1=OK, 0=Low", with the documented device-source variant "(Meteobridge Users 1=Low, 0=OK)" '
            + '— polarity depends on the reporting path. The deployed decoder (0 = low) matches the non-Meteobridge declaration.',
        evidence: WIKI },
    { family: 'battin', keys: ['battin'], class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Indoor console battery status',
        encoding: 'Declared "1=OK, 0=Low", Meteobridge variant "1=Low, 0=OK"; the deployed decoder matches the non-Meteobridge declaration',
        evidence: WIKI },
    { family: 'batt1...batt10', indexed: { prefix: 'batt', from: 1, to: 10 }, class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'WH31 channel battery status',
        encoding: 'Declared "1=OK, 0=Low", Meteobridge variant "1=Low, 0=OK"; the deployed decoder matches the non-Meteobridge declaration',
        evidence: WIKI },
    { family: 'batt_25', keys: ['batt_25'], class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Standalone PM2.5 sensor battery status',
        encoding: 'Declared "1=OK, 0=Low", Meteobridge variant "1=Low, 0=OK"', evidence: WIKI,
        notes: 'Deliberately unbound to rows pending device evidence (existing policy).' },
    { family: 'batt_lightning', keys: ['batt_lightning'], class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Lightning detector battery status',
        encoding: 'Vendor declares "1=Low 0=OK" — INVERTED relative to the standard (non-Meteobridge) convention of the other battery fields. '
            + 'Deployed decoder reads 0 as low (uniform across fields), contradicting the declaration here. '
            + 'Device observation: payload 0 with fresh batteries and a healthy AWN dashboard, shown low by the plugin '
            + '— consistent with the vendor declaration, inconsistent with the deployed decoder.',
        evidence: WIKI + '; deployed decoder readBatteryLow (src/batteryFields.ts); live-device observation (README lightning-battery note)',
        notes: 'No decoder change in P1; per-field polarity is P3 decoder-design input. The README workaround (batteryField: null) stands meanwhile.' },
    { family: 'batleak1...batleak4', indexed: { prefix: 'batleak', from: 1, to: 4 }, class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Leak detector battery status',
        encoding: 'Vendor declares "1=Low 0=OK" — INVERTED relative to the standard (non-Meteobridge) convention of the other battery fields, like batt_lightning. '
            + 'The uniform deployed decoder would misread it; no production binding exists today.',
        evidence: WIKI + '; deployed decoder readBatteryLow (src/batteryFields.ts)',
        notes: 'Association/polarity/ownership design pending (with leak support, P3).' },
    { family: 'battsm1...battsm4', indexed: { prefix: 'battsm', from: 1, to: 4 }, class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Soil-moisture sensor battery status',
        encoding: 'Declared "1=OK, 0=Low"', evidence: WIKI,
        notes: 'Association/ownership design pending (with soil support, P3).' },
    { family: 'batt_co2', keys: ['batt_co2'], class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'AQIN / CO2 sensor battery status',
        encoding: 'Declared "1=OK, 0=Low"; the deployed decoder agrees', evidence: WIKI },
    { family: 'batt_cellgateway', keys: ['batt_cellgateway'], class: 'battery-auxiliary', disposition: 'auxiliary',
        meaning: 'Cellular gateway battery/status',
        encoding: 'Declared "1=OK, 0=Low"', evidence: WIKI,
        notes: 'Gateway status needs an explicit auxiliary disposition (P3).' },
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
export function expandCatalogKeys(entry) {
    if (entry.keys) {
        return [...entry.keys];
    }
    const { prefix, suffix = '', from, to } = entry.indexed;
    const out = [];
    for (let n = from; n <= to; n++) {
        out.push(`${prefix}${n}${suffix}`);
    }
    return out;
}
/** The battery field an entry declares for a concrete key, if any. */
export function catalogBatteryFieldFor(entry, key) {
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
//# sourceMappingURL=awnCatalog.js.map
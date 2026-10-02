/**
 * The legacy-config corpus the migration proofs share (§12.7).
 *
 * One corpus, two consumers: the row-level registration-set
 * equivalence suite (tests/regression/migrationEquivalence.test.ts)
 * and the full-HAP-graph lifecycle equivalence suite
 * (tests/regression/migrationGraphEquivalence.test.ts). Extending the
 * corpus extends both proofs.
 *
 * DEMETER_BASELINES are real captured conversion baselines: the
 * legacy-conversion-journal entries and the immutable first-conversion
 * snapshot from the maintainer's production Homebridge, recorded by
 * journalConversionBaseline/writeLegacySnapshot at each real
 * conversion (2026-08 through 2026-09). They contain only
 * LEGACY_SENSOR_FIELDS — no credentials, no station identifiers — and
 * they are the "real-shaped configs" leg of the migration proof.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import type { LegacyConfig } from '../../src/sensorMap/compat';
import { LEGACY_SENSOR_FIELDS } from '../../src/sensorMap/legacyMirror';

export interface RawStation {
  macAddress: string;
  info?: { name?: string };
  lastData: Record<string, unknown>;
}

export const OUTDOOR_STATION: RawStation = {
  macAddress: 'AA:BB:CC:DD:EE:01',
  info: { name: 'Backyard' },
  lastData: {
    // Outdoor combo array (battout).
    tempf: 68, humidity: 45, feelsLike: 67, dewPoint: 50, solarradiation: 220,
    uv: 3, windspeedmph: 8, windgustmph: 12, maxdailygust: 22,
    winddir: 180, winddir_avg10m: 175,
    hourlyrainin: 0, eventrainin: 0.02, dailyrainin: 0.1,
    weeklyrainin: 0.3, monthlyrainin: 1.2, yearlyrainin: 12,
    lastRain: '2026-07-08T18:00:00.000Z',
    battout: 1,
    // Indoor console (battin).
    tempinf: 72, humidityin: 50, feelsLikein: 72, dewPointin: 55,
    baromrelin: 30.1, baromabsin: 29.9,
    battin: 1,
    // Some AWN metadata keys that determineSensorType ignores.
    dateutc: 1720000000000, date: '2026-07-08T00:00:00Z',
  },
};

export const AQIN_STATION: RawStation = {
  macAddress: 'AA:BB:CC:DD:EE:02',
  info: { name: 'Living Room AQIN' },
  lastData: {
    co2_in_aqin: 620, co2_in_24h_aqin: 640,
    pm25_in_aqin: 8, pm25_in_24h_aqin: 12,
    pm10_in_aqin: 15, pm10_in_24h_aqin: 20,
    pm_in_temp_aqin: 72, pm_in_humidity_aqin: 46,
    batt_co2: 1,
  },
};

export const LIGHTNING_STATION: RawStation = {
  macAddress: 'AA:BB:CC:DD:EE:03',
  info: { name: 'Roof' },
  lastData: {
    lightning_day: 0, lightning_hour: 0,
    lightning_distance: 0, lightning_time: 0,
    batt_lightning: 1,
  },
};

/**
 * Gap-class station (GA review P1-1): fields the LEGACY substring
 * recognizer accepts but the finite v2 default table lacked.
 * feelsLike/dewPoint 5+ exceed the table's 1..4; soiltemp4f matches
 * legacy's includes('temp'). soilhum4 is the NEGATIVE control: 'hum'
 * is not 'humid', so 1.7 ignores it and v2 must keep it unrecognized.
 */
export const PROBE_FARM_STATION: RawStation = {
  macAddress: 'AA:BB:CC:DD:EE:04',
  info: { name: 'Probe Farm' },
  lastData: {
    temp5f: 67, humidity5: 44, feelsLike5: 66, dewPoint5: 48, batt5: 1,
    feelsLike6: 65, dewPoint6: 47,
    soiltemp4f: 55,
    soilhum4: 38,
  },
};

// ---- Matrix of legacy configs to test -----------------------------

export const CONFIG_MATRIX: Array<{ label: string; config: LegacyConfig }> = [
  { label: 'empty config', config: {} },
  { label: 'temperature only', config: { temperatureSensors: true } },
  { label: 'temperature + humidity', config: { temperatureSensors: true, humiditySensors: true } },
  { label: 'all value tiles', config: {
    temperatureSensors: true, humiditySensors: true, solarRadiationSensors: true,
    co2Sensors: true, airQualitySensors: true,
  } },
  { label: 'extended: wind only', config: { extendedSensors: true, windSensors: true } },
  { label: 'extended: wind with speed threshold disabled', config: {
    extendedSensors: true, windSensors: true,
    thresholds: { windSpeedEnabled: false },
  } },
  { label: 'extended: wind with gust threshold disabled (shared)', config: {
    extendedSensors: true, windSensors: true,
    thresholds: { windGustEnabled: false },
  } },
  { label: 'extended: rain', config: { extendedSensors: true, rainSensors: true } },
  { label: 'extended: rain with rate threshold disabled', config: {
    extendedSensors: true, rainSensors: true,
    thresholds: { rainRateEnabled: false },
  } },
  { label: 'extended: pressure (shared threshold)', config: {
    extendedSensors: true, pressureSensors: true,
  } },
  { label: 'extended: pressure with threshold disabled (both)', config: {
    extendedSensors: true, pressureSensors: true,
    thresholds: { pressureEnabled: false },
  } },
  { label: 'extended: uv', config: { extendedSensors: true, uvSensors: true } },
  { label: 'extended: uv threshold disabled', config: {
    extendedSensors: true, uvSensors: true,
    thresholds: { uvEnabled: false },
  } },
  { label: 'extended: lightning', config: { extendedSensors: true, lightningSensors: true } },
  { label: 'extended: lightning distance threshold disabled', config: {
    extendedSensors: true, lightningSensors: true,
    thresholds: { lightningDistanceEnabled: false },
  } },
  { label: 'extended master off, sub-toggles on (all should be off)', config: {
    extendedSensors: false, windSensors: true, rainSensors: true,
  } },
  { label: 'full house — every category', config: {
    temperatureSensors: true, humiditySensors: true, solarRadiationSensors: true,
    co2Sensors: true, airQualitySensors: true,
    extendedSensors: true, windSensors: true, rainSensors: true,
    pressureSensors: true, uvSensors: true, lightningSensors: true,
  } },
  { label: 'excludeSensors by sensorKey', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['tempinf'],
  } },
  { label: 'excludeSensors on gap fields (raw key + friendly name)', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['feelsLike5', 'dew point 6'],
  } },
  { label: 'excludeSensors by friendly name (case-insensitive)', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['indoor humidity'],
  } },
  { label: 'includeOnly narrow', config: {
    temperatureSensors: true, humiditySensors: true,
    includeOnly: ['tempf'],
  } },
  { label: 'includeOnly + excludeSensors combined', config: {
    temperatureSensors: true, humiditySensors: true,
    includeOnly: ['tempf', 'humidity', 'tempinf'],
    excludeSensors: ['tempinf'],
  } },
  { label: 'extendedDisplayMode: embed does not change registration set', config: {
    extendedSensors: true, windSensors: true,
    extendedDisplayMode: 'embed',
  } },
  // ---- Finding #2: station-aware include/exclude parity ----
  { label: 'excludeSensors by uniqueId (MAC-sensorKey)', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['AA:BB:CC:DD:EE:01-tempf'],
  } },
  { label: 'excludeSensors by station MAC (all rows on that station)', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['AA:BB:CC:DD:EE:01'],
  } },
  { label: 'excludeSensors by station name (all rows on that station)', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['Backyard'],
  } },
  { label: 'excludeSensors by prefixed form (station name + friendly)', config: {
    temperatureSensors: true, humiditySensors: true,
    excludeSensors: ['Backyard Outdoor Temperature'],
  } },
  { label: 'includeOnly by uniqueId keeps exactly that one', config: {
    temperatureSensors: true, humiditySensors: true,
    includeOnly: ['AA:BB:CC:DD:EE:01-tempf'],
  } },
  { label: 'includeOnly by station MAC keeps every row on that station', config: {
    temperatureSensors: true, humiditySensors: true,
    includeOnly: ['AA:BB:CC:DD:EE:01'],
  } },
  // ---- Finding #13: malformed-but-tolerated legacy values ----
  { label: 'malformed thresholds shape (object with garbage keys is ignored)', config: {
    extendedSensors: true, windSensors: true,
    thresholds: { garbageKey: 999, windSpeedMph: 20 } as never,
  } },
  { label: 'malformed units shape (unknown unit falls back to plugin default)', config: {
    extendedSensors: true, windSensors: true,
    units: { windSpeed: 'furlongs-per-fortnight' as never },
  } },
  { label: 'includeOnly with empty string entry (ignored, not a match-all)', config: {
    temperatureSensors: true,
    includeOnly: ['', 'tempf'],
  } },
  // ---- Follow-up: displayName-form entries (the 7th candidate) ----
  { label: 'excludeSensors by single-station HAP-cleaned displayName ("Outdoor PM2 5")', config: {
    airQualitySensors: true,
    excludeSensors: ['Outdoor PM2 5'],
  } },
  { label: 'excludeSensors by prefixed HAP-cleaned displayName (multi-station "Backyard Outdoor Temperature")', config: {
    temperatureSensors: true,
    excludeSensors: ['Backyard Outdoor Temperature'],
  } },
];

// ---- Payload matrix ----------------------------------------------

export const PAYLOAD_MATRIX: Array<{ label: string; stations: RawStation[] }> = [
  { label: 'outdoor + indoor', stations: [OUTDOOR_STATION] },
  { label: 'AQIN only', stations: [AQIN_STATION] },
  { label: 'lightning only', stations: [LIGHTNING_STATION] },
  { label: 'outdoor + AQIN + lightning', stations: [OUTDOOR_STATION, AQIN_STATION, LIGHTNING_STATION] },
  { label: 'numbered-probe gap fields', stations: [PROBE_FARM_STATION] },
  { label: 'outdoor + probe farm', stations: [OUTDOOR_STATION, PROBE_FARM_STATION] },
];


/**
 * The captured Demeter conversion baselines, as corpus entries.
 *
 * The loader ENFORCES the fixtures' stated contract mechanically
 * (PR #59 review F4): the envelope must be exactly the journal shape,
 * and every legacy key must be in LEGACY_SENSOR_FIELDS — the same
 * allowlist the journal writer uses — so a future production baseline
 * carrying a credential (apiKey, applicationKey, anything) fails the
 * suite instead of being committed while CI stays green.
 */
export function demeterBaselines(): Array<{ label: string; config: LegacyConfig }> {
  const dir = path.resolve(__dirname, '../fixtures/configs/demeter');
  const allowed = new Set<string>(LEGACY_SENSOR_FIELDS);
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const parsed = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['legacy', 'savedAt', 'schemaVersion'])
        || parsed.schemaVersion !== 1
        || typeof parsed.savedAt !== 'string' || Number.isNaN(Date.parse(parsed.savedAt))
        || !parsed.legacy || typeof parsed.legacy !== 'object' || Array.isArray(parsed.legacy)) {
        throw new Error(`demeter baseline ${f}: not a valid conversion-journal envelope`);
      }
      const illegal = Object.keys(parsed.legacy as Record<string, unknown>)
        .filter(k => !allowed.has(k));
      if (illegal.length > 0) {
        throw new Error(`demeter baseline ${f}: keys outside LEGACY_SENSOR_FIELDS: ${illegal.join(', ')}`);
      }
      return { label: `demeter baseline ${f} (${parsed.savedAt})`, config: parsed.legacy as LegacyConfig };
    });
}

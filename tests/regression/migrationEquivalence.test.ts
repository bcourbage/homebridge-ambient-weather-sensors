/**
 * Migration-equivalence property tests — the safety net for
 * task #65's flag flip.
 *
 * For every representative legacy config × AWN payload, the v1.6.0
 * code path (platform.parseDevices) and the v2 sensor-map pipeline
 * (compatToOverrides + buildEffectiveSensorMap) MUST agree on the
 * set of (stationMac, dataPoint) pairs to register.
 *
 * Any divergence surfaces the divergence in the test log, not in
 * a user's Homebridge log post-flag-flip. This is what makes retiring
 * Path B safe.
 *
 * NOT tested here (deferred to real integration on solmssen's setup
 * during the shadow-mode bake per task #65 milestone 2):
 *   - Live AWN payload shapes we haven't captured a fixture for
 *   - Realtime websocket delivery paths (both v1 and v2 flow through
 *     the same delivery layer today; equivalence there is trivially
 *     true)
 *   - Multi-home child-bridge combinations
 */

import { describe, expect, it } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { buildEffectiveSensorMap } from '../../src/sensorMap/buildEffectiveMap';
import { compatToOverrides, type LegacyConfig } from '../../src/sensorMap/compat';
import type {
  DiscoveryStore,
  EffectiveSensorRow,
  StationInventory,
  UiStateStore,
} from '../../src/sensorMap/types';
import { MockAPI, MockLogger } from '../helpers/mockHomebridge';

/** Build a real platform with a mocked HB API + logger. */
function makePlatform(config: Record<string, unknown>): AmbientWeatherSensorsPlatform {
  return new AmbientWeatherSensorsPlatform(
    new MockLogger() as never,
    { platform: 'AmbientWeatherSensors', ...config } as never,
    new MockAPI() as never,
  );
}

/**
 * v1.6.0 pipeline: run the real parseDevices against a payload,
 * return the set of `${mac}|${dataPoint}` pairs that got registered.
 */
function v1RegisteredSet(config: LegacyConfig, stations: RawStation[]): Set<string> {
  const platform = makePlatform(config as Record<string, unknown>);
  const devices = platform.parseDevices(stations);
  return new Set(
    devices.map(d => `${d.macAddress.toUpperCase()}|${uniqueIdTail(d.uniqueId, d.macAddress)}`),
  );
}

/**
 * v2 pipeline: compat → buildEffectiveSensorMap, filter to enabled
 * configured rows AWN actually reported, return the same
 * `${mac}|${dataPoint}` shape.
 */
function v2RegisteredSet(config: LegacyConfig, stations: RawStation[]): Set<string> {
  const overrides = compatToOverrides(config);
  const inventory: StationInventory = stations.map(s => ({
    macAddress: s.macAddress,
    name: s.info?.name ?? '',
  }));
  const discovery: DiscoveryStore = { schemaVersion: 1, entries: [] };
  for (const s of stations) {
    for (const key of Object.keys(s.lastData)) {
      discovery.entries.push({
        stationMac: s.macAddress,
        stationName: s.info?.name ?? '',
        dataPoint: key,
        firstSeen: '2026-07-10T00:00:00.000Z',
        lastSeen: '2026-07-10T00:00:00.000Z',
      });
    }
  }
  const uiState: UiStateStore = { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
  const result = buildEffectiveSensorMap({
    userOverrides: overrides,
    discovery,
    uiState,
    stations: inventory,
    configMode: 'legacy',
  });

  // Only pairs AWN observed this tick + row enabled + not unrecognized.
  const observedKeys = new Set<string>();
  for (const s of stations) {
    for (const k of Object.keys(s.lastData)) {
      observedKeys.add(`${s.macAddress.toUpperCase()}|${k}`);
    }
  }
  const out = new Set<string>();
  for (const row of result.rows) {
    const key = `${row.stationMac.toUpperCase()}|${row.dataPoint}`;
    if (!observedKeys.has(key)) {
      continue;
    }
    if (isEnabledConfiguredRow(row)) {
      out.add(key);
    }
  }
  return out;
}

function isEnabledConfiguredRow(row: EffectiveSensorRow): boolean {
  return row.kind !== 'unrecognized' && row.enabled;
}

/**
 * uniqueId is `${mac}-${dataPoint}`. Reverse it by stripping the
 * MAC prefix + separator. Anchored so the dataPoint may itself
 * contain hyphens or underscores.
 */
function uniqueIdTail(uniqueId: string, mac: string): string {
  return uniqueId.startsWith(`${mac}-`) ? uniqueId.slice(mac.length + 1) : uniqueId;
}

// ---- Fixtures -----------------------------------------------------

interface RawStation {
  macAddress: string;
  info?: { name?: string };
  lastData: Record<string, unknown>;
}

const OUTDOOR_STATION: RawStation = {
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

const AQIN_STATION: RawStation = {
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

const LIGHTNING_STATION: RawStation = {
  macAddress: 'AA:BB:CC:DD:EE:03',
  info: { name: 'Roof' },
  lastData: {
    lightning_day: 0, lightning_hour: 0,
    lightning_distance: 0, lightning_time: 0,
    batt_lightning: 1,
  },
};

// ---- Matrix of legacy configs to test -----------------------------

const CONFIG_MATRIX: Array<{ label: string; config: LegacyConfig }> = [
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
];

// ---- Payload matrix ----------------------------------------------

const PAYLOAD_MATRIX: Array<{ label: string; stations: RawStation[] }> = [
  { label: 'outdoor + indoor', stations: [OUTDOOR_STATION] },
  { label: 'AQIN only', stations: [AQIN_STATION] },
  { label: 'lightning only', stations: [LIGHTNING_STATION] },
  { label: 'outdoor + AQIN + lightning', stations: [OUTDOOR_STATION, AQIN_STATION, LIGHTNING_STATION] },
];

// ---- The property test -------------------------------------------

describe('migration equivalence — v1.6.0 vs v2 sensor map', () => {
  for (const { label: cfgLabel, config } of CONFIG_MATRIX) {
    for (const { label: payloadLabel, stations } of PAYLOAD_MATRIX) {
      it(`registers the same set: ${cfgLabel} / ${payloadLabel}`, () => {
        const v1 = v1RegisteredSet(config, stations);
        const v2 = v2RegisteredSet(config, stations);
        const missingInV2 = [...v1].filter(k => !v2.has(k));
        const extraInV2 = [...v2].filter(k => !v1.has(k));
        expect(
          { missingInV2, extraInV2 },
          `v1 vs v2 registration mismatch:\n  v1: ${[...v1].sort().join(', ')}\n  v2: ${[...v2].sort().join(', ')}`,
        ).toEqual({ missingInV2: [], extraInV2: [] });
      });
    }
  }
});

describe('migration equivalence — battery-field suppression', () => {
  for (const [suppressLabel, excludeEntries] of [
    ['raw battery field', ['battout']],
    ['friendlyName-batt suffix', ['Outdoor Temperature-batt']],
    ['sensorKey-batt suffix', ['tempf-batt']],
  ] as const) {
    it(`applies the same batteryField=null: ${suppressLabel}`, () => {
      const config: LegacyConfig = {
        temperatureSensors: true, humiditySensors: true,
        extendedSensors: true, windSensors: true, rainSensors: true, uvSensors: true,
        excludeSensors: [...excludeEntries],
      };
      const stations = [OUTDOOR_STATION];
      // v1 baseline: parseDevices marks batteryLow undefined on the
      // canonical (tempf) row and leaves other outdoor rows unaffected.
      const platform = makePlatform(config as Record<string, unknown>);
      const v1Devices = platform.parseDevices(stations);
      const v1Tempf = v1Devices.find(d => d.uniqueId.endsWith('-tempf'));
      expect(v1Tempf?.batteryLow).toBeUndefined();

      // v2: the tempf row's batteryField/hasBatterySubService both flip.
      const overrides = compatToOverrides(config);
      const result = buildEffectiveSensorMap({
        userOverrides: overrides,
        discovery: {
          schemaVersion: 1,
          entries: Object.keys(stations[0].lastData).map(dp => ({
            stationMac: stations[0].macAddress,
            stationName: stations[0].info?.name ?? '',
            dataPoint: dp,
            firstSeen: '2026-07-10T00:00:00Z',
            lastSeen: '2026-07-10T00:00:00Z',
          })),
        },
        uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
        stations: [{ macAddress: stations[0].macAddress, name: stations[0].info?.name ?? '' }],
        configMode: 'legacy',
      });
      const v2Tempf = result.rows.find(
        r => r.dataPoint === 'tempf' && r.kind !== 'unrecognized',
      );
      expect(v2Tempf).toBeDefined();
      if (v2Tempf && v2Tempf.kind !== 'unrecognized') {
        expect(v2Tempf.batteryField).toBeNull();
        expect(v2Tempf.hasBatterySubService).toBe(false);
      }
    });
  }
});

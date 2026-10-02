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
import { compatToOverrides, dynamicDataPointsFrom, type LegacyConfig } from '../../src/sensorMap/compat';
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
  const inventory: StationInventory = stations.map(s => ({
    macAddress: s.macAddress,
    name: s.info?.name ?? '',
  }));
  // Pass the inventory so include/exclude matchers use the full v1
  // seven-candidate list (finding #2). Without this the pair-set
  // comparison silently diverges on any station-scoped entry.
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
  // The compat projection gates dynamic (beyond-the-static-table)
  // fields from discovery, exactly as the runtime does (GA review
  // P1-1).
  const overrides = compatToOverrides(config, inventory, dynamicDataPointsFrom(discovery));
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

// The corpus (stations, legacy configs, payload pairings) is shared
// with the full-HAP-graph lifecycle suite — one corpus, two proofs.
import {
  AQIN_STATION,
  CONFIG_MATRIX,
  LIGHTNING_STATION,
  OUTDOOR_STATION,
  PAYLOAD_MATRIX,
  type RawStation,
} from '../helpers/legacyConfigCorpus';

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

// ---- Finding #13: full-body equivalence for user-facing knobs ----
//
// The pair-set check above ensures both pipelines register the SAME
// set of accessories. It says nothing about whether they configure
// those accessories the SAME WAY. That's exactly how the
// `pressureLowInHg` typo (finding #3) sat in the tree without CI
// noticing.
//
// This block spot-checks the knobs users actually feel:
//   - threshold value (both pipelines see the same threshold)
//   - displayUnit  (both pipelines see the same unit)
//   - batteryField presence (battery sub-service parity)
//   - name         (embedded-name / prefixed-form parity)
//
// Full HAP-service-graph equivalence (instantiate both wrappers,
// compare services + characteristics + subtypes + metadata) is a
// bigger project and lives on the v2.0.0 GA task list; the spot
// checks here catch the drift classes the review flagged.
describe('migration equivalence — threshold/unit/battery/name body parity (finding #13)', () => {
  function v2Row(config: LegacyConfig, station: RawStation, dataPoint: string) {
    const overrides = compatToOverrides(
      config,
      [{ macAddress: station.macAddress, name: station.info?.name ?? '' }],
    );
    const result = buildEffectiveSensorMap({
      userOverrides: overrides,
      discovery: {
        schemaVersion: 1,
        entries: Object.keys(station.lastData).map(dp => ({
          stationMac: station.macAddress,
          stationName: station.info?.name ?? '',
          dataPoint: dp,
          firstSeen: '2026-07-10T00:00:00Z',
          lastSeen: '2026-07-10T00:00:00Z',
        })),
      },
      uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
      stations: [{ macAddress: station.macAddress, name: station.info?.name ?? '' }],
      configMode: 'legacy',
    });
    return result.rows.find(
      r => r.dataPoint === dataPoint && r.stationMac.toUpperCase() === station.macAddress.toUpperCase(),
    );
  }

  it('pressure: threshold flows from legacy config to v2 row (pressureInHg parity, finding #3)', () => {
    // The pressureLowInHg typo (finding #3) meant compat was reading
    // a phantom field; v2 rows had threshold undefined regardless of
    // what the user set. This test guards the corrected access path.
    const config: LegacyConfig = {
      extendedSensors: true, pressureSensors: true,
      thresholds: { pressureEnabled: true, pressureInHg: 29.6 },
    };
    const row = v2Row(config, OUTDOOR_STATION, 'baromabsin');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.threshold).toBe(29.6);
    }
  });

  it('wind: threshold flows from config to v2 row', () => {
    const config: LegacyConfig = {
      extendedSensors: true, windSensors: true,
      thresholds: { windSpeedEnabled: true, windSpeedMph: 30 },
    };
    const row = v2Row(config, OUTDOOR_STATION, 'windspeedmph');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.threshold).toBe(30);
    }
  });

  it('rain: rate threshold flows from config to v2 row', () => {
    const config: LegacyConfig = {
      extendedSensors: true, rainSensors: true,
      thresholds: { rainRateEnabled: true, rainRateInHr: 0.5 },
    };
    const row = v2Row(config, OUTDOOR_STATION, 'hourlyrainin');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.threshold).toBe(0.5);
    }
  });

  it('units: windSpeed override flows to v2 displayUnit', () => {
    const config: LegacyConfig = {
      extendedSensors: true, windSensors: true,
      units: { windSpeed: 'kph' },
    };
    const row = v2Row(config, OUTDOOR_STATION, 'windspeedmph');
    expect(row).toBeDefined();
    if (row && row.measurement === 'wind-speed') {
      expect(row.displayUnit).toBe('kph');
    }
  });

  it('embed mode: extendedDisplayMode: embed sets embedName on extended rows', () => {
    const config: LegacyConfig = {
      extendedSensors: true, windSensors: true,
      extendedDisplayMode: 'embed',
    };
    const row = v2Row(config, OUTDOOR_STATION, 'windspeedmph');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.embedName).toBe(true);
    }
  });

  it('battery suppression via `<sensor>-batt` clears batteryField on the canonical row', () => {
    const config: LegacyConfig = {
      temperatureSensors: true, humiditySensors: true, extendedSensors: true, windSensors: true,
      excludeSensors: ['tempf-batt'],
    };
    const row = v2Row(config, OUTDOOR_STATION, 'tempf');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.batteryField).toBeNull();
      expect(row.hasBatterySubService).toBe(false);
    }
  });
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

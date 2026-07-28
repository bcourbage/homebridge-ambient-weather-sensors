import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compatToOverrides } from '../../../src/sensorMap/compat';
import { detectConfigMode } from '../../../src/sensorMap/configMode';
import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import {
  LEGACY_MIRROR_KEY,
  LEGACY_SENSOR_FIELDS,
  LEGACY_SNAPSHOT_FILE,
  composeV2ConfigSave,
  mirrorHash,
  projectLegacyMirror,
  recognizeMirror,
  writeLegacySnapshot,
} from '../../../src/sensorMap/legacyMirror';
import { emptyDiscoveryStore } from '../../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../../src/sensorMap/persistence/uiStateStore';
import { buildPlatformEffectiveMap } from '../../../src/sensorMap/platformEffectiveMap';
import type { EffectiveSensorMap, StationInventory } from '../../../src/sensorMap/types';

const MAC1 = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';
const ONE_STATION: StationInventory = [{ macAddress: MAC1, name: 'Home' }];
const TWO_STATIONS: StationInventory = [
  { macAddress: MAC1, name: 'Home' },
  { macAddress: MAC2, name: 'Cabin' },
];

function v2Map(sensorMap: unknown[], stations: StationInventory = ONE_STATION): EffectiveSensorMap {
  return buildPlatformEffectiveMap({
    config: { sensorMap },
    configMode: 'v2',
    stations,
    discovery: emptyDiscoveryStore(),
    uiState: emptyUiStateStore(),
  });
}

describe('projectLegacyMirror (finding 5 — reverse projection)', () => {
  it('all-defaults v2 map turns every category toggle on with no exclusions', () => {
    const mirror = projectLegacyMirror(v2Map([]));
    expect(mirror.temperatureSensors).toBe(true);
    expect(mirror.humiditySensors).toBe(true);
    expect(mirror.solarRadiationSensors).toBe(true);
    expect(mirror.co2Sensors).toBe(true);
    expect(mirror.airQualitySensors).toBe(true);
    expect(mirror.extendedSensors).toBe(true);
    expect(mirror.windSensors).toBe(true);
    expect(mirror.rainSensors).toBe(true);
    expect(mirror.pressureSensors).toBe(true);
    expect(mirror.uvSensors).toBe(true);
    expect(mirror.lightningSensors).toBe(true);
    expect(mirror.excludeSensors).toBeUndefined();
  });

  it('a globally-disabled known row becomes a bare excludeSensors entry', () => {
    const mirror = projectLegacyMirror(v2Map([{ dataPoint: 'humidity', enabled: false }]));
    // Category stays on (humidityin remains enabled).
    expect(mirror.humiditySensors).toBe(true);
    expect(mirror.excludeSensors).toContain('humidity');
    expect(mirror.excludeSensors!.some(e => e.includes(':'))).toBe(false);
  });

  it('a station-specific disable becomes a MAC-dataPoint exclusion', () => {
    const mirror = projectLegacyMirror(v2Map(
      [{ dataPoint: 'tempinf', stationMac: MAC2, enabled: false }],
      TWO_STATIONS,
    ));
    expect(mirror.excludeSensors).toContain(`${MAC2}-tempinf`);
    expect(mirror.excludeSensors).not.toContain('tempinf');
    expect(mirror.excludeSensors).not.toContain(`${MAC1}-tempinf`);
  });

  it('a custom row emits BOTH the station-scoped uniqueId and the bare dataPoint exclusion', () => {
    // Custom rows surface as no-wrapper errors while the table is empty
    // - both exclusion forms must still be emitted, or v1.7's broad
    // includes("temp") matcher would build a WRONG wrapper for barn_temp.
    const mirror = projectLegacyMirror(v2Map(
      [{ dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'celsius' }],
      TWO_STATIONS,
    ));
    expect(mirror.excludeSensors).toContain('barn_temp');
    expect(mirror.excludeSensors).toContain(`${MAC1}-barn_temp`);
    expect(mirror.excludeSensors).toContain(`${MAC2}-barn_temp`);
  });

  it('batteryField: null on a canonical row mirrors as the raw batt* field name', () => {
    const mirror = projectLegacyMirror(v2Map([{ dataPoint: 'lightning_day', batteryField: null }]));
    expect(mirror.excludeSensors).toContain('batt_lightning');
  });

  it('thresholds and non-default display units project; conflicts fall back to the lowest station MAC', () => {
    const mirror = projectLegacyMirror(v2Map(
      [
        { dataPoint: 'uv', threshold: 7 },
        // Family-uniform wind unit (v1.7's units.windSpeed is family-wide).
        { dataPoint: 'windspeedmph', displayUnit: 'kph' },
        { dataPoint: 'windgustmph', displayUnit: 'kph' },
        { dataPoint: 'maxdailygust', displayUnit: 'kph' },
        // Station-conflicting thresholds: MAC1 wins (lowest MAC).
        { dataPoint: 'hourlyrainin', stationMac: MAC1, threshold: 0.5 },
        { dataPoint: 'hourlyrainin', stationMac: MAC2, threshold: 2.0 },
      ],
      TWO_STATIONS,
    ));
    expect(mirror.thresholds?.uv).toBe(7);
    expect(mirror.units?.windSpeed).toBe('kph');
    expect(mirror.thresholds?.rainRateInHr).toBe(0.5);
  });

  it('a family-MIXED display unit is omitted (not v1-expressible; v1.7 default applies on downgrade)', () => {
    const mirror = projectLegacyMirror(v2Map([
      { dataPoint: 'windspeedmph', displayUnit: 'kph' },
      // windgustmph + maxdailygust stay at the mph default → mixed family.
    ]));
    expect(mirror.units?.windSpeed).toBeUndefined();
  });

  it('embed mode mirrors only when EVERY enabled motion row embeds', () => {
    const all = projectLegacyMirror(v2Map([
      // Global embed for every motion row is impractical to express row
      // by row here; flip two and confirm partial does NOT set embed.
      { dataPoint: 'uv', embedName: true },
    ]));
    expect(all.extendedDisplayMode).toBeUndefined();
  });
});

describe('mirrorHash + recognizeMirror', () => {
  it('is stable across key order and ignores non-legacy fields', () => {
    const a = mirrorHash({ temperatureSensors: true, excludeSensors: ['x'], apiKey: 'secret' });
    const b = mirrorHash({ excludeSensors: ['x'], temperatureSensors: true, applicationKey: 'other' });
    expect(a).toBe(b);
  });

  it('classifies absent / recognized / stale', () => {
    expect(recognizeMirror({}).state).toBe('absent');
    const fields = { temperatureSensors: true };
    const good = { ...fields, [LEGACY_MIRROR_KEY]: { version: 1, hash: mirrorHash(fields) } };
    expect(recognizeMirror(good).state).toBe('recognized');
    const stale = { temperatureSensors: false, [LEGACY_MIRROR_KEY]: { version: 1, hash: mirrorHash(fields) } };
    expect(recognizeMirror(stale).state).toBe('stale');
  });

  it('detectConfigMode suppresses the ambiguity warning ONLY for a recognized mirror', () => {
    const map = v2Map([]);
    const { nextConfig } = composeV2ConfigSave({ apiKey: 'k' }, [], map);
    // Recognized mirror: v2 mode, silent.
    const recognized = detectConfigMode(nextConfig as never);
    expect(recognized.mode).toBe('v2');
    expect(recognized.warnings).toHaveLength(0);

    // Hand-edit a mirrored field: stale warning names the hashes.
    const edited = { ...nextConfig, temperatureSensors: false };
    const stale = detectConfigMode(edited as never);
    expect(stale.mode).toBe('v2');
    expect(stale.warnings.some(w => w.includes('STALE'))).toBe(true);

    // No metadata at all: the original ambiguity warning.
    const bare = { configVersion: 2, sensorMap: [], temperatureSensors: true };
    const ambiguous = detectConfigMode(bare as never);
    expect(ambiguous.warnings.some(w => w.includes('takes precedence'))).toBe(true);
  });
});

describe('composeV2ConfigSave', () => {
  it('extracts the legacy snapshot, strips legacy fields, and stamps mirror + metadata', () => {
    const current = {
      apiKey: 'secret', applicationKey: 'secret2', stationFilter: ['Home'],
      temperatureSensors: true, excludeSensors: ['tempinf'], thresholds: { uv: 6 },
    };
    const map = v2Map([{ dataPoint: 'humidity', enabled: false }]);
    const { snapshot, nextConfig } = composeV2ConfigSave(current, [{ dataPoint: 'humidity', enabled: false }], map);

    // Snapshot = exactly the legacy fields being removed. Never secrets.
    expect(snapshot).toEqual({ temperatureSensors: true, excludeSensors: ['tempinf'], thresholds: { uv: 6 } });
    expect(Object.keys(snapshot!)).not.toContain('apiKey');

    // Next config: v2 + sensorMap + mirror + metadata; live fields kept.
    expect(nextConfig.configVersion).toBe(2);
    expect(nextConfig.sensorMap).toEqual([{ dataPoint: 'humidity', enabled: false }]);
    expect(nextConfig.apiKey).toBe('secret');
    expect(nextConfig.stationFilter).toEqual(['Home']);
    expect(nextConfig.temperatureSensors).toBe(true);          // mirrored, not the old value by accident
    expect((nextConfig.excludeSensors as string[])).toContain('humidity');
    expect(recognizeMirror(nextConfig).state).toBe('recognized');
  });

  it('already-migrated config (no legacy fields) yields no snapshot payload', () => {
    const map = v2Map([]);
    const { snapshot } = composeV2ConfigSave({ apiKey: 'k', configVersion: 2, sensorMap: [] }, [], map);
    expect(snapshot).toBeUndefined();
  });
});

describe('writeLegacySnapshot (immutable, atomic, no secrets)', () => {
  let dir: string;
  const log = { info: () => {}, warn: () => {}, debug: () => {} };

  beforeEach(async () => {
    dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'aws-snap-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes once and never overwrites (first conversion wins)', async () => {
    const first = await writeLegacySnapshot(dir, { temperatureSensors: true, apiKey: 'secret' }, log);
    expect(first).toBe('written');
    const second = await writeLegacySnapshot(dir, { temperatureSensors: false }, log);
    expect(second).toBe('exists');

    const raw = JSON.parse(await fs.readFile(nodePath.join(dir, LEGACY_SNAPSHOT_FILE), 'utf8')) as {
      legacy: Record<string, unknown>;
    };
    // First write preserved; secrets excluded by field allowlist.
    expect(raw.legacy.temperatureSensors).toBe(true);
    expect(Object.keys(raw.legacy)).not.toContain('apiKey');
    for (const key of Object.keys(raw.legacy)) {
      expect(LEGACY_SENSOR_FIELDS).toContain(key as never);
    }
  });
});

describe('projection property test (finding 5 — reviewer requirement)', () => {
  it('compatToOverrides(mirror) reproduces the v1-expressible portion of the v2 effective map', () => {
    const sensorMap = [
      { dataPoint: 'humidity', enabled: false },                                    // global disable
      { dataPoint: 'tempinf', stationMac: MAC2, enabled: false },                   // station-specific disable
      { dataPoint: 'uv', threshold: 7 },                                            // threshold
      // Family-uniform display unit (per-row units are not v1-expressible).
      { dataPoint: 'windspeedmph', displayUnit: 'kph' },
      { dataPoint: 'windgustmph', displayUnit: 'kph' },
      { dataPoint: 'maxdailygust', displayUnit: 'kph' },
      { dataPoint: 'lightning_day', batteryField: null },                           // battery suppression
      { dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'celsius' }, // custom
    ];
    const v2 = v2Map(sensorMap, TWO_STATIONS);
    const mirror = projectLegacyMirror(v2);

    const legacy = buildEffectiveSensorMap({
      userOverrides: compatToOverrides(mirror, TWO_STATIONS),
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
      stations: TWO_STATIONS,
      configMode: 'legacy',
    });

    // Index known configured rows by (mac, dataPoint).
    type Rowish = { stationMac: string; dataPoint: string; enabled: boolean;
      hasBatterySubService?: boolean; structuralSignature?: string;
      threshold?: number; displayUnit?: string };
    const index = (m: EffectiveSensorMap): Map<string, Rowish> => {
      const out = new Map<string, Rowish>();
      for (const r of m.rows) {
        if (r.kind === 'unrecognized') {
          continue;
        }
        out.set(`${r.stationMac}|${r.dataPoint}`, r as unknown as Rowish);
      }
      return out;
    };
    const v2Rows = index(v2);
    const legacyRows = index(legacy);

    // Same known-row universe.
    expect([...legacyRows.keys()].sort()).toEqual([...v2Rows.keys()].sort());

    for (const [key, v2Row] of v2Rows) {
      const legacyRow = legacyRows.get(key)!;
      // Structural agreement: enabled + full structural signature
      // (kind, measurement, battery ownership, wrapper identity).
      expect(legacyRow.enabled, `${key} enabled`).toBe(v2Row.enabled);
      expect(legacyRow.structuralSignature, `${key} signature`).toBe(v2Row.structuralSignature);
      // Behavioral agreement where v1.7 can express it.
      expect(legacyRow.threshold, `${key} threshold`).toBe(v2Row.threshold);
      expect(legacyRow.displayUnit, `${key} displayUnit`).toBe(v2Row.displayUnit);
    }

    // The custom dataPoint is absent from both maps' rows (loss boundary).
    expect([...v2Rows.keys()].some(k => k.endsWith('|barn_temp'))).toBe(false);
    expect([...legacyRows.keys()].some(k => k.endsWith('|barn_temp'))).toBe(false);
  });
});

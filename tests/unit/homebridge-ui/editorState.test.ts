/**
 * /editor-state + /vocabulary — the sanitized read model the #69
 * editor consumes (PR A, read-only).
 *
 * Contract under test:
 *   - the ON-DISK config.json is the authority (same rule as
 *     /compose-save); credentials and machinery never appear in the DTO;
 *   - legacy configs render as their compat translation (the migration
 *     preview), v2 configs as their sensorMap;
 *   - troubled-but-readable states (safe mode, duplicate blocks,
 *     invalid rows) come back as renderable DTO state, while transport
 *     failures (missing/unreadable config) throw;
 *   - the vocabulary endpoint is a pure projection of UNIT_VOCABULARY
 *     (#70) — labels and order included, validity authority untouched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  handleGetEditorState,
  handleGetVocabulary,
  type HandlerDeps,
} from '../../../homebridge-ui/handlers';
import { UNIT_VOCABULARY, unitOptionsFor } from '../../../src/sensorMap/unitVocabulary';
import type { Measurement } from '../../../src/sensorMap/types';

const MAC = 'AA:BB:CC:DD:EE:01';
const OTHER_MAC = 'AA:BB:CC:DD:EE:02';
const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

interface Rig {
  root: string;
  persistDir: string;
  deps: HandlerDeps;
}

const rigs: Rig[] = [];

function makeRig(blocks: Record<string, unknown>[]): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'editor-state-'));
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: blocks }, null, 2));
  const rig: Rig = {
    root, persistDir,
    deps: { persistDir, log: silentLog, version: 'test', configPath, env: {} },
  };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rmSync(rig.root, { recursive: true, force: true });
  }
});

function discoveryStore(rig: Rig, entries: Array<{ mac: string; dataPoint: string }>): void {
  writeFileSync(path.join(rig.persistDir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    entries: entries.map(e => ({
      stationMac: e.mac, stationName: 'Home', dataPoint: e.dataPoint,
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
    })),
  }));
}

const V2_BLOCK = {
  platform: 'AmbientWeatherSensors',
  name: 'Test Station',
  apiKey: 'SECRET-API-KEY-XYZ',
  applicationKey: 'SECRET-APP-KEY-XYZ',
  _sensorMapV2: true,
  configVersion: 2,
  sensorMap: [
    { dataPoint: 'tempf', name: 'Outdoor Temp' },
    { dataPoint: 'windspeedmph', stationMac: MAC, enabled: false },
    { dataPoint: 'customtemp1', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius' },
  ],
};

const LEGACY_BLOCK = {
  platform: 'AmbientWeatherSensors',
  name: 'Test Station',
  apiKey: 'SECRET-API-KEY-XYZ',
  applicationKey: 'SECRET-APP-KEY-XYZ',
  temperatureSensors: true,
  humiditySensors: false,
  windSensors: true,
};

describe('/editor-state — v2 configuration', () => {
  it('renders effective rows with layer origins, sanitized', async () => {
    const rig = makeRig([V2_BLOCK]);
    discoveryStore(rig, [
      { mac: MAC, dataPoint: 'tempf' },
      { mac: MAC, dataPoint: 'windspeedmph' },
      { mac: MAC, dataPoint: 'weirdfield9' },
    ]);
    const dto = await handleGetEditorState(rig.deps, {});

    expect(dto.configMode).toBe('v2');
    expect(dto.editorAvailable).toBe(true); // PR C: save path live
    expect(dto.errors).toEqual([]);

    const byDp = new Map(dto.rows.filter(r => r.stationMac === MAC).map(r => [r.dataPoint, r]));
    expect(byDp.get('tempf')).toMatchObject({ origin: 'global', name: 'Outdoor Temp', kind: 'temperature' });
    expect(byDp.get('windspeedmph')).toMatchObject({ origin: 'station', enabled: false });
    expect(byDp.get('customtemp1')).toMatchObject({ origin: 'global', kind: 'temperature', sourceUnit: 'celsius' });
    // batteryField mirrors the resolver exactly — null is PRESENT,
    // never omitted (review #32 F2).
    expect(byDp.get('customtemp1')!.batteryField).toBeNull();
    expect('batteryField' in byDp.get('customtemp1')!).toBe(true);
    expect(byDp.get('weirdfield9')).toMatchObject({
      origin: 'unrecognized', kind: 'unrecognized', enabled: false, firstSeen: '2026-01-01T00:00:00Z',
    });

    // The AUTHORED view (review #32 F2): fragment order, layers, and
    // field presence survive verbatim.
    expect(dto.authoredSource).toBe('sensorMap');
    expect(dto.authored).toHaveLength(3);
    expect(dto.authored[0]).toMatchObject({ index: 0, layer: 'global', dataPoint: 'tempf', fields: { name: 'Outdoor Temp' } });
    expect(dto.authored[1]).toMatchObject({
      index: 1, layer: 'station', stationMac: MAC, stationMacKey: MAC,
      dataPoint: 'windspeedmph', fields: { enabled: false },
    });
    expect(dto.authored[2].fields).toEqual({ kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius' });

    // Sanitization: credentials never leave the bridge, and internal
    // machinery is not exposed.
    const wire = JSON.stringify(dto);
    expect(wire).not.toContain('SECRET-API-KEY-XYZ');
    expect(wire).not.toContain('SECRET-APP-KEY-XYZ');
    expect(wire).not.toContain('structuralSignature');
    expect(wire).not.toContain('wrapperId');
  });

  it('rows are sorted by stationMac then dataPoint', async () => {
    const rig = makeRig([{
      ...V2_BLOCK,
      sensorMap: [
        ...V2_BLOCK.sensorMap,
        { dataPoint: 'tempf', stationMac: OTHER_MAC, enabled: false },
      ],
    }]);
    discoveryStore(rig, [
      { mac: OTHER_MAC, dataPoint: 'windspeedmph' },
      { mac: MAC, dataPoint: 'tempf' },
    ]);
    const dto = await handleGetEditorState(rig.deps, {});
    const keys = dto.rows.map(r => `${r.stationMac}|${r.dataPoint}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('station inventory carries first-sight source attribution', async () => {
    const rig = makeRig([{
      ...V2_BLOCK,
      sensorMap: [
        ...V2_BLOCK.sensorMap,
        { dataPoint: 'tempf', stationMac: 'AA:BB:CC:DD:EE:03', enabled: false },
      ],
    }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {
      liveStations: [{ macAddress: OTHER_MAC, name: 'Fresh' }],
      cachedAccessoryUniqueIds: ['AA:BB:CC:DD:EE:04-tempf'],
    });
    const source = new Map(dto.stations.map(s => [s.mac, s.source]));
    expect(source.get(OTHER_MAC)).toBe('live');
    expect(source.get(MAC)).toBe('discovery');
    expect(source.get('AA:BB:CC:DD:EE:04')).toBe('cached-accessory');
    expect(source.get('AA:BB:CC:DD:EE:03')).toBe('override');
    expect(dto.stations.find(s => s.mac === MAC)?.name).toBe('Home');
  });

  it('invalid rows surface as STRUCTURED errors while the rest still renders, and stay in authored', async () => {
    const rig = makeRig([{
      ...V2_BLOCK,
      sensorMap: [
        { dataPoint: 'tempf', name: 'Outdoor Temp' },
        { dataPoint: 'brokencustom', measurement: 'temperature', sourceUnit: 'celsius' }, // custom missing kind
      ],
    }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    // Structured diagnostics (review #32 F3): stable code + the
    // authored index the problem belongs to — no message parsing.
    expect(dto.errors.length).toBeGreaterThan(0);
    expect(dto.errors[0]).toMatchObject({ severity: 'error', overrideIndex: 1, dataPoint: 'brokencustom' });
    expect(dto.errors[0].code).toBeTruthy();
    expect(dto.rows.some(r => r.dataPoint === 'tempf')).toBe(true);
    // The rejected fragment does NOT vanish: it is repairable because
    // the authored view still carries it at the diagnosed index.
    expect(dto.authored[1]).toMatchObject({
      index: 1, dataPoint: 'brokencustom',
      fields: { measurement: 'temperature', sourceUnit: 'celsius' },
    });
  });

  it('authored preserves explicit null batteryField, wrong types, and withholds unknown-key values', async () => {
    const rig = makeRig([{
      ...V2_BLOCK,
      sensorMap: [
        { dataPoint: 'tempf', batteryField: null, threshold: 'oops', someFutureKey: 'secret-ish' },
      ],
    }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    const frag = dto.authored[0];
    expect('batteryField' in frag.fields).toBe(true);
    expect(frag.fields.batteryField).toBeNull();
    expect(frag.fields.threshold).toBe('oops'); // verbatim wrong type — the editor must show it
    expect(frag.unknownKeys).toEqual(['someFutureKey']);
    expect(JSON.stringify(dto)).not.toContain('secret-ish'); // unknown-key VALUES never cross
  });

  it('emits ownership notes with their source attribution', async () => {
    const rig = makeRig([{
      ...V2_BLOCK,
      sensorMap: [{ dataPoint: 'co2_in_aqin', enabled: false }],
    }]);
    discoveryStore(rig, [
      { mac: MAC, dataPoint: 'co2_in_aqin' },
      { mac: MAC, dataPoint: 'pm_in_temp_aqin' },
      { mac: MAC, dataPoint: 'pm_in_humidity_aqin' },
    ]);
    const dto = await handleGetEditorState(rig.deps, {});
    const orphan = dto.notes.find(n => n.code === 'orphan-battery-field');
    expect(orphan).toBeDefined();
    expect(orphan).toMatchObject({ severity: 'note', source: 'override', stationMac: MAC });
  });
});

describe('/editor-state — malformed sensorMap (runtime hard-stop parity)', () => {
  // The runtime freezes reconciliation on a present-but-non-array
  // sensorMap instead of exposing the full default map off a config
  // error (sensorMapShapeError). The preview must mirror that hard
  // stop (review #32 round 2 F1) — never render a fictitious default
  // configuration.
  it.each([
    ['string', 'oops'],
    ['object', { tempf: { enabled: false } }],
    ['number', 42],
    ['null', null],
  ])('sensorMap as %s returns the hard-stop diagnostic and zero rows', async (_shape, value) => {
    const rig = makeRig([{ ...V2_BLOCK, sensorMap: value }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.configMode).toBe('v2');
    expect(dto.rows).toEqual([]);
    expect(dto.stations).toEqual([]);
    expect(dto.authored).toEqual([]);
    expect(dto.errors).toHaveLength(1);
    expect(dto.errors[0]).toMatchObject({ severity: 'error', code: 'sensor-map-shape' });
    expect(dto.errors[0].message).toContain('not an array');
  });

  it('an ABSENT sensorMap in v2 mode legitimately exposes defaults', async () => {
    const block = { ...V2_BLOCK } as Record<string, unknown>;
    delete block.sensorMap;
    const rig = makeRig([block]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.errors).toEqual([]);
    const tempf = dto.rows.find(r => r.dataPoint === 'tempf');
    expect(tempf).toMatchObject({ origin: 'default' });
  });
});

describe('/editor-state — raw invalid fragments (crash + false-origin counterexamples)', () => {
  it('sensorMap: [null] renders instead of crashing inventory assembly', async () => {
    const rig = makeRig([{ ...V2_BLOCK, sensorMap: [null] }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.rows.length).toBeGreaterThan(0);
    expect(dto.authored).toHaveLength(1);
    expect(dto.authored[0]).toMatchObject({ index: 0, layer: 'global', fields: {} });
  });

  it('a wrong-typed stationMac renders instead of crashing layer partitioning', async () => {
    const rig = makeRig([{ ...V2_BLOCK, sensorMap: [{ dataPoint: 'tempf', stationMac: 42 }] }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    const tempf = dto.rows.find(r => r.dataPoint === 'tempf');
    // The fragment never validated, so the surviving row is NOT
    // labeled override-authored.
    expect(tempf?.origin).toBe('default');
    // F3/round 3: the wrong-typed identity survives verbatim AND the
    // fragment is classified 'invalid' — a present-but-unusable
    // stationMac is neither a station exception nor a global template.
    expect(dto.authored[0].identityRaw).toEqual({ stationMac: 42 });
    expect(dto.authored[0].layer).toBe('invalid');
    expect(dto.authored[0].stationMacKey).toBeUndefined();
  });

  it('identity classification uses the engine rules, not string type (round 3)', async () => {
    const rig = makeRig([{
      ...V2_BLOCK,
      sensorMap: [
        { dataPoint: 'tempf', stationMac: 'not-a-mac', enabled: false },
        { dataPoint: '', enabled: false },
        { dataPoint: 'windspeedmph', stationMac: 'aa:bb:cc:dd:ee:01', enabled: false },
      ],
    }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});

    // A MAC-SHAPED-only check would have accepted "not-a-mac" as a
    // string; the engine's STATION_MAC_REGEX rejects it → 'invalid',
    // verbatim value preserved, no key derived, nothing hoisted.
    expect(dto.authored[0].layer).toBe('invalid');
    expect(dto.authored[0].stationMac).toBeUndefined();
    expect(dto.authored[0].stationMacKey).toBeUndefined();
    expect(dto.authored[0].identityRaw).toEqual({ stationMac: 'not-a-mac' });
    expect(dto.authored[0].dataPoint).toBe('tempf');
    // The invalid exception must not label the surviving row.
    expect(dto.rows.find(r => r.dataPoint === 'tempf')?.origin).toBe('default');

    // Empty dataPoint fails the non-empty rule → not hoisted.
    expect(dto.authored[1].dataPoint).toBeUndefined();
    expect(dto.authored[1].identityRaw).toEqual({ dataPoint: '' });

    // Lowercase MAC is valid per the engine (case-insensitive regex):
    // hoisted verbatim, key normalized, layer 'station'.
    expect(dto.authored[2]).toMatchObject({
      layer: 'station', stationMac: 'aa:bb:cc:dd:ee:01', stationMacKey: MAC,
    });
    expect(dto.authored[2].identityRaw).toBeUndefined();
  });

  it('a resolver-REJECTED fragment does not label the surviving default row as global', async () => {
    const rig = makeRig([{ ...V2_BLOCK, sensorMap: [{ dataPoint: 'tempf', threshold: 'oops' }] }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.errors.length).toBeGreaterThan(0);
    expect(dto.errors[0]).toMatchObject({ overrideIndex: 0 });
    const tempf = dto.rows.find(r => r.dataPoint === 'tempf');
    expect(tempf).toBeDefined();
    expect(tempf?.origin).toBe('default');
    // The rejected fragment stays repairable in the authored view.
    expect(dto.authored[0]).toMatchObject({ dataPoint: 'tempf', fields: { threshold: 'oops' } });
  });

  it('wrong-typed dataPoint is preserved verbatim in identityRaw', async () => {
    const rig = makeRig([{ ...V2_BLOCK, sensorMap: [{ dataPoint: null, enabled: false }] }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.authored[0].dataPoint).toBeUndefined();
    expect(dto.authored[0].identityRaw).toEqual({ dataPoint: null });
    expect(dto.authored[0].fields).toEqual({ enabled: false });
  });
});

describe('/editor-state — v2-flag gating (review #45 P1-1)', () => {
  it('flag OFF: editorAvailable false with a directing banner (rows still preview)', async () => {
    const rig = makeRig([LEGACY_BLOCK]); // no _sensorMapV2, env {}
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.v2FlagEnabled).toBe(false);
    expect(dto.editorAvailable).toBe(false);
    const banner = dto.warnings.find(w => w.code === 'v2-flag-off');
    expect(banner).toBeDefined();
    expect(banner?.message).toContain('restart Homebridge');
    expect(dto.rows.length).toBeGreaterThan(0); // the preview stays useful
  });

  it('flag ON via config field enables the editor', async () => {
    const rig = makeRig([{ ...LEGACY_BLOCK, _sensorMapV2: true }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.v2FlagEnabled).toBe(true);
    expect(dto.editorAvailable).toBe(true);
    expect(dto.warnings.find(w => w.code === 'v2-flag-off')).toBeUndefined();
  });

  it('flag ON via environment variable enables the editor', async () => {
    const rig = makeRig([LEGACY_BLOCK]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState({ ...rig.deps, env: { SENSOR_MAP_V2: '1' } }, {});
    expect(dto.v2FlagEnabled).toBe(true);
    expect(dto.editorAvailable).toBe(true);
  });
});

describe('/editor-state — legacy and troubled configurations', () => {
  it('a legacy config renders its compat translation as a migration preview', async () => {
    const rig = makeRig([LEGACY_BLOCK]);
    discoveryStore(rig, [
      { mac: MAC, dataPoint: 'tempf' },
      { mac: MAC, dataPoint: 'windspeedmph' },
    ]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.configMode).toBe('legacy');
    expect(dto.v2FlagEnabled).toBe(false);
    expect(dto.authoredSource).toBe('compat-seeded');
    const tempf = dto.rows.find(r => r.stationMac === MAC && r.dataPoint === 'tempf');
    expect(tempf?.enabled).toBe(true);
    expect(dto.errors).toEqual([]);
  });

  it('a 1.7.x install with cached accessories but NO discovery.json still gets a migration preview', async () => {
    // Review #32 F1: the typical upgrade case — the plugin has never
    // run with the v2 flag, so discovery.json does not exist; the
    // ONLY station evidence is the cached-accessory uniqueIds the
    // client passes. Without them the preview would be empty despite
    // an intact HomeKit installation.
    const rig = makeRig([LEGACY_BLOCK]); // note: no discoveryStore() call
    const dto = await handleGetEditorState(rig.deps, {
      cachedAccessoryUniqueIds: [`${MAC}-tempf`, `${MAC}-windspeedmph`],
    });
    expect(dto.configMode).toBe('legacy');
    expect(dto.authoredSource).toBe('compat-seeded');
    expect(dto.stations).toEqual([{ mac: MAC, source: 'cached-accessory' }]);
    expect(dto.rows.length).toBeGreaterThan(0);
    expect(dto.rows.find(r => r.dataPoint === 'tempf')?.enabled).toBe(true);
    expect(dto.authored.length).toBeGreaterThan(0);
  });

  it('safe mode returns a renderable DTO with the banner, no rows', async () => {
    const rig = makeRig([{ ...LEGACY_BLOCK, configVersion: 99 }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.configMode).toBe('safe-mode');
    expect(dto.rows).toEqual([]);
    expect(dto.stations).toEqual([]);
    // Safe mode stays fail-closed even with the PR C save path live.
    expect(dto.editorAvailable).toBe(false);
    expect(dto.warnings.some(w => /newer plugin version/.test(w.message))).toBe(true);
    // The banner appears exactly once (detectConfigMode already folds
    // it into warnings; the handler must not add it again).
    expect(dto.warnings.filter(w => /newer plugin version/.test(w.message))).toHaveLength(1);
  });

  it('duplicate platform blocks render the first with a warning', async () => {
    const rig = makeRig([V2_BLOCK, { ...V2_BLOCK, name: 'Second' }]);
    discoveryStore(rig, [{ mac: MAC, dataPoint: 'tempf' }]);
    const dto = await handleGetEditorState(rig.deps, {});
    expect(dto.warnings.some(w => /2 AmbientWeatherSensors platform blocks/.test(w.message))).toBe(true);
    expect(dto.rows.length).toBeGreaterThan(0);
  });

  it('throws when no config path is available or no block exists', async () => {
    const rig = makeRig([{ platform: 'SomethingElse' }]);
    await expect(handleGetEditorState(rig.deps, {})).rejects.toThrow(/No AmbientWeatherSensors platform block/);
    await expect(handleGetEditorState({ ...rig.deps, configPath: undefined }, {}))
      .rejects.toThrow(/No config.json path/);
    await expect(handleGetEditorState({ ...rig.deps, configPath: path.join(rig.root, 'missing.json') }, {}))
      .rejects.toThrow(/could not be read/);
  });
});

describe('/vocabulary', () => {
  it('is an exact projection of UNIT_VOCABULARY per selection context', () => {
    const dto = handleGetVocabulary();
    const measurements = Object.keys(UNIT_VOCABULARY) as Measurement[];
    expect(Object.keys(dto.measurements).sort()).toEqual([...measurements].sort());
    for (const m of measurements) {
      expect(dto.measurements[m].customSource).toEqual(
        unitOptionsFor(m, 'custom-source').map(o => ({ unit: o.unit, label: o.label })));
      expect(dto.measurements[m].extendedDisplay).toEqual(
        unitOptionsFor(m, 'extended-display').map(o => ({ unit: o.unit, label: o.label })));
    }
  });

  it('carries the #70 additions with labels: mmHg, fps, and source-only fc', () => {
    const dto = handleGetVocabulary();
    expect(dto.measurements['pressure'].extendedDisplay.map(o => o.unit)).toContain('mmHg');
    expect(dto.measurements['wind-speed'].extendedDisplay.map(o => o.unit)).toContain('fps');
    const light = dto.measurements['illuminance'];
    expect(light.customSource.map(o => o.unit)).toContain('fc');
    expect(light.extendedDisplay.map(o => o.unit)).not.toContain('fc');
    for (const list of [light.customSource, dto.measurements['pressure'].extendedDisplay]) {
      for (const o of list) {
        expect(o.label).toBeTruthy();
      }
    }
  });
});

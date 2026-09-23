/** Published-binary upgrade journeys over real HAP caches and the compiled candidate. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform as Published173 } from '../../node_modules/awn-v1-7-3/dist/platform.js';
import { AmbientWeatherSensorsPlatform as PublishedBeta17 } from '../../node_modules/awn-v2-beta17/dist/platform.js';
import { AmbientWeatherSensorsPlatform as Candidate } from '../../dist/platform.js';
import { buildEffectiveSensorMap } from '../../dist/sensorMap/buildEffectiveMap.js';
import {
  handleCommitSave, handleComposeSave, handleGetEditorState, handlePreviewSave,
} from '../../homebridge-ui/handlers.js';
import { HapMockAPI, serializeRegistered, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';
import type { RawStation } from '../helpers/legacyConfigCorpus';
import { DraftStore } from '../../homebridge-ui/app-src/draft-store';
import { staticDefaultRowFor } from '../../dist/sensorMap/defaultMap.js';

const MAC = 'AA:BB:CC:DD:EE:01';
const OTHER = 'AA:BB:CC:DD:EE:02';
const ROOTS: string[] = [];
const silentLog = { info() {}, warn() {}, debug() {} };
type Block = Record<string, unknown>;
type Constructor = new (log: never, config: never, api: never) => unknown;
interface Runtime {
  accessories: HapLifecyclePlatformAccessory[];
  configureAccessory(a: never): void;
  v2Tracker?: { flush(force: boolean): Promise<void> };
}
interface Home { root: string; configPath: string; persistDir: string }

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of ROOTS.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

function newHome(): Home {
  const root = mkdtempSync(path.join(tmpdir(), 'published-upgrade-p5-'));
  ROOTS.push(root);
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  return { root, persistDir, configPath: path.join(root, 'config.json') };
}

function writeConfig(home: Home, block: Block): string {
  const bytes = JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms: [block] }, null, 2);
  writeFileSync(home.configPath, bytes);
  return bytes;
}

function uid(accessory: HapLifecyclePlatformAccessory): string {
  return String((accessory.context.device as { uniqueId: string }).uniqueId);
}

function graphs(accessories: HapLifecyclePlatformAccessory[]) {
  const api = new HapMockAPI();
  api.registered.push(...accessories);
  return serializeRegistered(api);
}

/** Each source cache is produced by its actual published startup, never synthesized from HEAD. */
async function boot(
  Ctor: Constructor, home: Home, block: Block, stations: RawStation[],
  cached: HapLifecyclePlatformAccessory[] = [], mode: 'running' | 'guard-frozen' = 'running',
) {
  vi.stubEnv('SENSOR_MAP_V2', '');
  const bytes = writeConfig(home, block);
  const api = new HapMockAPI();
  api.user.storagePath = () => home.root;
  Object.assign(api.user, { configPath: () => home.configPath });
  const log = new MockLogger();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(stations), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  // No real poll timer is needed: each lifecycle consumes the first genuine poll.
  const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
  const platform = new Ctor(log as never, structuredClone(block) as never, api as never) as Runtime;
  try {
    for (const accessory of cached) { platform.configureAccessory(accessory as never); }
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(log.logs.some(entry => mode === 'running'
      ? entry.message.startsWith('Data source:')
      : entry.level === 'error' && /written by plugin version 2\.x/.test(entry.message)),
      log.logs.map(entry => entry.message).join('\n')).toBe(true), { timeout: 10000 });
    if (mode === 'running') { expect(fetch).toHaveBeenCalled(); }
    else { expect(fetch).not.toHaveBeenCalled(); }
    // Drain the actual tracker chain. Quiet event-loop ticks do not prove filesystem completion.
    await platform.v2Tracker?.flush(true);
    expect(readFileSync(home.configPath, 'utf8'), 'startup never writes configuration').toBe(bytes);
    const removed = new Set(api.unregistered);
    return {
      api, platform, log,
      cache: [...cached.filter(accessory => !removed.has(accessory)), ...api.registered],
    };
  } finally {
    api.emit('shutdown');
    await platform.v2Tracker?.flush(true);
    api.removeAllListeners();
    fetch.mockRestore();
    interval.mockRestore();
  }
}

function noChurn(run: Awaited<ReturnType<typeof boot>>, cached: HapLifecyclePlatformAccessory[]): void {
  expect(run.api.registered, 'no replacement registrations').toEqual([]);
  expect(run.api.unregistered, 'no cache removals').toEqual([]);
  expect(run.platform.accessories).toHaveLength(cached.length);
  for (const accessory of cached) {
    expect(run.platform.accessories.find(item => item.UUID === accessory.UUID), uid(accessory)).toBe(accessory);
    expect(run.cache.find(item => item.UUID === accessory.UUID), uid(accessory)).toBe(accessory);
  }
}

async function save(
  home: Home, block: Block, cache: HapLifecyclePlatformAccessory[], proposal?: unknown[],
  expectedChanges: Array<{ dataPoint: string; change: string; structural: boolean }> = [],
) {
  const deps = { persistDir: home.persistDir, configPath: home.configPath, version: 'p5', env: {}, log: silentLog };
  const ids = cache.map(uid);
  const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds: ids });
  const request = {
    baseDigest: state.baseDigest, blockIndex: state.blockIndex, cachedAccessoryUniqueIds: ids,
    ...(proposal === undefined ? {} : { proposal }),
  };
  const before = readFileSync(home.configPath, 'utf8');
  const preview = await handlePreviewSave(deps, request);
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  if (!preview.ok) { throw new Error(preview.error.message); }
  expect(preview.changes.map(({ dataPoint, change, structural }) => ({ dataPoint, change, structural })))
    .toEqual(expectedChanges);
  expect(preview.batteryPolarity).toEqual([]);
  const payload = { ...request, formBlock: block, confirmDigest: preview.digest };
  const composed = await handleComposeSave(deps, payload);
  expect(composed.ok, JSON.stringify(composed)).toBe(true);
  if (!composed.ok) { throw new Error(composed.error.message); }
  expect(readFileSync(home.configPath, 'utf8')).toBe(before);
  const committed = await handleCommitSave(deps, { ...payload, validationToken: composed.validationToken });
  expect(committed.ok, JSON.stringify(committed)).toBe(true);
  if (!committed.ok) { throw new Error(committed.error.message); }
  expect(readFileSync(home.configPath, 'utf8'), 'commit does not perform the HB UI persistence half').toBe(before);
  if (block.configVersion !== 2) {
    expect(existsSync(path.join(home.persistDir, 'legacy-config-snapshot.json')), 'snapshot exists before persistence').toBe(true);
  }
  const next = committed.nextConfig as Block;
  writeConfig(home, next);
  return next;
}

const BASE = { platform: 'AmbientWeatherSensors', name: 'Test AWN', apiKey: 'test-key', applicationKey: 'test-application' };
const ALL = {
  temperatureSensors: true, humiditySensors: true, solarRadiationSensors: true, co2Sensors: true,
  airQualitySensors: true, extendedSensors: true, windSensors: true, rainSensors: true,
  pressureSensors: true, uvSensors: true, lightningSensors: true,
};
const GAP_DATA = {
  tempf: 72, humidity: 45, battout: 1, feelsLike5: 69, dewPoint17: 42, temp11f: 65,
  barn_temp: 25, barn_solar: 25, humid_aux: 44, co2_extra: 700, pm25_aux: 12, pm10_aux: 24,
  windspeedmph: 8, windgustmph: 12, hourlyrainin: 0.2, dailyrainin: 0.4, baromabsin: 29.5, uv: 2,
  soilhum9: 42,
};
const STATIONS: RawStation[] = [
  { macAddress: MAC, info: { name: 'Roof' }, lastData: { ...GAP_DATA } },
  { macAddress: OTHER, info: { name: 'Barn' }, lastData: { ...GAP_DATA, tempf: 68, humidity: 51 } },
];
const GAP_FIELDS = ['feelsLike5', 'dewPoint17', 'temp11f', 'barn_temp', 'barn_solar', 'humid_aux', 'co2_extra', 'pm25_aux', 'pm10_aux'];
const LEGACY_CASES: Array<{ label: string; patch: Block; excluded?: string[] }> = [
  { label: 'all categories and broad substring/prefix fields', patch: {} },
  { label: 'temperature category disabled', patch: { temperatureSensors: false }, excluded: ['tempf', 'feelsLike5', 'dewPoint17', 'temp11f', 'barn_temp'] },
  { label: 'humidity and solar categories disabled', patch: { humiditySensors: false, solarRadiationSensors: false }, excluded: ['humidity', 'humid_aux', 'barn_solar'] },
  { label: 'extended master disabled with subcategories retained', patch: { extendedSensors: false }, excluded: ['windspeedmph', 'windgustmph', 'hourlyrainin', 'dailyrainin', 'baromabsin', 'uv'] },
  { label: 'raw field exclusions', patch: { excludeSensors: ['feelsLike5', 'barn_solar'] }, excluded: ['feelsLike5', 'barn_solar'] },
  { label: 'station-specific exclusions', patch: { excludeSensors: [`${MAC}-barn_temp`, `${OTHER}-humid_aux`] } },
  { label: 'broad field allowlist', patch: { includeOnly: ['barn_temp', 'barn_solar', 'feelsLike5', 'humidity'] } },
  { label: 'station filtering', patch: { stationFilter: [MAC] } },
];

describe('P5 published artifact provenance', () => {
  it.each([['awn-v1-7-3', '1.7.3'], ['awn-v2-beta17', '2.0.0-beta.17']])('%s executes exactly %s', (alias, version) => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, `../../node_modules/${alias}/package.json`), 'utf8'));
    expect(pkg.name).toBe('@bcourbage/homebridge-ambient-weather-sensors');
    expect(pkg.version).toBe(version);
    const rootPackage = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(rootPackage.devDependencies[alias]).toBe(`npm:@bcourbage/homebridge-ambient-weather-sensors@${version}`);
  });
});

describe('P5 cached-pair evidence uses one identity parser', () => {
  it('does not label an accepted cached suffix as never reported', async () => {
    const home = newHome();
    writeConfig(home, { ...BASE, configVersion: 2, sensorMap: [] });
    writeFileSync(path.join(home.persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: [{
      stationMac: MAC, stationName: 'Roof', dataPoint: 'tempf',
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z',
    }] }));
    const dataPoint = `feelsLike${String.fromCodePoint(10)}21`;
    const state = await handleGetEditorState({ persistDir: home.persistDir, configPath: home.configPath,
      version: 'p5', env: {}, log: silentLog }, { cachedAccessoryUniqueIds: [`${MAC}-${dataPoint}`] });
    const row = state.rows.find(candidate => candidate.dataPoint === dataPoint);
    expect(row).toMatchObject({ kind: 'temperature', everReported: true });
    expect(row?.firstSeen, 'cache inventory must not invent discovery observations').toBeUndefined();
  });

  it.each([MAC, MAC.toLowerCase()])('applies the previewed offline rename with cache MAC casing %s', async originalMac => {
    const home = newHome();
    const block = { ...BASE, configVersion: 2, sensorMap: [] };
    const stations: RawStation[] = [
      { macAddress: originalMac, info: { name: 'Roof' }, lastData: { tempf: 72, battout: 1 } },
      { macAddress: OTHER, info: { name: 'Barn' }, lastData: { tempf: 68, battout: 1 } },
    ];
    const initial = await boot(Candidate as unknown as Constructor, home, block, stations);
    expect(initial.cache).toHaveLength(2);
    rmSync(path.join(home.persistDir, 'discovery.json'));
    const deps = { persistDir: home.persistDir, configPath: home.configPath, version: 'p5', env: {}, log: silentLog };
    const cachedAccessoryUniqueIds = initial.cache.map(uid);
    const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds });
    const proposal = [{ stationMac: MAC, dataPoint: 'tempf', name: 'Renamed temperature' }];
    const preview = await handlePreviewSave(deps, { baseDigest: state.baseDigest, blockIndex: state.blockIndex,
      cachedAccessoryUniqueIds, proposal });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error(preview.error.message);
    const displayedName = preview.changes.find(change => change.stationMac === MAC && change.dataPoint === 'tempf')?.displayName?.after;
    expect(displayedName).toContain('Renamed temperature');
    const saved = await save(home, block, initial.cache, proposal, [{ dataPoint: 'tempf', change: 'modified', structural: false }]);
    const offline = await boot(Candidate as unknown as Constructor, home, saved, [], initial.cache);
    noChurn(offline, initial.cache);
    expect(offline.cache.find(accessory => uid(accessory) === `${originalMac}-tempf`)?.displayName).toBe(displayedName);
  });
});

describe('P5 compatibility battery ownership boundary', () => {
  function map(catalogAdopted: number, userOverrides: unknown[]) {
    return buildEffectiveSensorMap({
      configMode: 'v2', catalogBaseline: 1, catalogAdopted,
      stations: [{ macAddress: MAC, name: 'Roof' }], userOverrides,
      discovery: { schemaVersion: 1, entries: [] },
      uiState: { schemaVersion: 1, forgottenFields: [], dismissedNoticeIds: [] },
    });
  }

  it('does not widen compatibility ownership through catalog-2 anchoring', () => {
    const keys = ['temp11f', 'dewPoint17', 'feelsLike5', 'dewPoint5', 'soiltemp1f', 'pm25_in_24h'];
    const overrides = keys.map(dataPoint => ({ dataPoint, stationMac: MAC }));
    const before = map(1, overrides);
    const adopted = map(2, overrides);
    expect(before.errors).toEqual([]);
    expect(adopted.errors).toEqual([]);
    for (const dp of keys) {
      const a = before.rows.find(r => r.dataPoint === dp)!;
      const b = adopted.rows.find(r => r.dataPoint === dp)!;
      expect(a.kind).not.toBe('unrecognized');
      expect(b).toEqual(a);
      expect(a, dp).toMatchObject({ hasBatterySubService: false });
    }
  });

  it('preserves explicit unreserved claims and catalog-3 new-family ownership', () => {
    const effective = map(4, [
      { dataPoint: 'temp11f', stationMac: MAC, batteryField: 'batt11' },
      { dataPoint: 'custom_counter', stationMac: MAC, kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', batteryField: 'custom_battery' },
      { dataPoint: 'soilhum1', stationMac: MAC, enabled: true },
      { dataPoint: 'leak1', stationMac: MAC, enabled: true },
    ]);
    expect(effective.errors).toEqual([]);
    for (const dp of ['temp11f', 'custom_counter', 'soilhum1', 'leak1']) {
      expect(effective.rows.find(r => r.dataPoint === dp)).toMatchObject({ enabled: true, hasBatterySubService: true });
    }
  });

  it.each([undefined, MAC])('round-trips explicit ownership equal to the compatibility reference (scope: %s)', async stationMac => {
    const home = newHome();
    const proposal = [{ dataPoint: 'temp11f', ...(stationMac === undefined ? {} : { stationMac }), batteryField: 'batt11' }];
    const block = { ...BASE, configVersion: 2, sensorMap: proposal };
    const stations: RawStation[] = [{ macAddress: MAC, info: { name: 'Roof' }, lastData: { temp11f: 65, batt11: 0 } }];
    const before = await boot(Candidate as unknown as Constructor, home, block, stations);
    const beforeGraph = graphs(before.cache);
    expect(before.cache[0].getService(before.api.hap.Service.Battery)).toBeDefined();
    const saved = await save(home, block, before.cache, proposal);
    expect(saved.sensorMap).toContainEqual(proposal[0]);
    const reloaded = await boot(Candidate as unknown as Constructor, home, saved, stations, before.cache);
    noChurn(reloaded, before.cache);
    expect(graphs(reloaded.cache)).toEqual(beforeGraph);
    const again = await save(home, saved, reloaded.cache, saved.sensorMap as unknown[]);
    expect(again.sensorMap).toEqual(saved.sensorMap);
  });

  it.each(['disabled', 'collision-loser'])('retains a %s authored claim for a later previewed activation', async state => {
    const home = newHome();
    const owner = { dataPoint: 'custom_probe', stationMac: MAC, kind: 'temperature', measurement: 'temperature',
      sourceUnit: 'fahrenheit', batteryField: 'batt11' };
    const claim = { dataPoint: 'temp11f', stationMac: MAC, batteryField: 'batt11', ...(state === 'disabled' ? { enabled: false } : {}) };
    const proposal = state === 'disabled' ? [claim] : [owner, claim];
    const block = { ...BASE, configVersion: 2, sensorMap: proposal };
    const stations: RawStation[] = [{ macAddress: MAC, info: { name: 'Roof' }, lastData: {
      tempf: 72, battout: 1, temp11f: 65, batt11: 0, ...(state === 'disabled' ? {} : { custom_probe: 60 }),
    } }];
    const initial = await boot(Candidate as unknown as Constructor, home, block, stations);
    const saved = await save(home, block, initial.cache, proposal);
    expect(saved.sensorMap).toContainEqual(expect.objectContaining({ dataPoint: 'temp11f', batteryField: 'batt11' }));
    const reloaded = await boot(Candidate as unknown as Constructor, home, saved, stations, initial.cache);
    noChurn(reloaded, initial.cache);
    const nextProposal = (saved.sensorMap as Block[]).map(row => row.dataPoint === 'temp11f'
      ? { ...row, enabled: true }
      : row.dataPoint === 'custom_probe' ? { ...row, enabled: false } : row);
    const expectedChanges = state === 'disabled'
      ? [{ dataPoint: 'temp11f', change: 'added', structural: true }]
      : [{ dataPoint: 'custom_probe', change: 'removed', structural: true }, { dataPoint: 'temp11f', change: 'modified', structural: true }];
    const activated = await save(home, saved, reloaded.cache, nextProposal, expectedChanges);
    const running = await boot(Candidate as unknown as Constructor, home, activated, stations, reloaded.cache);
    const temperature = running.cache.find(a => uid(a) === `${MAC}-temp11f`)!;
    expect(temperature.getService(running.api.hap.Service.Battery)
      ?.getCharacteristic(running.api.hap.Characteristic.StatusLowBattery).value).toBe(1);
    expect(running.api.registered.map(uid)).toEqual([`${MAC}-temp11f`]);
    expect(running.api.unregistered.map(uid).sort()).toEqual(state === 'disabled'
      ? [] : [`${MAC}-custom_probe`, `${MAC}-temp11f`]);
  });
});

describe('P5 actual 1.7.3 cache → unchanged legacy startup → confirmed conversion', () => {
  it.each([
    { label: 'disabled temperature category', patch: { temperatureSensors: false } },
    { label: 'named but never observed exclusion', patch: { temperatureSensors: true, excludeSensors: ['feelsLike21'] } },
  ])('uses individual sensor control after converting $label', async ({ patch }) => {
    // Product decision, 2026-09-23: conversion preserves real sensor identities,
    // not speculative category/matcher policy for fields first reported later.
    // These replace the two original v1-parity probes explicitly: a new real
    // field may appear under v2 defaults, then its per-row disable must persist.
    const dataPoint = 'feelsLike21';
    const knownTemperatures = ['tempf', 'temp1f', 'feelsLike20', 'barn_temp'];
    const block = { ...BASE, humiditySensors: true, ...patch };
    const before: RawStation[] = [{ macAddress: MAC, info: { name: 'Roof' }, lastData: {
      tempf: 72, temp1f: 71, feelsLike20: 70, barn_temp: 69, humidity: 45, battout: 1, batt1: 1,
    } }];
    const after: RawStation[] = [{ ...before[0], lastData: { ...before[0].lastData, [dataPoint]: 68 } }];
    expect(staticDefaultRowFor(dataPoint), 'not a frozen catalog identity at conversion').toBeUndefined();
    expect(Object.hasOwn(before[0].lastData, dataPoint), 'not yet reported').toBe(false);

    // The published control deliberately differs for a future field. This is
    // an explicit product-contract change, not an accidental parity waiver.
    const legacyControl = await boot(Published173 as unknown as Constructor, newHome(), block, after);
    expect(legacyControl.cache.map(uid)).not.toContain(`${MAC}-${dataPoint}`);
    const home = newHome();
    const original = await boot(Published173 as unknown as Constructor, home, block, before);
    expect(original.cache.map(uid)).toContain(`${MAC}-humidity`);
    const upgraded = await boot(Candidate as unknown as Constructor, home, block, before, original.cache);
    noChurn(upgraded, original.cache);
    const converted = await save(home, block, upgraded.cache);
    expect((converted.sensorMap as Block[]).some(row => row.dataPoint === dataPoint),
      'no phantom disabled row for a speculative exclusion').toBe(false);

    const deps = { persistDir: home.persistDir, configPath: home.configPath, version: 'p5', env: {}, log: silentLog };
    const convertedState = await handleGetEditorState(deps, { cachedAccessoryUniqueIds: upgraded.cache.map(uid) });
    expect(convertedState.rows.some(row => row.dataPoint === dataPoint)).toBe(false);
    for (const key of knownTemperatures) {
      expect(convertedState.rows.find(row => row.stationMac === MAC && row.dataPoint === key))
        .toMatchObject({ kind: 'temperature', enabled: patch.temperatureSensors });
    }
    if (!patch.temperatureSensors) {
      const temperatureRows = convertedState.rows.filter(row => row.kind === 'temperature');
      expect(temperatureRows.length).toBeGreaterThanOrEqual(knownTemperatures.length);
      expect(temperatureRows.every(row => row.enabled === false), 'all known category identities stay disabled').toBe(true);
    }
    const convertedBoot = await boot(Candidate as unknown as Constructor, home, converted, before, upgraded.cache);
    noChurn(convertedBoot, upgraded.cache);
    const later = await boot(Candidate as unknown as Constructor, home, converted, after, convertedBoot.cache);
    expect(later.api.registered.map(uid), 'only the newly reported sensor registers').toEqual([`${MAC}-${dataPoint}`]);
    expect(later.api.unregistered).toEqual([]);
    const appeared = later.cache.find(accessory => uid(accessory) === `${MAC}-${dataPoint}`)!;
    expect(appeared.getService(later.api.hap.Service.TemperatureSensor)
      ?.getCharacteristic(later.api.hap.Characteristic.CurrentTemperature).value).toBe(20);
    for (const accessory of convertedBoot.cache) {
      expect(later.cache.find(item => item.UUID === accessory.UUID)).toBe(accessory);
    }
    if (!patch.temperatureSensors) {
      for (const key of knownTemperatures) { expect(later.cache.map(uid)).not.toContain(`${MAC}-${key}`); }
    }

    const liveState = await handleGetEditorState(deps, { cachedAccessoryUniqueIds: later.cache.map(uid) });
    expect(liveState.rows.find(row => row.stationMac === MAC && row.dataPoint === dataPoint))
      .toMatchObject({ kind: 'temperature', enabled: true, everReported: true });
    const drafts = new DraftStore();
    drafts.reset(liveState.authored);
    drafts.setFieldFor(MAC, dataPoint, 'enabled', false);
    const disabled = await save(home, converted, later.cache, drafts.proposal(), [
      { dataPoint, change: 'removed', structural: true },
    ]);
    expect(disabled.sensorMap).toContainEqual(expect.objectContaining({ stationMac: MAC, dataPoint, enabled: false }));
    const disabledBoot = await boot(Candidate as unknown as Constructor, home, disabled, after, later.cache);
    expect(disabledBoot.api.registered).toEqual([]);
    expect(disabledBoot.api.unregistered).toEqual([appeared]);
    for (const accessory of convertedBoot.cache) {
      expect(disabledBoot.cache.find(item => item.UUID === accessory.UUID)).toBe(accessory);
    }
    const reloadedState = await handleGetEditorState(deps, { cachedAccessoryUniqueIds: disabledBoot.cache.map(uid) });
    expect(reloadedState.rows.find(row => row.stationMac === MAC && row.dataPoint === dataPoint))
      .toMatchObject({ kind: 'temperature', enabled: false });
    const again = await save(home, disabled, disabledBoot.cache, disabled.sensorMap as unknown[]);
    expect(again.sensorMap).toEqual(disabled.sensorMap);
    const restarted = await boot(Candidate as unknown as Constructor, home, again, after, disabledBoot.cache);
    noChurn(restarted, disabledBoot.cache);
    expect(restarted.cache.map(uid)).not.toContain(`${MAC}-${dataPoint}`);
  });

  it.each(LEGACY_CASES)('$label', async ({ patch, excluded, label }) => {
    const home = newHome();
    const block = { ...BASE, ...ALL, ...patch };
    const published = await boot(Published173 as unknown as Constructor, home, block, STATIONS);
    expect(published.api.unregistered).toEqual([]);
    expect(published.cache.length, 'the source really produced a HAP cache').toBeGreaterThan(0);
    const before = graphs(published.cache);
    const ids = published.cache.map(uid);
    if (label.startsWith('all categories')) {
      for (const dp of GAP_FIELDS) { expect(ids).toContain(`${MAC}-${dp}`); }
      expect(ids, 'hum is not the legacy humid matcher').not.toContain(`${MAC}-soilhum9`);
    }
    for (const dp of excluded ?? []) {
      expect(ids.some(id => id.endsWith(`-${dp}`)), `${dp} was absent before upgrade`).toBe(false);
    }
    if (label === 'station-specific exclusions') {
      expect(ids).not.toContain(`${MAC}-barn_temp`);
      expect(ids).toContain(`${OTHER}-barn_temp`);
      expect(ids).not.toContain(`${OTHER}-humid_aux`);
      expect(ids).toContain(`${MAC}-humid_aux`);
    }
    const upgraded = await boot(Candidate as unknown as Constructor, home, block, STATIONS, published.cache);
    noChurn(upgraded, published.cache);
    expect(graphs(upgraded.cache)).toEqual(before);
    expect(existsSync(path.join(home.persistDir, 'legacy-config-snapshot.json'))).toBe(false);
    const converted = await save(home, block, upgraded.cache);
    expect(converted).toMatchObject({ configVersion: 2, catalogBaseline: 1, catalogAdopted: 1 });
    const convertedBoot = await boot(Candidate as unknown as Constructor, home, converted, STATIONS, upgraded.cache);
    noChurn(convertedBoot, upgraded.cache);
    expect(graphs(convertedBoot.cache)).toEqual(before);
  });

  it('limits the reviewed signature-less battery normalization to the actual canonical service', async () => {
    const block = { ...BASE, temperatureSensors: true };
    const absent: RawStation[] = [{ macAddress: MAC, info: { name: 'Roof' }, lastData: { tempf: 72 } }];
    const present: RawStation[] = [{ ...absent[0], lastData: { tempf: 72, battout: 0 } }];
    const home = newHome();
    const published = await boot(Published173 as unknown as Constructor, home, block, absent);
    const temperature = published.cache.find(a => uid(a) === `${MAC}-tempf`)!;
    expect(temperature).toBeDefined();
    expect(temperature.getService(published.api.hap.Service.Battery)).toBeUndefined();

    // The documented R3-4 exception is explicit, not hidden by a whole-graph
    // normalizer: only this missing canonical battery is attached in place.
    const upgraded = await boot(Candidate as unknown as Constructor, home, block, absent, published.cache);
    noChurn(upgraded, published.cache);
    expect(temperature.getService(upgraded.api.hap.Service.Battery)).toBeDefined();
    const publishedReported = await boot(Published173 as unknown as Constructor, newHome(), block, present);
    const reported = await boot(Candidate as unknown as Constructor, home, block, present, upgraded.cache);
    noChurn(reported, upgraded.cache);
    expect(graphs(reported.cache)).toEqual(graphs(publishedReported.cache));
    expect(temperature.getService(reported.api.hap.Service.Battery)
      ?.getCharacteristic(reported.api.hap.Characteristic.StatusLowBattery).value).toBe(1);
  });

  it.each([false, true])('does not invent a canonical battery host for legacy gap channels (battery reported: %s)', async batteryReported => {
    const block = { ...BASE, temperatureSensors: true };
    const stations: RawStation[] = [{ macAddress: MAC, info: { name: 'Roof' }, lastData: {
      temp11f: 65, dewPoint17: 42, ...(batteryReported ? { batt11: 0, batt17: 0 } : {}),
    } }];
    const home = newHome();
    const published = await boot(Published173 as unknown as Constructor, home, block, stations);
    expect(published.cache.map(uid).sort()).toEqual([`${MAC}-dewPoint17`, `${MAC}-temp11f`]);
    for (const accessory of published.cache) {
      expect(accessory.getService(published.api.hap.Service.Battery)).toBeUndefined();
    }
    const before = graphs(published.cache);
    const upgraded = await boot(Candidate as unknown as Constructor, home, block, stations, published.cache);
    noChurn(upgraded, published.cache);
    // Unlike tempf, neither gap key is a canonical host in published 1.7.3.
    // Reporting batt11/batt17 never granted ownership in that implementation.
    for (const accessory of upgraded.cache) {
      expect(accessory.getService(upgraded.api.hap.Service.Battery), uid(accessory)).toBeUndefined();
    }
    expect(graphs(upgraded.cache)).toEqual(before);
  });
});

describe('P5 published beta.17 caches', () => {
  it('retains the entire published legacy cache while repairing only the known broad-field gap', async () => {
    const block = { ...BASE, ...ALL };
    const expected = await boot(Published173 as unknown as Constructor, newHome(), block, STATIONS);
    const home = newHome();
    const published = await boot(PublishedBeta17 as unknown as Constructor, home, block, STATIONS);
    const oldGraphs = graphs(published.cache);
    const oldIds = new Set(published.cache.map(uid));
    const missing = expected.cache.map(uid).filter(id => !oldIds.has(id)).sort();
    expect(missing.length, 'published beta.17 genuinely lacks broad fallback fields').toBeGreaterThan(0);
    expect(missing).toContain(`${MAC}-barn_temp`);
    const upgraded = await boot(Candidate as unknown as Constructor, home, block, STATIONS, published.cache);
    expect(upgraded.api.unregistered).toEqual([]);
    expect(upgraded.api.registered.map(uid).sort()).toEqual(missing);
    for (const old of published.cache) { expect(upgraded.platform.accessories.find(a => a.UUID === old.UUID)).toBe(old); }
    expect(graphs(published.cache)).toEqual(oldGraphs);
    expect(graphs(upgraded.cache)).toEqual(graphs(expected.cache));
    const converted = await save(home, block, upgraded.cache);
    const convertedBoot = await boot(Candidate as unknown as Constructor, home, converted, STATIONS, upgraded.cache);
    noChurn(convertedBoot, upgraded.cache);
    expect(graphs(convertedBoot.cache)).toEqual(graphs(expected.cache));
  });

  it.each([
    { label: 'Demeter mph assignment', sourceUnit: 'mph', displayUnit: 'mph', threshold: 12, expected: '10 mph' },
    { label: 'non-default source and display units', sourceUnit: 'mps', displayUnit: 'fps', threshold: 12, expected: '33 fps' },
  ])('preserves Celsius, lux, and $label through upgrade, save, and fresh readings', async ({ sourceUnit, displayUnit, threshold, expected }) => {
    const home = newHome();
    const custom = [
      { dataPoint: 'barn_temp', stationMac: MAC, kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', name: 'Barn Temperature' },
      { dataPoint: 'barn_solar', stationMac: MAC, kind: 'light', measurement: 'illuminance', sourceUnit: 'lux', name: 'Barn Light' },
      { dataPoint: 'windspdmph_avg10m', stationMac: MAC, kind: 'motion', measurement: 'wind-speed', sourceUnit,
        displayUnit, threshold, triggerEnabled: true, triggerDirection: 'above', name: 'Wind Speed Average' },
    ];
    const block = { ...BASE, configVersion: 2, _sensorMapV2: true, sensorMap: custom };
    const stations: RawStation[] = [{ macAddress: MAC, info: { name: 'Barn' }, lastData: { tempf: 72, battout: 1, barn_temp: 25, barn_solar: 25, windspdmph_avg10m: 10 } }];
    const published = await boot(PublishedBeta17 as unknown as Constructor, home, block, stations);
    const before = graphs(published.cache);
    const characteristic = (cache: HapLifecyclePlatformAccessory[], dp: string, name: string): unknown => {
      const accessory = cache.find(a => uid(a) === `${MAC}-${dp}`)!;
      expect(accessory, `${dp} was genuinely registered`).toBeDefined();
      const found = accessory.services.flatMap(service => service.characteristics).find(c => c.displayName === name);
      expect(found, `${dp} ${name}`).toBeDefined();
      return found!.value;
    };
    expect(characteristic(published.cache, 'barn_temp', 'Current Temperature')).toBe(25);
    expect(characteristic(published.cache, 'barn_solar', 'Current Ambient Light Level')).toBe(25);
    expect(characteristic(published.cache, 'windspdmph_avg10m', 'Value')).toBe(expected);
    expect(characteristic(published.cache, 'windspdmph_avg10m', 'Motion Detected')).toBe(false);
    const upgraded = await boot(Candidate as unknown as Constructor, home, block, stations, published.cache);
    noChurn(upgraded, published.cache);
    expect(graphs(upgraded.cache)).toEqual(before);
    const saved = await save(home, block, upgraded.cache, custom);
    const state = await handleGetEditorState({ persistDir: home.persistDir, configPath: home.configPath, version: 'p5', env: {}, log: silentLog }, {});
    for (const authored of custom) {
      expect(state.rows.find(r => r.dataPoint === authored.dataPoint)).toMatchObject({
        kind: authored.kind, measurement: authored.measurement, sourceUnit: authored.sourceUnit, identityScope: 'custom-station',
      });
    }
    const newPayload: RawStation[] = [{ ...stations[0], lastData: { ...stations[0].lastData, barn_temp: 26, barn_solar: 31, windspdmph_avg10m: 13 } }];
    const savedBoot = await boot(Candidate as unknown as Constructor, home, saved, newPayload, upgraded.cache);
    noChurn(savedBoot, upgraded.cache);
    expect(characteristic(savedBoot.cache, 'barn_temp', 'Current Temperature')).toBe(26);
    expect(characteristic(savedBoot.cache, 'barn_solar', 'Current Ambient Light Level')).toBe(31);
    expect(characteristic(savedBoot.cache, 'windspdmph_avg10m', 'Motion Detected')).toBe(true);
    const publishedFresh = await boot(PublishedBeta17 as unknown as Constructor, newHome(), block, newPayload);
    expect(graphs(savedBoot.cache)).toEqual(graphs(publishedFresh.cache));
  });
});

describe('P5 real 1.7.3 rollback from catalog-4 state and numeric caches', () => {
  it('freezes marked config untouched, then removes exactly the custom loss boundary after the documented rollback', async () => {
    const home = newHome();
    const custom = [
      { dataPoint: 'custom_contact', stationMac: MAC, kind: 'contact', measurement: 'boolean', name: 'Barn Door' },
      { dataPoint: 'barn_temp', stationMac: MAC, kind: 'motion', measurement: 'numeric', sourceUnit: 'raw',
        unitLabel: 'widgets', name: 'Barn Counter', threshold: 7, triggerEnabled: true },
    ];
    const block = { ...BASE, configVersion: 2, _sensorMapV2: true, catalogBaseline: 1, catalogAdopted: 4, sensorMap: custom };
    const stations: RawStation[] = [{ macAddress: MAC, info: { name: 'Barn' }, lastData: {
      tempf: 72, battout: 1, custom_contact: 1, barn_temp: 25,
    } }];
    const v2 = await boot(Candidate as unknown as Constructor, home, block, stations);
    expect(v2.cache.map(uid).sort()).toEqual([`${MAC}-barn_temp`, `${MAC}-custom_contact`, `${MAC}-tempf`]);
    expect(v2.cache.find(a => uid(a) === `${MAC}-custom_contact`)
      ?.getService(v2.api.hap.Service.ContactSensor)
      ?.getCharacteristic(v2.api.hap.Characteristic.ContactSensorState).value).toBe(1);
    expect(v2.cache.find(a => uid(a) === `${MAC}-barn_temp`)
      ?.services.flatMap(service => service.characteristics).find(c => c.displayName === 'Value')?.value).toBe('25 widgets');
    const saved = await save(home, block, v2.cache, custom);
    const state = await handleGetEditorState({ persistDir: home.persistDir, configPath: home.configPath, version: 'p5', env: {}, log: silentLog }, {});
    expect(state.mirrorState).toBe('recognized');
    expect(saved.excludeSensors, 'numeric name must not become a legacy temperature').toContain('barn_temp');
    const before = graphs(v2.cache);
    const frozen = await boot(Published173 as unknown as Constructor, home, saved, stations, v2.cache, 'guard-frozen');
    noChurn(frozen, v2.cache);
    expect(frozen.api.updated).toEqual([]);
    expect(graphs(frozen.cache)).toEqual(before);

    const rollback = { ...saved };
    for (const key of ['sensorMap', 'configVersion', '_legacyMirror', '_sensorMapV2']) { delete rollback[key]; }
    const rolled = await boot(Published173 as unknown as Constructor, home, rollback, stations, frozen.cache);
    expect(rolled.api.registered).toEqual([]);
    expect(rolled.api.unregistered.map(uid).sort()).toEqual([`${MAC}-barn_temp`, `${MAC}-custom_contact`]);
    const temperature = v2.cache.find(a => uid(a) === `${MAC}-tempf`)!;
    expect(rolled.cache).toEqual([temperature]);
    expect(rolled.platform.accessories).toContain(temperature);
    const fresh = await boot(Published173 as unknown as Constructor, newHome(), rollback, stations);
    expect(graphs(rolled.cache)).toEqual(graphs(fresh.cache));
  });
});

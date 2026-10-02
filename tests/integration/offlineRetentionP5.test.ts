/** P5: missing telemetry is not an instruction to remove a HomeKit accessory. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import hap from '@homebridge/hap-nodejs';
import { AmbientWeatherSensorsPlatform } from '../../dist/platform.js';
import { RealtimeSource } from '../../dist/realtimeSource.js';
import { LAST_UPDATED_CHARACTERISTIC_UUID, VALUE_CHARACTERISTIC_UUID } from '../../dist/extendedSensors/customCharacteristics.js';
import { handleCommitSave, handleComposeSave, handleGetEditorState, handlePreviewSave } from '../../homebridge-ui/handlers.js';
import { DraftStore } from '../../homebridge-ui/app-src/draft-store';
import { HapMockAPI, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';

const MAC = 'aa:bb:cc:dd:ee:01';
const OTHER = 'AA:BB:CC:DD:EE:02';
type Json = Record<string, unknown>;
type Accessory = HapLifecyclePlatformAccessory;
const roots: string[] = [];
const lives: Live[] = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const custom = { stationMac: MAC, dataPoint: 'flow1', kind: 'motion', measurement: 'numeric',
  sourceUnit: 'raw', name: 'Flow', unitLabel: 'L/min', enabled: true,
  threshold: 5, triggerEnabled: true, triggerDirection: 'above' };

interface Rig { root: string; config: Json; configPath: string }
interface Live {
  api: HapMockAPI; platform: AmbientWeatherSensorsPlatform; stopped: boolean; source: RealtimeSource;
  push(mac: string, values: Json): void;
  poll(stations: Json[]): Promise<void>;
}

function rig(extra: Json = {}): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'awn-offline-p5-'));
  roots.push(root);
  const config = JSON.parse(JSON.stringify({ platform: 'AmbientWeatherSensors', name: 'P5 offline',
    apiKey: 'fake-key', applicationKey: 'fake-application-key', dataSource: 'polling',
    configVersion: 2, catalogBaseline: 1, catalogAdopted: 4, sensorMap: [custom], ...extra })) as Json;
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: [config] }, null, 2));
  return { root, config, configPath };
}

function station(lastData: Json, macAddress = MAC, name?: string): Json {
  return { macAddress, ...(name === undefined ? {} : { info: { name } }), lastData };
}

async function boot(r: Rig, initial: Json[], cached: Accessory[] = [], patch: Json = {}): Promise<Live> {
  const api = new HapMockAPI();
  api.user.storagePath = () => r.root;
  (api.user as { configPath?: () => string }).configPath = () => r.configPath;
  let payload = initial;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const logger = new MockLogger();
  const before = readFileSync(r.configPath, 'utf8');
  const platform = new AmbientWeatherSensorsPlatform(logger as never, { ...r.config, ...patch } as never, api as never);
  for (const accessory of cached) platform.configureAccessory(accessory as never);
  api.emit('didFinishLaunching');
  await vi.waitFor(() => expect(logger.logs.some(l => l.message.startsWith('Data source:'))).toBe(true), { timeout: 10000 });
  expect(fetch).toHaveBeenCalled();
  expect(readFileSync(r.configPath, 'utf8')).toBe(before);
  const source = new RealtimeSource({ apiKey: 'fake-key', applicationKey: 'fake-application-key',
    log: quiet as never, catalogAdopted: 4,
    onUpdates: updates => (platform as unknown as { distribute(updates: unknown[]): void }).distribute(updates),
  });
  const live: Live = { api, platform, source, stopped: false,
    push: (mac, values) => (source as unknown as { handleDevicePayload(payload: Json): void })
      .handleDevicePayload({ macAddress: mac, ...values }),
    poll: async next => {
      payload = next;
      const calls = fetch.mock.calls.length;
      await (platform as unknown as { pollAndDistribute(): Promise<void> }).pollAndDistribute();
      expect(fetch.mock.calls.length).toBe(calls + 1);
    },
  };
  lives.push(live);
  return live;
}

async function stop(live: Live): Promise<void> {
  if (live.stopped) return;
  live.stopped = true;
  live.source.stop();
  live.api.emit('shutdown');
  await (live.platform as unknown as { v2Tracker?: { flush(force: boolean): Promise<void> } }).v2Tracker?.flush(true);
}

function uid(a: Accessory): string { return (a.context.device as { uniqueId: string }).uniqueId; }
function ids(accessories: Accessory[]): string[] { return accessories.map(uid).sort(); }
function flow(a: Accessory): unknown {
  return (a.getService(hap.Service.MotionSensor) as hap.Service).characteristics.find(c => c.UUID === VALUE_CHARACTERISTIC_UUID)?.value;
}
function temperature(a: Accessory): unknown {
  return (a.getService(hap.Service.TemperatureSensor) as hap.Service).getCharacteristic(hap.Characteristic.CurrentTemperature).value;
}
function lowBattery(a: Accessory): unknown {
  return (a.getService(hap.Service.Battery) as hap.Service).getCharacteristic(hap.Characteristic.StatusLowBattery).value;
}
function retained(live: Live, cached: Accessory[]): void {
  expect(live.api.registered).toEqual([]);
  expect(live.api.unregistered).toEqual([]);
  expect(ids(live.platform.accessories)).toEqual(ids(cached));
  for (const prior of cached) expect(live.platform.accessories.find(a => a.UUID === prior.UUID)).toBe(prior);
}
function deleteDiscovery(r: Rig): void {
  rmSync(path.join(r.root, 'plugin-data', 'ambient-weather', 'discovery.json'), { force: true });
}

afterEach(async () => {
  for (const live of lives.splice(0)) await stop(live);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

describe('P5 cached accessories across offline and partial telemetry', () => {
  it('retains a missing numeric field and routes its first returning realtime and polling samples in place', async () => {
    const r = rig();
    const first = await boot(r, [station({ tempf: 68, flow1: 8, battout: 0 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-flow1`, `${MAC}-tempf`]);
    const numeric = cached.find(a => uid(a).endsWith('-flow1'))!;
    const native = cached.find(a => uid(a).endsWith('-tempf'))!;
    expect(flow(numeric)).toBe('8 L/min');
    expect(lowBattery(native)).toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    const motion = numeric.getService(hap.Service.MotionSensor) as hap.Service;
    expect(motion.getCharacteristic(hap.Characteristic.MotionDetected).value).toBe(true);
    await stop(first);
    const second = await boot(r, [station({ tempf: 77 }, MAC.toUpperCase())], cached);
    retained(second, cached);
    expect(flow(numeric)).toBe('8 L/min');
    expect(temperature(native)).toBe(25);
    expect(lowBattery(native)).toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(uid(numeric)).toBe(`${MAC}-flow1`);
    second.push(MAC.toUpperCase(), { flow1: 2 });
    expect(numeric.getService(hap.Service.MotionSensor)).toBe(motion);
    expect(flow(numeric)).toBe('2 L/min');
    expect(motion.getCharacteristic(hap.Characteristic.MotionDetected).value).toBe(false);
    await second.poll([station({ flow1: 9, tempf: 86, battout: 1 })]);
    expect(flow(numeric)).toBe('9 L/min');
    expect(temperature(native)).toBe(30);
    expect(lowBattery(native)).toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    retained(second, cached);
  });

  it.each([false, true])('empty response retains cached rows with discovery deleted = %s and creates no unseen defaults', async deleted => {
    const r = rig({ sensorMap: [custom, { stationMac: MAC, dataPoint: 'unseen', kind: 'motion',
      measurement: 'numeric', sourceUnit: 'raw', enabled: true }] });
    const first = await boot(r, [station({ tempf: 68, flow1: 3 })]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-flow1`, `${MAC}-tempf`]);
    await stop(first);
    if (deleted) deleteDiscovery(r);
    const second = await boot(r, [], cached);
    retained(second, cached);
    if (deleted) {
      expect((second.platform as unknown as { v2Tracker: { snapshot(): { entries: unknown[] } } }).v2Tracker.snapshot().entries).toEqual([]);
    }
    expect(flow(cached.find(a => uid(a).endsWith('-flow1'))!)).toBe('3 L/min');
    second.push(MAC, { flow1: 4, tempf: 86, unseen: 10 });
    expect(flow(cached.find(a => uid(a).endsWith('-flow1'))!)).toBe('4 L/min');
    expect(temperature(cached.find(a => uid(a).endsWith('-tempf'))!)).toBe(30);
    retained(second, cached);
  });

  it('keeps an absent station while another reports and routes the absent station on return', async () => {
    const r = rig({ sensorMap: [] });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn'), station({ tempf: 77 }, OTHER, 'House')]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${OTHER}-tempf`, `${MAC}-tempf`].sort());
    await stop(first);
    const second = await boot(r, [station({ tempf: 86 }, OTHER, 'House')], cached);
    retained(second, cached);
    const barn = cached.find(a => uid(a) === `${MAC}-tempf`)!;
    expect(temperature(barn)).toBe(20);
    second.push(MAC, { tempf: 50 });
    expect(temperature(barn)).toBe(10);
  });

  it('retains a state fault through an absent-field restart and clears it on the first valid returning sample', async () => {
    const r = rig({ sensorMap: [{ stationMac: MAC, dataPoint: 'contact1', kind: 'contact', measurement: 'boolean', enabled: true }] });
    const first = await boot(r, [station({ contact1: 2 })]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-contact1`]);
    const service = cached[0].getService(hap.Service.ContactSensor) as hap.Service;
    expect(service.getCharacteristic(hap.Characteristic.StatusFault).value).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached);
    retained(second, cached);
    expect(cached[0].getService(hap.Service.ContactSensor)).toBe(service);
    expect(service.getCharacteristic(hap.Characteristic.StatusFault).value).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    second.push(MAC, { contact1: 1 });
    expect(service.getCharacteristic(hap.Characteristic.StatusFault).value).toBe(hap.Characteristic.StatusFault.NO_FAULT);
    expect(service.getCharacteristic(hap.Characteristic.ContactSensorState).value).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  });

  it('uses discovery names for partial metadata under a name filter, including subsequent polls', async () => {
    const r = rig({ sensorMap: [], stationFilter: ['Barn'] });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(1);
    await stop(first);
    const second = await boot(r, [station({ tempf: 77 })], cached);
    retained(second, cached);
    expect(temperature(cached[0])).toBe(25);
    await second.poll([station({ tempf: 86 })]);
    expect(temperature(cached[0])).toBe(30);
  });

  it('uses the latest observed station name when older field records retain a previous name', async () => {
    const r = rig();
    const first = await boot(r, [station({ tempf: 68, flow1: 3 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(2);
    await stop(first);
    const second = await boot(r, [station({ tempf: 77 }, MAC, 'House')], cached, { stationFilter: ['House'] });
    retained(second, cached);
    const native = cached.find(a => uid(a).endsWith('-tempf'))!;
    expect(temperature(native)).toBe(25);
    await second.poll([station({ tempf: 86 })]);
    expect(temperature(native)).toBe(30);
  });

  it('treats equal-time conflicting discovery names as unknown rather than choosing a filter side', async () => {
    const r = rig();
    const first = await boot(r, [station({ tempf: 68, flow1: 3 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(2);
    await stop(first);
    const discoveryPath = path.join(r.root, 'plugin-data', 'ambient-weather', 'discovery.json');
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { entries: Array<Json> };
    for (const entry of discovery.entries) {
      entry.stationName = entry.dataPoint === 'tempf' ? 'Barn' : 'House';
      entry.firstSeen = '2026-01-01T00:00:00.000Z';
      entry.lastSeen = '2026-01-02T00:00:00.000Z';
    }
    writeFileSync(discoveryPath, JSON.stringify(discovery));
    const contexts = cached.map(a => JSON.stringify(a.context));
    const second = await boot(r, [], cached, { stationFilter: ['Barn'] });
    retained(second, cached);
    expect(second.api.updated).toEqual([]);
    expect(cached.map(a => JSON.stringify(a.context))).toEqual(contexts);
  });

  it('applies an explicit single-station rename offline without replacing the cached graph', async () => {
    const r = rig();
    const first = await boot(r, [station({ flow1: 3 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(1);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached, { sensorMap: [{ ...custom, name: 'Renamed Flow' }] });
    retained(second, cached);
    expect(cached[0].displayName).toBe('Renamed Flow');
    expect(flow(cached[0])).toBe('3 L/min');
  });

  it('performs an explicitly previewed structural replacement offline without fabricating a reading', async () => {
    const r = rig({ sensorMap: [{ ...custom, batteryField: 'flow_battery' }] });
    const first = await boot(r, [station({ flow1: 8, flow_battery: 0 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-flow1`]);
    expect(cached[0].getService(hap.Service.Battery)).toBeDefined();
    await stop(first);
    const deps = { persistDir: path.join(r.root, 'plugin-data', 'ambient-weather'), configPath: r.configPath,
      version: 'p5-proof', env: {}, log: quiet };
    const cachedAccessoryUniqueIds = ids(cached);
    const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds });
    const proposal = [{ ...custom, batteryField: null }];
    const preview = await handlePreviewSave(deps, { cachedAccessoryUniqueIds, baseDigest: state.baseDigest,
      blockIndex: state.blockIndex, proposal });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error(preview.error.message);
    expect(preview.changes.map(row => ({ dataPoint: row.dataPoint, change: row.change, structural: row.structural })))
      .toEqual([{ dataPoint: 'flow1', change: 'modified', structural: true }]);
    const second = await boot(r, [], cached, { sensorMap: proposal });
    expect(second.api.unregistered).toEqual(cached);
    expect(ids(second.api.registered)).toEqual([`${MAC}-flow1`]);
    const replacement = second.api.registered[0];
    expect(replacement).not.toBe(cached[0]);
    expect(replacement.getService(hap.Service.Battery)).toBeUndefined();
    expect((replacement.context.device as Json).value).toBeUndefined();
    const service = replacement.getService(hap.Service.MotionSensor) as hap.Service;
    expect(service.characteristics.find(c => c.UUID === VALUE_CHARACTERISTIC_UUID)?.value).toBe('');
    expect(service.characteristics.find(c => c.UUID === LAST_UPDATED_CHARACTERISTIC_UUID)?.value).toBe('');
    second.push(MAC, { flow1: 4 });
    expect(flow(replacement)).toBe('4 L/min');
    expect(service.characteristics.find(c => c.UUID === LAST_UPDATED_CHARACTERISTIC_UUID)?.value).not.toBe('');
  });

  it('freezes an unknown name-filter membership instead of removing or rewriting its cache', async () => {
    const r = rig({ sensorMap: [] });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(1);
    const original = JSON.stringify(cached[0].context);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached, { stationFilter: ['Barn'] });
    retained(second, cached);
    expect(JSON.stringify(cached[0].context)).toBe(original);
    expect(second.api.updated).toEqual([]);
  });

  it('still honors an explicit disabled row when station name-filter membership is unknown', async () => {
    const r = rig({ sensorMap: [] });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(1);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached, { stationFilter: ['Barn'], sensorMap: [{ dataPoint: 'tempf', enabled: false }] });
    expect(ids(second.api.unregistered)).toEqual([`${MAC}-tempf`]);
    expect(second.api.registered).toEqual([]);
  });

  it.each([
    { label: 'known disabled', patch: { sensorMap: [custom, { dataPoint: 'tempf', enabled: false }] }, removed: 'tempf' },
    { label: 'custom disabled', patch: { sensorMap: [{ ...custom, enabled: false }] }, removed: 'flow1' },
    { label: 'custom identity deleted', patch: { sensorMap: [] }, removed: 'flow1' },
  ])('missing telemetry still honors explicit $label', async ({ patch, removed }) => {
    const r = rig();
    const first = await boot(r, [station({ tempf: 68, flow1: 3 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(2);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached, patch);
    expect(ids(second.api.unregistered)).toEqual([`${MAC}-${removed}`]);
    expect(second.api.registered).toEqual([]);
    expect(ids(second.platform.accessories)).toEqual(cached.filter(a => uid(a) !== `${MAC}-${removed}`).map(uid));
  });

  it.each([{ stationFilter: [OTHER] }, { stationFilter: ['House'] }])('missing telemetry honors a definitive filter exclusion $stationFilter', async ({ stationFilter }) => {
    const r = rig({ sensorMap: [] });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(cached).toHaveLength(1);
    await stop(first);
    const second = await boot(r, [], cached, { stationFilter });
    expect(ids(second.api.unregistered)).toEqual([`${MAC}-tempf`]);
    expect(second.api.registered).toEqual([]);
    expect(second.platform.accessories).toEqual([]);
  });

  it('resolves a broad legacy key from cache alone and still honors its category toggle', async () => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, temperatureSensors: true });
    const first = await boot(r, [station({ feelsLike21: 68 })]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-feelsLike21`]);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached);
    retained(second, cached);
    expect(temperature(cached[0])).toBe(20);
    second.push(MAC, { feelsLike21: 86 });
    expect(temperature(cached[0])).toBe(30);
    await stop(second);
    deleteDiscovery(r);
    const third = await boot(r, [], cached, { temperatureSensors: false });
    expect(ids(third.api.unregistered)).toEqual([`${MAC}-feelsLike21`]);
    expect(third.api.registered).toEqual([]);
  });

  it.each([
    { excludeSensors: ['feelsLike21'] },
    { excludeSensors: [`${MAC}-feelsLike21`] },
    { includeOnly: ['tempf'] },
  ])('honors cache-only legacy include/exclude %j without removing its sibling', async patch => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, temperatureSensors: true });
    const first = await boot(r, [station({ feelsLike21: 68, tempf: 77 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-feelsLike21`, `${MAC}-tempf`]);
    await stop(first);
    // An unmatched allowlist token might be an unknown station name. Keep
    // observed names for this definite raw-field allowlist control; positive
    // raw/UID exclusions remain definite even with discovery deleted.
    if (!('includeOnly' in patch)) deleteDiscovery(r);
    const second = await boot(r, [], cached, patch);
    expect(ids(second.api.unregistered)).toEqual([`${MAC}-feelsLike21`]);
    expect(second.api.registered).toEqual([]);
    expect(ids(second.platform.accessories)).toEqual([`${MAC}-tempf`]);
  });

  it.each(['Barn', 'Barn Outdoor Temperature'])('retains legacy cached rows when includeOnly %s cannot be evaluated after discovery loss', async token => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, temperatureSensors: true, includeOnly: [token] });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn')]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-tempf`]);
    await stop(first);
    deleteDiscovery(r);
    const second = await boot(r, [], cached);
    retained(second, cached);
    expect(temperature(cached[0])).toBe(20);
  });

  it.each([
    { key: 'includeOnly', token: 'Barn', removed: OTHER },
    { key: 'includeOnly', token: 'Barn Outdoor Temperature', removed: OTHER },
    { key: 'excludeSensors', token: 'Barn', removed: MAC },
    { key: 'excludeSensors', token: 'Barn Outdoor Temperature', removed: MAC },
  ])('refuses name-uncertain $key=$token conversion; restored names settle the exact sibling boundary', async ({ key, token, removed }) => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, temperatureSensors: true });
    const first = await boot(r, [station({ tempf: 68 }, MAC, 'Barn'), station({ tempf: 77 }, OTHER, 'House')]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-tempf`, `${OTHER}-tempf`].sort());
    await stop(first);
    const persistDir = path.join(r.root, 'plugin-data', 'ambient-weather');
    const discoveryPath = path.join(persistDir, 'discovery.json');
    const observed = readFileSync(discoveryPath, 'utf8');
    deleteDiscovery(r);
    r.config[key] = [token];
    writeFileSync(r.configPath, JSON.stringify({ platforms: [r.config] }));
    const second = await boot(r, [], cached);
    retained(second, cached);
    expect(second.api.updated).toEqual([]);
    await stop(second);
    const deps = { persistDir, configPath: r.configPath, version: 'p5-proof', env: {}, log: quiet };
    const cachedAccessoryUniqueIds = ids(cached);
    const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds });
    const request = { baseDigest: state.baseDigest, blockIndex: state.blockIndex, cachedAccessoryUniqueIds, formBlock: r.config };
    const before = readFileSync(r.configPath, 'utf8');
    for (const endpoint of [handlePreviewSave, handleComposeSave, handleCommitSave]) {
      expect(await endpoint(deps, request)).toMatchObject({ ok: false, error: { code: 'indeterminate-legacy-filter' } });
      expect(readFileSync(r.configPath, 'utf8')).toBe(before);
      expect(existsSync(path.join(persistDir, 'legacy-config-snapshot.json'))).toBe(false);
      expect(existsSync(path.join(persistDir, 'legacy-conversion-journal'))).toBe(false);
    }
    const drafts = new DraftStore();
    drafts.reset(state.authored);
    const repair = await handleComposeSave(deps, { ...request, proposal: drafts.proposal(), settings: { apiKey: { set: 'repair-only' } } });
    expect(repair.ok, JSON.stringify(repair)).toBe(true);
    if (!repair.ok) throw new Error(repair.error.message);
    expect(repair.nextConfig).toEqual({ ...r.config, apiKey: 'repair-only' });
    expect(repair.snapshot).toBe('not-applicable');
    writeFileSync(discoveryPath, observed);
    const preview = await handlePreviewSave(deps, request);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error(preview.error.message);
    const composed = await handleComposeSave(deps, { ...request, confirmDigest: preview.digest });
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    if (!composed.ok) throw new Error(composed.error.message);
    expect(composed.nextConfig.sensorMap).toContainEqual(expect.objectContaining({ stationMac: removed.toUpperCase(), dataPoint: 'tempf', enabled: false }));
    const settled = await boot(r, [], cached);
    expect(ids(settled.api.unregistered)).toEqual([`${removed}-tempf`]);
    expect(settled.api.registered).toEqual([]);
    expect(ids(settled.platform.accessories)).toEqual(ids(cached).filter(id => id !== `${removed}-tempf`));
  });

  it.each([
    { temperatureSensors: false, includeOnly: ['Barn'] },
    { temperatureSensors: true, includeOnly: [MAC] },
  ])('does not reject name-independent legacy conversion %j', async config => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, ...config });
    const deps = { persistDir: path.join(r.root, 'plugin-data', 'ambient-weather'), configPath: r.configPath,
      version: 'p5-proof', env: {}, log: quiet };
    const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds: [`${MAC}-tempf`] });
    const preview = await handlePreviewSave(deps, { baseDigest: state.baseDigest, blockIndex: state.blockIndex,
      cachedAccessoryUniqueIds: [`${MAC}-tempf`] });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
  });

  it('keeps cache-only broad legacy disable semantics through editor preview, conversion, persisted reload and returning data', async () => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, temperatureSensors: true });
    const first = await boot(r, [station({ feelsLike21: 68 })]);
    const cached = [...first.api.registered];
    expect(ids(cached)).toEqual([`${MAC}-feelsLike21`]);
    await stop(first);
    deleteDiscovery(r);
    r.config.temperatureSensors = false;
    writeFileSync(r.configPath, JSON.stringify({ platforms: [r.config] }));
    const deps = { persistDir: path.join(r.root, 'plugin-data', 'ambient-weather'), configPath: r.configPath,
      version: 'p5-proof', env: {}, log: quiet };
    const cachedAccessoryUniqueIds = ids(cached);
    const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds });
    expect(state.rows.find(row => row.dataPoint === 'feelsLike21')).toMatchObject({ enabled: false });
    const request = { cachedAccessoryUniqueIds, baseDigest: state.baseDigest, blockIndex: state.blockIndex };
    const before = readFileSync(r.configPath, 'utf8');
    const preview = await handlePreviewSave(deps, request);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error(preview.error.message);
    expect(preview.changes).toEqual([]);
    const payload = { ...request, formBlock: r.config, confirmDigest: preview.digest };
    const composed = await handleComposeSave(deps, payload);
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    if (!composed.ok) throw new Error(composed.error.message);
    const committed = await handleCommitSave(deps, { ...payload, validationToken: composed.validationToken });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    if (!committed.ok) throw new Error(committed.error.message);
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    expect(committed.nextConfig.sensorMap).toContainEqual(expect.objectContaining({ dataPoint: 'feelsLike21', enabled: false }));
    r.config = committed.nextConfig;
    writeFileSync(r.configPath, JSON.stringify({ platforms: [r.config] }));
    const reloaded = await handleGetEditorState(deps, { cachedAccessoryUniqueIds });
    expect(reloaded.rows.find(row => row.dataPoint === 'feelsLike21')).toMatchObject({ enabled: false });
    const live = await boot(r, [station({ feelsLike21: 86 })], cached);
    expect(ids(live.api.unregistered)).toEqual([`${MAC}-feelsLike21`]);
    expect(live.api.registered).toEqual([]);
  });

  it.each([undefined, null, 'unavailable'])('refuses conversion on unknown cache inventory %j, with zero records and settings repair still available', async cache => {
    const r = rig({ configVersion: undefined, catalogBaseline: undefined, catalogAdopted: undefined,
      sensorMap: undefined, temperatureSensors: true, humiditySensors: true });
    const first = await boot(r, [station({ feelsLike21: 68, humidity: 45 }, MAC, 'Barn')]);
    expect(ids(first.api.registered)).toEqual([`${MAC}-feelsLike21`, `${MAC}-humidity`]);
    await stop(first);
    const persistDir = path.join(r.root, 'plugin-data', 'ambient-weather');
    const discoveryPath = path.join(persistDir, 'discovery.json');
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { entries: Array<Json> };
    discovery.entries = discovery.entries.filter(row => row.dataPoint === 'humidity');
    writeFileSync(discoveryPath, JSON.stringify(discovery));
    r.config.temperatureSensors = false;
    writeFileSync(r.configPath, JSON.stringify({ platforms: [r.config] }));
    const deps = { persistDir, configPath: r.configPath, version: 'p5-proof', env: {}, log: quiet };
    const state = await handleGetEditorState(deps, {});
    const request = { baseDigest: state.baseDigest, blockIndex: state.blockIndex,
      ...(cache === undefined ? {} : { cachedAccessoryUniqueIds: cache }), formBlock: r.config };
    const before = readFileSync(r.configPath, 'utf8');
    for (const endpoint of [handlePreviewSave, handleComposeSave, handleCommitSave]) {
      expect(await endpoint(deps, request)).toMatchObject({ ok: false, error: { code: 'cache-inventory-unavailable' } });
      expect(readFileSync(r.configPath, 'utf8')).toBe(before);
      expect(existsSync(path.join(persistDir, 'legacy-config-snapshot.json'))).toBe(false);
      expect(existsSync(path.join(persistDir, 'legacy-conversion-journal'))).toBe(false);
    }
    const drafts = new DraftStore();
    drafts.reset(state.authored);
    const repair = { ...request, proposal: drafts.proposal(), settings: { apiKey: { set: 'fixed-fake-key' } } };
    const preview = await handlePreviewSave(deps, repair);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error(preview.error.message);
    const composed = await handleComposeSave(deps, { ...repair, confirmDigest: preview.digest });
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    if (!composed.ok) throw new Error(composed.error.message);
    const committed = await handleCommitSave(deps, { ...repair, confirmDigest: preview.digest, validationToken: composed.validationToken });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    if (!committed.ok) throw new Error(committed.error.message);
    expect(committed.nextConfig).toEqual({ ...r.config, apiKey: 'fixed-fake-key' });
    expect(committed.snapshot).toBe('not-applicable');
    expect(existsSync(path.join(persistDir, 'legacy-config-snapshot.json'))).toBe(false);
  });
});

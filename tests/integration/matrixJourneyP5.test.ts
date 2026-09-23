/**
 * P5 input/output matrix as complete user journeys, not resolver-only cases.
 * The browser draft store consumes built editor-state; the actual orchestrator
 * persists built preview/compose/commit output. The resulting on-disk block
 * drives the built platform, real HAP services, REST and RealtimeSource, cached
 * restart, and a second non-identity editor save/reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import hap from '@homebridge/hap-nodejs';

import { AmbientWeatherSensorsPlatform } from '../../dist/platform.js';
import { RealtimeSource } from '../../dist/realtimeSource.js';
import { VALUE_CHARACTERISTIC_UUID, INTENSITY_CHARACTERISTIC_UUID } from '../../dist/extendedSensors/customCharacteristics.js';
import { handleCommitSave, handleComposeSave, handleGetEditorState, handlePreviewSave } from '../../homebridge-ui/handlers.js';
import { composeAndPersist } from '../../homebridge-ui/saveOrchestrator.js';
import { DraftStore, type DraftableField } from '../../homebridge-ui/app-src/draft-store';
import type { HandlerDeps } from '../../homebridge-ui/handlers';
import type { EditorStateDto, PreviewResultDto } from '../../homebridge-ui/app-src/dto/editor-state';
import { HapMockAPI, serializeRegistered, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:05';
type Json = Record<string, unknown>;
const ROOTS: string[] = [];
const LIVES: Live[] = [];
const log = { info() {}, warn() {}, debug() {}, error() {}, log() {} };

interface Rig {
  root: string;
  configPath: string;
  deps: HandlerDeps;
  readBlock(): Json;
}
interface Live {
  api: HapMockAPI;
  platform: AmbientWeatherSensorsPlatform;
  source: RealtimeSource;
  stopped: boolean;
  push(values: Json): void;
  poll(values: Json): Promise<void>;
}
interface MatrixCell {
  label: string;
  dataPoint: string;
  scope: 'known' | 'custom-station';
  kind: string;
  measurement: string;
  sourceUnit: string;
  fields: Partial<Record<DraftableField, unknown>>;
  firstRaw: number;
  firstValue: number | string;
  realtimeRaw: number;
  realtimeValue: number | string;
  restartRaw: number;
  restartValue: number | string;
  afterSaveRaw: number;
  afterSaveValue: number | string;
  native: boolean;
}

const MATRIX: MatrixCell[] = [
  {
    label: 'documented AWN / native HomeKit', dataPoint: 'tempf', scope: 'known', native: true,
    kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit',
    fields: { enabled: true, name: 'Matrix outside temperature' },
    firstRaw: 68, firstValue: 20, realtimeRaw: 86, realtimeValue: 30,
    restartRaw: 59, restartValue: 15, afterSaveRaw: 77, afterSaveValue: 25,
  },
  {
    label: 'documented AWN / extended motion carrier', dataPoint: 'soilhum1', scope: 'known', native: false,
    kind: 'motion', measurement: 'soil-moisture', sourceUnit: 'percent',
    fields: { enabled: true, name: 'Matrix soil moisture', threshold: 50, triggerEnabled: true, triggerDirection: 'above' },
    firstRaw: 25, firstValue: '25%', realtimeRaw: 50, realtimeValue: '50%',
    restartRaw: 40, restartValue: '40%', afterSaveRaw: 60, afterSaveValue: '60%',
  },
  {
    label: 'undocumented input / native HomeKit', dataPoint: 'p5_probe_c', scope: 'custom-station', native: true,
    kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius',
    fields: { enabled: true, name: 'Matrix custom Celsius', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius' },
    firstRaw: 25, firstValue: 25, realtimeRaw: -5, realtimeValue: -5,
    restartRaw: 10, restartValue: 10, afterSaveRaw: 0, afterSaveValue: 0,
  },
  {
    label: 'undocumented input / extended motion carrier', dataPoint: 'p5_air_reading', scope: 'custom-station', native: false,
    kind: 'motion', measurement: 'numeric', sourceUnit: 'raw',
    fields: { enabled: true, name: 'Matrix arbitrary number', kind: 'motion', measurement: 'numeric', sourceUnit: 'raw',
      unitLabel: 'µg/m³', threshold: 7, triggerEnabled: true, triggerDirection: 'above' },
    firstRaw: 3.5, firstValue: '3.5 µg/m³', realtimeRaw: 7, realtimeValue: '7 µg/m³',
    restartRaw: -2, restartValue: '-2 µg/m³', afterSaveRaw: 8.125, afterSaveValue: '8.125 units',
  },
];

function rig(dataPoint: string, baseline: unknown[] = [], catalogAdopted = 4): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'awn-matrix-p5-'));
  ROOTS.push(root);
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: [{
    platform: 'AmbientWeatherSensors', name: 'P5 matrix',
    apiKey: 'p5-fake-api-key', applicationKey: 'p5-fake-application-key',
    dataSource: 'polling', configVersion: 2, catalogBaseline: 1, catalogAdopted, sensorMap: baseline,
  }] }, null, 2));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: [{
    stationMac: MAC, stationName: 'P5 station', dataPoint,
    firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
  }] }));
  return { root, configPath, deps: { persistDir, configPath, version: 'P5-proof', env: {}, log },
    readBlock: () => JSON.parse(readFileSync(configPath, 'utf8')).platforms[0] as Json };
}

function cacheIds(cached: HapLifecyclePlatformAccessory[]): string[] {
  return cached.map(a => (a.context.device as { uniqueId: string }).uniqueId);
}

async function editorSave(
  r: Rig,
  mutate: (store: DraftStore, state: EditorStateDto) => void,
  cached: HapLifecyclePlatformAccessory[] = [],
  operation: { adoptCatalogVersion?: number; omitProposal?: boolean; settings?: unknown } = {},
): Promise<{ state: EditorStateDto; preview: Extract<PreviewResultDto, { ok: true }>; events: string[] }> {
  const state = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: cacheIds(cached) });
  const store = new DraftStore();
  store.reset(state.authored);
  mutate(store, state);
  const proposal = store.proposal();
  const { omitProposal, ...operationArgs } = operation;
  const baseArgs = { baseDigest: state.baseDigest, blockIndex: state.blockIndex,
    ...(omitProposal ? {} : { proposal }), ...operationArgs };
  const bytes = readFileSync(r.configPath, 'utf8');
  const preview = await handlePreviewSave(r.deps, { ...baseArgs, cachedAccessoryUniqueIds: cacheIds(cached) });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  if (!preview.ok) throw new Error('Preview refused');
  expect(readFileSync(r.configPath, 'utf8')).toBe(bytes);
  const events: string[] = [];
  let session: Json[] = state.freshInstall ? [] : [r.readBlock()];
  const result = await composeAndPersist({
    freezeSettingsForm: () => { events.push('freeze'); },
    unfreezeSettingsForm: () => { events.push('restore'); },
    getPluginConfig: async () => session,
    getCachedAccessories: async () => cached,
    request: async (endpoint, payload) => {
      events.push(endpoint);
      expect(readFileSync(r.configPath, 'utf8')).toBe(bytes);
      if (endpoint === '/compose-save') return handleComposeSave(r.deps, payload);
      if (endpoint === '/commit-save') return handleCommitSave(r.deps, payload);
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
    updatePluginConfig: async blocks => {
      events.push('update');
      // Match HB UI's merge semantics, including the orchestrator's undefined tombstones.
      session = blocks.map((block, index) => Object.assign({}, session[index], block));
    },
    savePluginConfig: async () => {
      events.push('persist');
      writeFileSync(r.configPath, JSON.stringify({ platforms: session }, null, 2));
    },
  }, { ...baseArgs, confirmDigest: preview.digest });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Save refused');
  expect(r.readBlock()).toEqual(result.nextConfig);
  expect(events).toEqual(['freeze', '/compose-save', '/commit-save', 'update', 'persist']);
  const reloaded = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: cacheIds(cached) });
  expect(reloaded.baseDigest).toBe(result.nextConfigDigest);
  return { state: reloaded, preview, events };
}

async function boot(r: Rig, raw: Json, cached: HapLifecyclePlatformAccessory[] = []): Promise<Live> {
  const configBytes = readFileSync(r.configPath, 'utf8');
  const api = new HapMockAPI();
  api.user.storagePath = () => r.root;
  (api.user as { configPath?: () => string }).configPath = () => r.configPath;
  const logger = new MockLogger();
  let polledValues = raw;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify([
    { macAddress: MAC, info: { name: 'P5 station' }, lastData: polledValues },
  ]), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const platform = new AmbientWeatherSensorsPlatform(logger as never, r.readBlock() as never, api as never);
  for (const accessory of cached) platform.configureAccessory(accessory as never);
  api.emit('didFinishLaunching');
  await vi.waitFor(() => expect(logger.logs.some(l => l.message.startsWith('Data source:'))).toBe(true), { timeout: 10000 });
  expect(fetch).toHaveBeenCalled();
  expect(readFileSync(r.configPath, 'utf8')).toBe(configBytes);
  const source = new RealtimeSource({
    apiKey: 'p5-fake-api-key', applicationKey: 'p5-fake-application-key', log: log as never,
    catalogAdopted: Number(r.readBlock().catalogAdopted),
    onUpdates: updates => (platform as unknown as { distribute(updates: unknown[]): void }).distribute(updates),
  });
  const live: Live = { api, platform, source, stopped: false,
    push: values => (source as unknown as { handleDevicePayload(payload: Json): void })
      .handleDevicePayload({ macAddress: MAC, ...values }),
    poll: async values => {
      polledValues = values;
      const calls = fetch.mock.calls.length;
      await (platform as unknown as { pollAndDistribute(): Promise<void> }).pollAndDistribute();
      expect(fetch.mock.calls.length).toBe(calls + 1);
    },
  };
  LIVES.push(live);
  return live;
}

async function stop(live: Live): Promise<void> {
  if (live.stopped) return;
  live.stopped = true;
  live.source.stop();
  live.api.emit('shutdown');
  // Join the real discovery write queue before cleanup or the next writer.
  await (live.platform as unknown as { v2Tracker?: { flush(force: boolean): Promise<void> } }).v2Tracker?.flush(true);
}

afterEach(async () => {
  for (const live of LIVES.splice(0)) await stop(live);
  vi.restoreAllMocks();
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

function reading(accessory: HapLifecyclePlatformAccessory, cell: MatrixCell): unknown {
  const service = accessory.getService(cell.native ? hap.Service.TemperatureSensor : hap.Service.MotionSensor) as hap.Service;
  expect(service).toBeDefined();
  return cell.native ? service.getCharacteristic(hap.Characteristic.CurrentTemperature).value
    : service.characteristics.find(c => c.UUID === VALUE_CHARACTERISTIC_UUID)?.value;
}

function motion(accessory: HapLifecyclePlatformAccessory): unknown {
  return (accessory.getService(hap.Service.MotionSensor) as hap.Service).getCharacteristic(hap.Characteristic.MotionDetected).value;
}

function retained(live: Live, prior: HapLifecyclePlatformAccessory, signature: unknown): void {
  expect(live.api.registered).toEqual([]);
  expect(live.api.unregistered).toEqual([]);
  expect(live.platform.accessories).toHaveLength(1);
  expect(live.platform.accessories[0]).toBe(prior);
  expect((prior.context.device as Json).structuralSignature).toBe(signature);
}

describe('P5 documented/undocumented × native/extended complete matrix', () => {
  it.each(MATRIX)('$label: save → REST → realtime → cached restart → second editor save/reload', async cell => {
    // Native defaults begin disabled so the initial preview must expose an addition,
    // not rely on a default that was already configured before this user action.
    const r = rig(cell.dataPoint, cell.dataPoint === 'tempf' ? [{ dataPoint: 'tempf', enabled: false }] : []);
    const firstSave = await editorSave(r, (store, state) => {
      expect(state.rows.find(row => row.stationMac === MAC && row.dataPoint === cell.dataPoint)?.kind)
        .toBe(cell.scope === 'known' ? cell.kind : 'unrecognized');
      for (const [field, value] of Object.entries(cell.fields)) store.setFieldFor(MAC, cell.dataPoint, field as DraftableField, value);
    });
    expect(firstSave.preview.changes.filter(c => c.dataPoint === cell.dataPoint)).toMatchObject([{ change: 'added', structural: true }]);
    const firstRow = firstSave.state.rows.find(row => row.stationMac === MAC && row.dataPoint === cell.dataPoint)!;
    expect(firstRow).toMatchObject({ kind: cell.kind, measurement: cell.measurement, sourceUnit: cell.sourceUnit,
      identityScope: cell.scope, enabled: true });

    const first = await boot(r, { [cell.dataPoint]: cell.firstRaw });
    expect(first.api.registered).toHaveLength(1);
    expect(first.api.unregistered).toEqual([]);
    const accessory = first.api.registered[0];
    const originalUuid = accessory.UUID;
    const signature = (accessory.context.device as Json).structuralSignature;
    expect(signature).toBeTypeOf('string');
    expect((accessory.context.device as Json).uniqueId).toBe(`${MAC}-${cell.dataPoint}`);
    expect(reading(accessory, cell)).toBe(cell.firstValue);
    if (!cell.native) expect(motion(accessory)).toBe(false);
    if (cell.measurement === 'numeric') {
      const svc = accessory.getService(hap.Service.MotionSensor) as hap.Service;
      expect(svc.characteristics.some(c => c.UUID === INTENSITY_CHARACTERISTIC_UUID)).toBe(false);
    }

    first.push({ [cell.dataPoint]: cell.realtimeRaw });
    expect(reading(accessory, cell)).toBe(cell.realtimeValue);
    if (!cell.native) expect(motion(accessory)).toBe(true); // AT the threshold, inclusive.
    if (cell.measurement === 'numeric') {
      first.push({ [cell.dataPoint]: String(cell.realtimeRaw) });
      expect(reading(accessory, cell)).toBe(cell.realtimeValue);
      expect(motion(accessory)).toBe(true); // Numeric text is not coerced or treated as zero.
    }
    // Exercise the live REST fanout, not only constructor seeding. Distinct
    // values and a cleared level condition make a dropped poll observable.
    await first.poll({ [cell.dataPoint]: cell.restartRaw });
    expect(reading(accessory, cell)).toBe(cell.restartValue);
    if (!cell.native) expect(motion(accessory)).toBe(false);
    await stop(first);

    const second = await boot(r, { [cell.dataPoint]: cell.restartRaw }, [accessory]);
    retained(second, accessory, signature);
    expect(accessory.UUID).toBe(originalUuid);
    expect(reading(accessory, cell)).toBe(cell.restartValue);
    if (!cell.native) expect(motion(accessory)).toBe(false);
    await stop(second);

    const name = `${String(cell.fields.name)} revised`;
    const secondSave = await editorSave(r, (store, state) => {
      const row = state.rows.find(row => row.stationMac === MAC && row.dataPoint === cell.dataPoint)!;
      store.setField(row, 'name', name);
      if (cell.measurement === 'numeric') store.setField(row, 'unitLabel', 'units');
    }, [accessory]);
    expect(secondSave.preview.structuralChangeCount).toBe(0);
    expect(secondSave.preview.changes.filter(c => c.dataPoint === cell.dataPoint)).toMatchObject([{ change: 'modified', structural: false }]);
    expect(secondSave.state.rows.find(row => row.stationMac === MAC && row.dataPoint === cell.dataPoint)).toMatchObject({
      name, kind: cell.kind, measurement: cell.measurement, sourceUnit: cell.sourceUnit, identityScope: cell.scope,
    });
    const third = await boot(r, { [cell.dataPoint]: cell.afterSaveRaw }, [accessory]);
    retained(third, accessory, signature);
    expect(accessory.UUID).toBe(originalUuid);
    expect(accessory.displayName).toContain(name);
    expect(reading(accessory, cell)).toBe(cell.afterSaveValue);
    if (!cell.native) expect(motion(accessory)).toBe(true);
  });

  it('an explicit Contact keeps open/closed/fault semantics through the same pipeline and cached restart', async () => {
    const dataPoint = 'p5_door';
    const r = rig(dataPoint);
    await editorSave(r, store => {
      for (const [field, value] of Object.entries({ kind: 'contact', measurement: 'boolean', enabled: true, name: 'P5 Door' })) {
        store.setFieldFor(MAC, dataPoint, field as DraftableField, value);
      }
    });
    const first = await boot(r, { [dataPoint]: 1 });
    expect(first.api.registered).toHaveLength(1);
    const accessory = first.api.registered[0];
    const service = accessory.getService(hap.Service.ContactSensor) as hap.Service;
    const value = () => service.getCharacteristic(hap.Characteristic.ContactSensorState).value;
    const fault = () => service.getCharacteristic(hap.Characteristic.StatusFault).value;
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(fault()).toBe(hap.Characteristic.StatusFault.NO_FAULT);
    first.push({ [dataPoint]: false });
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    first.push({ [dataPoint]: 'open' });
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    expect(fault()).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    first.push({});
    expect(fault()).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    await first.poll({ [dataPoint]: true });
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(fault()).toBe(hap.Characteristic.StatusFault.NO_FAULT);
    await first.poll({ [dataPoint]: 2 });
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    expect(fault()).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    const signature = (accessory.context.device as Json).structuralSignature;
    await stop(first);

    const second = await boot(r, { [dataPoint]: 2 }, [accessory]);
    retained(second, accessory, signature);
    expect(accessory.getService(hap.Service.ContactSensor)).toBe(service);
    expect(fault()).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    second.push({ [dataPoint]: true });
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(fault()).toBe(hap.Characteristic.StatusFault.NO_FAULT);
    await stop(second);

    const saved = await editorSave(r, (store, state) => {
      store.setField(state.rows.find(row => row.dataPoint === dataPoint)!, 'name', 'P5 Door revised');
    }, [accessory]);
    expect(saved.preview.structuralChangeCount).toBe(0);
    const third = await boot(r, { [dataPoint]: 0 }, [accessory]);
    retained(third, accessory, signature);
    expect(accessory.getService(hap.Service.ContactSensor)).toBe(service);
    expect(value()).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    expect(fault()).toBe(hap.Characteristic.StatusFault.NO_FAULT);
  });
});

describe('P5 catalog evolution around a live explicit assignment', () => {
  it.each([
    { label: 'mps assignment versus the later mph definition', kind: 'motion', measurement: 'wind-speed',
      sourceUnit: 'mps', native: false, expected: '22 mph', updated: '29 mph' },
    { label: 'conflicting native kind versus the later motion definition', kind: 'temperature', measurement: 'temperature',
      sourceUnit: 'celsius', native: true, expected: 10, updated: 13 },
  ])('$label survives confirmed adoption, cached restart and a second save', async identity => {
    const dataPoint = 'windspdmph_avg10m';
    // Isolate identity adoption from the independent catalog-3 lightning
    // battery-policy change, whose preview uses configured row ownership.
    const r = rig(dataPoint, [{ dataPoint: 'lightning_day', enabled: false }], 1);
    const initial = await editorSave(r, store => {
      for (const [field, value] of Object.entries({
        kind: identity.kind, measurement: identity.measurement, sourceUnit: identity.sourceUnit,
        name: 'P5 explicit Wind Speed Average', enabled: true,
      })) store.setFieldFor(MAC, dataPoint, field as DraftableField, value);
    });
    const rowIdentity = { kind: identity.kind, measurement: identity.measurement,
      sourceUnit: identity.sourceUnit, identityScope: 'custom-station', enabled: true };
    expect(initial.state.rows.find(row => row.dataPoint === dataPoint)).toMatchObject(rowIdentity);
    expect(r.readBlock()).toMatchObject({ catalogBaseline: 1, catalogAdopted: 1 });
    const authoredBefore = structuredClone(r.readBlock().sensorMap);
    const first = await boot(r, { [dataPoint]: 10 });
    expect(first.api.registered).toHaveLength(1);
    expect(first.api.unregistered).toEqual([]);
    const accessory = first.api.registered[0];
    const uuid = accessory.UUID;
    const signature = (accessory.context.device as Json).structuralSignature;
    const cell = { ...MATRIX[0], native: identity.native };
    expect(reading(accessory, cell)).toBe(identity.expected);
    await stop(first);

    // The actual preview, tokenized compose/commit and HB persistence path
    // advances visibility. It must not take authority from an authored row.
    const adopted = await editorSave(r, () => {}, [accessory], { adoptCatalogVersion: 4 });
    expect(adopted.preview.changes).toEqual([]);
    expect(adopted.preview.batteryPolarity).toEqual([]);
    expect(r.readBlock()).toMatchObject({ catalogBaseline: 1, catalogAdopted: 4 });
    expect(r.readBlock().sensorMap).toEqual(authoredBefore);
    expect(adopted.state.rows.find(row => row.dataPoint === dataPoint)).toMatchObject(rowIdentity);

    const second = await boot(r, { [dataPoint]: 10 }, [accessory]);
    retained(second, accessory, signature);
    expect(accessory.UUID).toBe(uuid);
    expect(reading(accessory, cell)).toBe(identity.expected);
    await second.poll({ [dataPoint]: 13 });
    expect(reading(accessory, cell)).toBe(identity.updated);
    await stop(second);

    const persistedBytes = readFileSync(r.configPath, 'utf8');
    const savedAgain = await editorSave(r, () => {}, [accessory]);
    expect(savedAgain.preview.changes).toEqual([]);
    expect(readFileSync(r.configPath, 'utf8')).toBe(persistedBytes);
    expect(savedAgain.state.rows.find(row => row.dataPoint === dataPoint)).toMatchObject(rowIdentity);
    const third = await boot(r, { [dataPoint]: 10 }, [accessory]);
    retained(third, accessory, signature);
    expect(accessory.UUID).toBe(uuid);
    expect(reading(accessory, cell)).toBe(identity.expected);
  });
});

describe('P5 fresh birth and credential failure as joined runtime journeys', () => {
  it('creates a conservative birth block, explicitly converts and enables, then restores the real cache', async () => {
    const r = rig('tempf');
    // A first install has neither a platform block nor any discovery history.
    writeFileSync(r.configPath, JSON.stringify({ platforms: [] }, null, 2));
    rmSync(path.join(r.root, 'plugin-data'), { recursive: true, force: true });
    const fresh = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: [] });
    expect(fresh).toMatchObject({ freshInstall: true, rows: [] });
    expect(existsSync(r.deps.persistDir)).toBe(false);
    await editorSave(r, () => {}, [], { settings: {
      name: 'P5 new installation', dataSource: 'polling',
      apiKey: { set: 'p5-first-key' }, applicationKey: { set: 'p5-first-application' },
    } });
    expect(r.readBlock()).toMatchObject({ catalogBaseline: 4, catalogAdopted: 4 });
    for (const key of ['configVersion', 'sensorMap', '_legacyMirror', 'temperatureSensors']) {
      expect(r.readBlock()[key]).toBeUndefined();
    }
    expect(existsSync(r.deps.persistDir)).toBe(false);
    const payload = { tempf: 68, soilhum1: 25, leak1: 1, p5_fresh_arbitrary: 8 };
    const first = await boot(r, payload);
    expect(first.api.registered).toEqual([]);
    expect(first.api.unregistered).toEqual([]);
    expect(first.platform.accessories).toEqual([]);
    await stop(first);
    const before = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: [] });
    for (const dp of ['tempf', 'soilhum1', 'leak1']) {
      expect(before.rows.find(row => row.dataPoint === dp), dp).toMatchObject({ enabled: false });
    }
    expect(before.rows.find(row => row.dataPoint === 'p5_fresh_arbitrary')).toMatchObject({ kind: 'unrecognized' });

    const converted = await editorSave(r, () => {}, [], { omitProposal: true });
    expect(converted.preview.changes).toEqual([]);
    expect(r.readBlock()).toMatchObject({ configVersion: 2, catalogBaseline: 4, catalogAdopted: 4 });
    // The birth skeleton has no authored legacy sensor fields to snapshot.
    expect(existsSync(path.join(r.deps.persistDir, 'legacy-config-snapshot.json'))).toBe(false);
    const second = await boot(r, payload);
    expect(second.api.registered).toEqual([]);
    expect(second.api.unregistered).toEqual([]);
    await stop(second);

    const enabled = await editorSave(r, (store, state) => {
      store.setField(state.rows.find(row => row.dataPoint === 'tempf')!, 'enabled', true);
    });
    expect(enabled.preview.changes).toMatchObject([{ dataPoint: 'tempf', change: 'added', structural: true }]);
    const third = await boot(r, payload);
    expect(third.api.registered).toHaveLength(1);
    expect(third.api.unregistered).toEqual([]);
    const accessory = third.api.registered[0];
    expect((accessory.context.device as Json).uniqueId).toBe(`${MAC}-tempf`);
    expect(reading(accessory, MATRIX[0])).toBe(20);
    const signature = (accessory.context.device as Json).structuralSignature;
    await stop(third);
    const fourth = await boot(r, { ...payload, tempf: 86 }, [accessory]);
    retained(fourth, accessory, signature);
    expect(reading(accessory, MATRIX[0])).toBe(30);
  });

  it('a real 401 startup preserves the entire cache and disk while credentials can be repaired without conversion', async () => {
    const r = rig('tempf');
    const first = await boot(r, { tempf: 68 });
    expect(first.api.registered).toHaveLength(1);
    const accessory = first.api.registered[0];
    const signature = (accessory.context.device as Json).structuralSignature;
    await stop(first);
    const graph = serializeRegistered(first.api);
    const bytes = readFileSync(r.configPath, 'utf8');
    const records = () => readdirSync(r.deps.persistDir).sort()
      .map(file => [file, readFileSync(path.join(r.deps.persistDir, file), 'utf8')]);
    const beforeRecords = records();
    const api = new HapMockAPI();
    api.user.storagePath = () => r.root;
    Object.assign(api.user, { configPath: () => r.configPath });
    const logger = new MockLogger();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }));
    fetch.mockClear();
    const platform = new AmbientWeatherSensorsPlatform(logger as never, r.readBlock() as never, api as never);
    platform.configureAccessory(accessory as never);
    // Stop the real retry at its scheduling boundary. Rejecting this test-only
    // sleep is caught by discoverDevicesV2, so no timer or orphan async task lives.
    const sleep = vi.spyOn(platform, 'sleep').mockRejectedValue(new Error('P5 bounded retry stop'));
    const discovery = vi.spyOn(platform as unknown as { discoverDevicesV2(): Promise<void> }, 'discoverDevicesV2');
    api.emit('didFinishLaunching');
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(60000));
    await discovery.mock.results[0].value;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(api.registered).toEqual([]);
    expect(api.unregistered).toEqual([]);
    expect(api.updated).toEqual([]);
    expect(platform.accessories).toEqual([accessory]);
    expect(serializeRegistered(first.api)).toEqual(graph);
    expect(readFileSync(r.configPath, 'utf8')).toBe(bytes);
    expect(records()).toEqual(beforeRecords);
    for (const secret of ['p5-fake-api-key', 'p5-fake-application-key']) {
      expect(logger.logs.map(entry => entry.message).join('\n')).not.toContain(secret);
    }
    api.emit('shutdown');
    api.removeAllListeners();
    fetch.mockRestore();
    sleep.mockRestore();
    discovery.mockRestore();

    const repaired = await editorSave(r, () => {}, [accessory], { settings: { apiKey: { set: 'p5-repaired-key' } } });
    expect(repaired.preview.changes).toEqual([]);
    expect(r.readBlock().apiKey).toBe('p5-repaired-key');
    expect(r.readBlock().sensorMap).toEqual([]);
    const recovered = await boot(r, { tempf: 86 }, [accessory]);
    retained(recovered, accessory, signature);
    expect(reading(accessory, MATRIX[0])).toBe(30);
    const calledUrl = String(vi.mocked(globalThis.fetch).mock.calls.at(-1)![0]);
    expect(calledUrl).toContain('apiKey=p5-repaired-key');
  });
});

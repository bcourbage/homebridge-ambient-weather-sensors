/** Editor proposal -> guarded persistence -> real cached HAP lifecycle. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import hap from '@homebridge/hap-nodejs';
import { AmbientWeatherSensorsPlatform } from '../../dist/platform.js';
import { VALUE_CHARACTERISTIC_UUID } from '../../dist/extendedSensors/customCharacteristics.js';
import { handleCommitSave, handleComposeSave, handleGetEditorState, handleGetVocabulary, handlePreviewSave } from '../../homebridge-ui/handlers.js';
import type { HandlerDeps } from '../../homebridge-ui/handlers';
import { composeAndPersist } from '../../homebridge-ui/saveOrchestrator.js';
import { interpretationProposal, type InterpretationChoice } from '../../homebridge-ui/app-src/interpretation-proposal';
import { DraftStore } from '../../homebridge-ui/app-src/draft-store';
import { HapMockAPI, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';

type Json = Record<string, unknown>;
const MAC = 'AA:BB:CC:DD:EE:01';
const POINT = 'custom_x';
const roots: string[] = [];
const lives: Array<{ api: HapMockAPI; platform: AmbientWeatherSensorsPlatform }> = [];
const WIND = { dataPoint: POINT, stationMac: MAC, kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', displayUnit: 'mph', threshold: 5, name: 'Wind probe' };
const CHOICE: InterpretationChoice = { pair: 'motion|wind-speed', sourceUnit: 'mps', displayUnit: 'mph', unitLabel: '', threshold: null, triggerDirection: 'above' };
const vocab = handleGetVocabulary({ vocabularyProtocol: 2 });
function rig(map: Json[] = [WIND]) {
  const root = mkdtempSync(path.join(tmpdir(), 'interpretation-hap-')); roots.push(root);
  const configPath = path.join(root, 'config.json'); const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ platforms: [{ platform: 'AmbientWeatherSensors', name: 'Proof', apiKey: 'fake', applicationKey: 'fake-app', dataSource: 'polling', configVersion: 2, catalogBaseline: 1, catalogAdopted: 4, sensorMap: map }] }));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: [{ stationMac: MAC, stationName: 'Station', dataPoint: POINT, firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' }] }));
  const deps: HandlerDeps = { configPath, persistDir, env: {}, version: 'test', log: { info() {}, warn() {}, debug() {} } };
  return { root, configPath, deps, read: (): Json => JSON.parse(readFileSync(configPath, 'utf8')).platforms[0] };
}
type Rig = ReturnType<typeof rig>;
async function proposal(r: Rig, choice: InterpretationChoice = CHOICE) {
  const state = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: [] });
  const row = state.rows.find(r => r.dataPoint === POINT && r.stationMac === MAC)!;
  const map = interpretationProposal(state.authored, row, choice, vocab, 4);
  expect(map).toBeDefined(); return map!;
}
async function save(r: Rig, map: Json[], cache: HapLifecyclePlatformAccessory[] = []) {
  const ids = cache.map(a => (a.context.device as Json).uniqueId);
  const state = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: ids });
  const args = { baseDigest: state.baseDigest, blockIndex: state.blockIndex, proposal: map };
  const bytes = readFileSync(r.configPath, 'utf8');
  const preview = await handlePreviewSave(r.deps, { ...args, cachedAccessoryUniqueIds: ids });
  expect(preview.ok, JSON.stringify(preview)).toBe(true); if (!preview.ok) throw new Error('preview');
  expect(readFileSync(r.configPath, 'utf8')).toBe(bytes);
  let session = [r.read()];
  const outcome = await composeAndPersist({
    freezeSettingsForm() {}, unfreezeSettingsForm() {}, getPluginConfig: async () => session, getCachedAccessories: async () => cache,
    request: async (endpoint, payload) => endpoint === '/compose-save' ? handleComposeSave(r.deps, payload) : handleCommitSave(r.deps, payload),
    updatePluginConfig: async blocks => { session = blocks; },
    savePluginConfig: async () => { writeFileSync(r.configPath, JSON.stringify({ platforms: session })); },
  }, { ...args, confirmDigest: preview.digest });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true); if (!outcome.ok) throw new Error('save');
  expect(r.read()).toEqual(outcome.nextConfig); return preview;
}
async function boot(r: Rig, value: number, cache: HapLifecyclePlatformAccessory[] = []) {
  const api = new HapMockAPI(); api.user.storagePath = () => r.root;
  (api.user as { configPath?: () => string }).configPath = () => r.configPath;
  const logger = new MockLogger();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify([{ macAddress: MAC, info: { name: 'Station' }, lastData: { [POINT]: value } }]), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const platform = new AmbientWeatherSensorsPlatform(logger as never, r.read() as never, api as never);
  cache.forEach(a => platform.configureAccessory(a as never)); api.emit('didFinishLaunching');
  await vi.waitFor(() => expect(logger.logs.some(l => l.message.startsWith('Data source:')), JSON.stringify(logger.logs)).toBe(true), { timeout: 3000 });
  const live = { api, platform }; lives.push(live); return live;
}
async function stop(live: typeof lives[number]) {
  live.api.emit('shutdown');
  await (live.platform as unknown as { v2Tracker?: { flush(force: boolean): Promise<void> } }).v2Tracker?.flush(true);
}
afterEach(async () => {
  for (const live of lives.splice(0)) await stop(live);
  vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
function wind(a: HapLifecyclePlatformAccessory) {
  const s = a.getService(hap.Service.MotionSensor) as hap.Service;
  return { value: s.characteristics.find(c => c.UUID === VALUE_CHARACTERISTIC_UUID)?.value, motion: s.getCharacteristic(hap.Characteristic.MotionDetected).value };
}

describe('Change interpretation cached runtime journeys', () => {
  it('changes mph to mps in place, renders the changed value, then recovers a disabled trigger explicitly', async () => {
    const r = rig(); const first = await boot(r, 10); const accessory = first.api.registered[0];
    expect(wind(accessory)).toEqual({ value: '10 mph', motion: true }); await stop(first);
    const p = await save(r, await proposal(r), [accessory]);
    expect(p.changes.find(c => c.dataPoint === POINT)).toMatchObject({ structural: false, after: { sourceUnit: 'mps', triggerEnabled: false } });
    const second = await boot(r, 10, [accessory]);
    expect(second.api.registered).toEqual([]); expect(second.api.unregistered).toEqual([]);
    expect(second.platform.accessories[0]).toBe(accessory); expect(wind(accessory)).toEqual({ value: '22 mph', motion: false });
    await stop(second);
    const state = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: [`${MAC}-${POINT}`] });
    const row = state.rows.find(x => x.dataPoint === POINT)!;
    const store = new DraftStore(); store.reset(state.authored);
    store.setField(row, 'triggerEnabled', true); store.setField(row, 'threshold', 10); store.setField(row, 'triggerDirection', 'above');
    await save(r, store.proposal(), [accessory]); const third = await boot(r, 10, [accessory]);
    expect(third.api.registered).toEqual([]); expect(third.api.unregistered).toEqual([]);
    expect(wind(accessory)).toEqual({ value: '22 mph', motion: true });
    const bytes = JSON.stringify(r.read().sensorMap); await save(r, r.read().sensorMap as Json[], [accessory]);
    expect(JSON.stringify(r.read().sensorMap)).toBe(bytes);
  });

  it('replaces Contact with exactly one Leak service through cached reconciliation', async () => {
    const r = rig([{ dataPoint: POINT, stationMac: MAC, kind: 'contact', measurement: 'boolean', name: 'Door' }]);
    const first = await boot(r, 1); const old = first.api.registered[0];
    expect(old.getService(hap.Service.ContactSensor)).toBeDefined(); await stop(first);
    const p = await save(r, await proposal(r, { ...CHOICE, pair: 'leak|boolean', sourceUnit: '', displayUnit: '' }), [old]);
    expect(p.changes.find(c => c.dataPoint === POINT)).toMatchObject({ structural: true, before: { kind: 'contact' }, after: { kind: 'leak' } });
    const second = await boot(r, 1, [old]); expect(second.api.unregistered).toEqual([old]); expect(second.api.registered).toHaveLength(1);
    const next = second.api.registered[0]; expect(next.getService(hap.Service.ContactSensor)).toBeUndefined();
    expect((next.getService(hap.Service.LeakSensor) as hap.Service).getCharacteristic(hap.Characteristic.LeakDetected).value).toBe(hap.Characteristic.LeakDetected.LEAK_DETECTED);
  });

  it('sanitizes duplicate target fields without rewriting other keys or losing independent authorship', async () => {
    const other = { dataPoint: 'other', stationMac: MAC, kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent', name: 'Untouched' };
    const r = rig([{ ...WIND, batteryField: 'battout', embedName: true }, { ...WIND, name: 'Final name', enabled: false, threshold: 50 }, other]);
    const next = await proposal(r, { ...CHOICE, pair: 'humidity|humidity', sourceUnit: 'percent', displayUnit: '' });
    expect(next.find(x => x.dataPoint === 'other')).toEqual(other);
    const target = next.filter(x => x.dataPoint === POINT);
    for (const f of target) for (const k of ['threshold', 'triggerEnabled', 'triggerDirection', 'unitLabel', 'displayUnit', 'embedName']) expect(f).not.toHaveProperty(k);
    expect(Object.assign({}, ...target)).toMatchObject({ kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent', name: 'Final name', enabled: false, batteryField: 'battout' });
    await save(r, next); expect(r.read().sensorMap).toEqual(expect.arrayContaining([expect.objectContaining({ dataPoint: POINT, enabled: false, name: 'Final name' })]));
  });

  it.each(vocab.assignments)('can construct, preview, persist and reload the advertised $id pair', async pair => {
    const r = rig(); const units = vocab.measurements[pair.measurement];
    const next = await proposal(r, { ...CHOICE, pair: pair.id, sourceUnit: pair.source.type === 'selectable' ? units.customSource[0].unit : '', displayUnit: units.extendedDisplay[0]?.unit ?? '', unitLabel: pair.measurement === 'numeric' ? 'µg/m³' : '' });
    await save(r, next);
    const state = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: [] });
    expect(state.rows.find(x => x.dataPoint === POINT)).toMatchObject({ kind: pair.kind, measurement: pair.measurement, identityScope: 'custom-station' });
    const canonical = r.read().sensorMap; await save(r, canonical as Json[]); expect(r.read().sensorMap).toEqual(canonical);
  });

  it.each([
    { kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent' },
    { kind: 'contact', measurement: 'boolean' },
  ])('remaps a station beneath a $kind template with triggering OFF through save and real HAP restart', async identity => {
    const r = rig([{ dataPoint: POINT, ...identity }, { dataPoint: POINT, stationMac: MAC, ...identity, name: 'Station custom' }]);
    const first = await boot(r, 1); const old = first.api.registered[0]; await stop(first);
    const p = await save(r, await proposal(r, { ...CHOICE, sourceUnit: 'mph' }), [old]);
    expect(p.changes.find(c => c.dataPoint === POINT)).toMatchObject({ structural: true, after: { kind: 'motion', triggerEnabled: false } });
    const state = await handleGetEditorState(r.deps, { cachedAccessoryUniqueIds: [] });
    expect(state.rows.find(x => x.dataPoint === POINT)).toMatchObject({ identityScope: 'custom-station', kind: 'motion', triggerEnabled: false });
    const second = await boot(r, 10, [old]);
    expect(second.api.unregistered).toEqual([old]); expect(second.api.registered).toHaveLength(1);
    expect(wind(second.api.registered[0])).toEqual({ value: '10 mph', motion: false });
    const canonical = r.read().sensorMap; await save(r, canonical as Json[], second.api.registered); expect(r.read().sensorMap).toEqual(canonical);
  });
});

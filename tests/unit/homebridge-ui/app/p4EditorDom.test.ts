// @vitest-environment jsdom
import '@angular/compiler';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AwnRootComponent } from '../../../../homebridge-ui/app-src/awn-root.component';
import { DraftStore } from '../../../../homebridge-ui/app-src/draft-store';
import { HOMEBRIDGE_IPC, type HomebridgeIpc } from '../../../../homebridge-ui/app-src/homebridge.service';
import type { EditorStateDto, PreviewResultDto } from '../../../../homebridge-ui/app-src/dto/editor-state';
import { handleGetEditorState, handleGetVocabulary, handlePreviewSave, type HandlerDeps } from '../../../../homebridge-ui/handlers';
import { buildEffectiveSensorMap } from '../../../../src/sensorMap/buildEffectiveMap';
import { buildWrapperRouting, distributeViaRouting } from '../../../../src/sensorMap/routing';
import type { AmbientWeatherSensorsPlatform } from '../../../../src/platform';
import { makeHapPlatform, makeHapAccessory } from '../../../helpers/hapGraph.mjs';

const MAC = 'AA:BB:CC:DD:EE:01';
const OTHER = 'AA:BB:CC:DD:EE:02';
const roots: string[] = [];
const NUMERIC = { dataPoint: 'xflow', kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', name: 'Flow' };

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => {
  TestBed.resetTestingModule();
  window.localStorage?.clear();
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

interface Rig {
  fixture: ComponentFixture<AwnRootComponent>;
  el: HTMLElement;
  requests: Array<{ route: string; body: Record<string, unknown> }>;
  previews: Array<Promise<PreviewResultDto>>;
  deps: HandlerDeps;
  state: EditorStateDto;
}

async function rig(sensorMap: Record<string, unknown>[] = [], adopted = 4, twoStations = false): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'p4-editor-dom-'));
  roots.push(root);
  const persistDir = path.join(root, 'data');
  mkdirSync(persistDir);
  const block = {
    platform: 'AmbientWeatherSensors', name: 'Test', apiKey: 'test-key', applicationKey: 'test-app',
    _sensorMapV2: true, configVersion: 2, catalogBaseline: 1, catalogAdopted: adopted, sensorMap,
  };
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: [block] }));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1,
    entries: (twoStations ? [MAC, OTHER] : [MAC]).flatMap(stationMac => ['tempf', 'xflow', 'xother'].map(dataPoint => ({
      stationMac, stationName: stationMac === MAC ? 'Roof' : 'Barn', dataPoint,
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
    }))),
  }));
  const deps: HandlerDeps = { configPath, persistDir, version: 'test', env: {}, log: { info() {}, warn() {}, debug() {} } };
  const state = await handleGetEditorState(deps, { cachedAccessoryUniqueIds: [] });
  const requests: Rig['requests'] = [];
  const previews: Rig['previews'] = [];
  const ipc: HomebridgeIpc = {
    getPluginConfig: async () => [block],
    getCachedAccessories: async () => [],
    request: async (route, payload) => {
      const body = payload as Record<string, unknown>;
      requests.push({ route, body });
      if (route === '/editor-state') { return state; }
      if (route === '/vocabulary') { return handleGetVocabulary(payload); }
      if (route === '/notices') { return { schemaVersion: 1, notices: [] }; }
      if (route === '/preview-save') {
        const response = handlePreviewSave(deps, payload);
        previews.push(response);
        return response;
      }
      throw new Error(`Unexpected request ${route}`);
    },
  };
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: HOMEBRIDGE_IPC, useValue: ipc }] });
  const fixture = TestBed.createComponent(AwnRootComponent);
  fixture.detectChanges();
  await settle(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, requests, previews, deps, state };
}

async function settle(fixture: ComponentFixture<AwnRootComponent>): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await fixture.whenStable();
  fixture.detectChanges();
}

function click(r: Rig, text: string, container: ParentNode = r.el): void {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  expect(button, `button ${text}`).toBeDefined();
  expect(button!.disabled, `${text} is enabled`).toBe(false);
  button!.click();
  r.fixture.detectChanges();
}

function open(r: Rig, dataPoint = 'xflow', occurrence = 0): void {
  const row = [...r.el.querySelectorAll('tbody > tr')].filter(tr => tr.querySelector('code')?.textContent === dataPoint)[occurrence];
  expect(row, dataPoint).toBeDefined();
  const button = row.querySelector('button') as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  button.click();
  r.fixture.detectChanges();
}

function field<T extends HTMLInputElement | HTMLSelectElement>(r: Rig, name: string): T {
  const el = r.el.querySelector(`.editor-form [formcontrolname="${name}"]`) as T;
  expect(el, `field ${name}`).not.toBeNull();
  return el;
}

function set(r: Rig, name: string, value: string): void {
  const el = field<HTMLInputElement | HTMLSelectElement>(r, name);
  el.value = value;
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  r.fixture.detectChanges();
}

function inherit(r: Rig): void {
  (r.el.querySelector('.inherit-label') as HTMLButtonElement).click();
  r.fixture.detectChanges();
}

async function preview(r: Rig): Promise<Record<string, unknown>[]> {
  click(r, 'Preview changes');
  await settle(r.fixture);
  const request = r.requests.filter(q => q.route === '/preview-save').at(-1);
  expect(request).toBeDefined();
  const result = await r.previews.at(-1)!;
  await settle(r.fixture);
  expect(result.ok, JSON.stringify(result.ok ? {} : result.error)).toBe(true);
  return request!.body.proposal as Record<string, unknown>[];
}

function authored(proposal: Record<string, unknown>[], dp = 'xflow', mac: string | null = MAC): Record<string, unknown> | undefined {
  return proposal.find(f => f.dataPoint === dp && f.stationMac === (mac ?? undefined));
}

describe('P4 pair-aware assignment', () => {
  it('each boolean option authors its own complete kind and fixed encoding, with no numeric controls', async () => {
    const r = await rig();
    open(r);
    for (const kind of ['leak', 'contact', 'occupancy', 'smoke', 'motion']) {
      set(r, 'pair', `${kind}|boolean`);
      expect(r.el.querySelector('.editor-form [formcontrolname="sourceUnit"]')).toBeNull();
      expect(r.el.querySelector('.editor-form [formcontrolname="threshold"]')).toBeNull();
      expect(r.el.querySelector('.capability-help')!.textContent).toContain('0/false');
      if (kind === 'contact') { expect(r.el.querySelector('.capability-help')!.textContent).toContain('1/true = Open'); }
      const fragment = authored(await preview(r));
      expect(fragment).toMatchObject({ kind, measurement: 'boolean', enabled: true });
      expect(fragment).not.toHaveProperty('sourceUnit');
      expect(fragment).not.toHaveProperty('threshold');
      expect(fragment).not.toHaveProperty('unitLabel');
    }
  });

  it('numeric, physical, state, and timestamp switches remove every incompatible old field', async () => {
    const r = await rig();
    open(r);
    set(r, 'pair', 'motion|numeric');
    set(r, 'unitLabel', 'L/min');
    set(r, 'threshold', '12');
    expect(authored(await preview(r))).toMatchObject({ sourceUnit: 'raw', unitLabel: 'L/min', threshold: 12 });
    set(r, 'pair', 'motion|wind-speed');
    set(r, 'sourceUnit', 'mph');
    let fragment = authored(await preview(r));
    expect(fragment).toMatchObject({ sourceUnit: 'mph', measurement: 'wind-speed' });
    expect(fragment).not.toHaveProperty('unitLabel');
    expect(fragment).not.toHaveProperty('threshold');
    set(r, 'threshold', '10');
    set(r, 'sourceUnit', 'fps');
    expect(field<HTMLInputElement>(r, 'threshold').value).toBe('');
    expect(authored(await preview(r))).not.toHaveProperty('threshold');
    set(r, 'pair', 'contact|boolean');
    fragment = authored(await preview(r));
    expect(fragment).not.toHaveProperty('sourceUnit');
    expect(fragment).not.toHaveProperty('displayUnit');
    set(r, 'pair', 'motion|numeric');
    fragment = authored(await preview(r));
    expect(fragment).toMatchObject({ kind: 'motion', measurement: 'numeric', sourceUnit: 'raw' });
    expect(fragment).not.toHaveProperty('unitLabel');
    set(r, 'pair', 'motion|timestamp');
    expect(authored(await preview(r))).not.toHaveProperty('sourceUnit');
  });

  it('gated choices cannot create a draft even when their change event is forged', async () => {
    const r = await rig([], 3);
    open(r);
    const option = field<HTMLSelectElement>(r, 'pair').querySelector('option[value="motion|numeric"]') as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    set(r, 'pair', 'motion|numeric');
    expect(r.el.querySelector('.field-error')?.textContent).toContain('sensor-support update');
    expect(r.requests.filter(q => q.route === '/preview-save')).toHaveLength(0);
    expect([...r.el.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Preview changes' && !b.disabled)).toBe(false);
  });

  it('a rejected saved identity cannot be remapped through the new-assignment affordance', async () => {
    const r = await rig([{ dataPoint: 'xflow', stationMac: MAC, kind: 'motion', measurement: 'numeric' }]);
    const row = [...r.el.querySelectorAll('tbody > tr')].find(tr => tr.querySelector('code')?.textContent === 'xflow')!;
    const button = row.querySelector('button') as HTMLButtonElement;
    expect(button === null || button.disabled).toBe(true);
    expect(r.state.authored[0].fields).toMatchObject({ kind: 'motion', measurement: 'numeric' });
  });
});

describe('P4 numeric label authorship', () => {
  it('rename preserves absent station label, identity provenance, and triggerEnabled false', async () => {
    const r = await rig([{ ...NUMERIC, unitLabel: 'L/min' }, { ...NUMERIC, stationMac: MAC, name: 'Station Flow', threshold: 5, triggerEnabled: false }]);
    open(r);
    expect(field<HTMLInputElement>(r, 'unitLabel').value).toBe('');
    set(r, 'name', 'Renamed');
    const proposal = await preview(r);
    expect(authored(proposal)).toMatchObject({ kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', name: 'Renamed', triggerEnabled: false });
    expect(authored(proposal)).not.toHaveProperty('unitLabel');
    expect(authored(proposal, 'xflow', null)!.unitLabel).toBe('L/min');
  });

  it('inherit removes a pending-only label and keeps unrelated drafts, across close and reopen', async () => {
    const r = await rig([{ ...NUMERIC, stationMac: MAC }]);
    open(r);
    set(r, 'name', 'Renamed');
    set(r, 'unitLabel', 'ppm');
    inherit(r);
    click(r, 'OK', r.el.querySelector('.editor-footer')!);
    open(r);
    expect(field<HTMLInputElement>(r, 'unitLabel').value).toBe('');
    set(r, 'threshold', '7');
    const fragment = authored(await preview(r));
    expect(fragment).toMatchObject({ name: 'Renamed', threshold: 7 });
    expect(fragment).not.toHaveProperty('unitLabel');
  });

  it('clear, inherit, and explicit retype remain distinct under unrelated form events', async () => {
    const r = await rig([{ ...NUMERIC, unitLabel: 'L/min' }, { ...NUMERIC, stationMac: MAC, unitLabel: 'gpm' }]);
    open(r);
    click(r, 'Use no label');
    set(r, 'name', 'Renamed');
    expect(authored(await preview(r))!.unitLabel).toBe('');
    inherit(r);
    set(r, 'threshold', '7');
    expect(authored(await preview(r))).not.toHaveProperty('unitLabel');
    set(r, 'unitLabel', 'gpm');
    expect(authored(await preview(r))!.unitLabel).toBe('gpm');
    set(r, 'unitLabel', 'L/min');
    expect(authored(await preview(r))!.unitLabel).toBe('L/min');
  });

  it('Cancel after OK discards that key, retaining another key and saved authored label', async () => {
    const r = await rig([{ ...NUMERIC, stationMac: MAC, unitLabel: 'L/min' }, { ...NUMERIC, dataPoint: 'xother', stationMac: MAC }]);
    open(r, 'xother'); set(r, 'name', 'Other draft'); click(r, 'OK', r.el.querySelector('.editor-footer')!);
    open(r); set(r, 'unitLabel', 'ppm'); click(r, 'OK', r.el.querySelector('.editor-footer')!);
    open(r); set(r, 'unitLabel', 'gpm'); click(r, 'Cancel', r.el.querySelector('.editor-footer')!);
    const proposal = await preview(r);
    expect(authored(proposal)!.unitLabel).toBe('L/min');
    expect(authored(proposal, 'xother')!.name).toBe('Other draft');
  });

  it('literal labels remain text, use code-point capacity, and suppress incomplete Skip pins', async () => {
    const r = await rig([{ ...NUMERIC, stationMac: MAC, unitLabel: 'L/min', enabled: false }]);
    const row = [...r.el.querySelectorAll('tbody > tr')].find(tr => tr.querySelector('code')?.textContent === 'xflow')!;
    expect(row.textContent).toContain('L/min');
    expect(row.textContent).not.toContain('raw');
    open(r);
    expect(field<HTMLInputElement>(r, 'unitLabel').hasAttribute('maxlength')).toBe(false);
    const label = String.fromCodePoint(0x1F680).repeat(16);
    set(r, 'unitLabel', label);
    expect(r.el.querySelector('.editor-form')!.textContent).toContain('16/16 Unicode code points');
    set(r, 'name', 'Renamed');
    expect(authored(await preview(r))!.unitLabel).toBe(label);
    expect(r.el.textContent).toContain('unit label "L/min"');
    expect([...r.el.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Skip')).toBe(false);
  });

  it('a global numeric label edit does not pollute a station with a different explicit identity', async () => {
    const r = await rig([{ ...NUMERIC, unitLabel: 'L/min' }, {
      dataPoint: 'xflow', stationMac: OTHER, kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Wind',
    }], 4, true);
    open(r);
    set(r, 'unitLabel', 'gpm');
    const proposal = await preview(r);
    expect(authored(proposal, 'xflow', null)!.unitLabel).toBe('gpm');
    expect(authored(proposal, 'xflow', OTHER)).not.toHaveProperty('unitLabel');
    const request = r.requests.filter(q => q.route === '/preview-save').at(-1)!;
    const result = await handlePreviewSave(r.deps, request.body);
    if (!result.ok) { throw new Error(result.error.message); }
    const wind = result.rows.find(row => row.stationMac === OTHER && row.dataPoint === 'xflow');
    expect(wind).toMatchObject({ measurement: 'wind-speed', sourceUnit: 'mph' });
    expect(wind).not.toHaveProperty('unitLabel');
  });

  it('inherit cancels a minimal-replacement label without restoring the removed fields', async () => {
    const r = await rig([{ ...NUMERIC, stationMac: MAC, unitLabel: 'L/min' }]);
    const row = r.state.rows.find(item => item.dataPoint === 'xflow')!;
    const store = new DraftStore();
    store.reset(r.state.authored);
    store.removeOverride(row);
    store.setField(row, 'unitLabel', 'ppm');
    store.setField(row, 'name', 'Replacement');
    store.inheritField(row, 'unitLabel');
    expect(store.proposal()).toEqual([{ dataPoint: 'xflow', stationMac: MAC, name: 'Replacement' }]);
    expect(store.fieldIntent(row, 'unitLabel')).toEqual({ present: false });
  });

  it('Use defaults deletes a custom identity without permitting an identity-less label re-edit', async () => {
    const r = await rig([{ ...NUMERIC, stationMac: MAC, unitLabel: 'L/min' }]);
    open(r);
    click(r, 'Use defaults', r.el.querySelector('.editor-footer')!);
    expect(r.el.querySelector('.editor-form')).toBeNull();
    const row = [...r.el.querySelectorAll('tbody > tr')].find(tr => tr.querySelector('code')?.textContent === 'xflow')!;
    expect((row.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(authored(await preview(r))).toBeUndefined();
  });

  it('equal-value label inheritance remains visible in preview after the row is closed', async () => {
    const r = await rig([{ ...NUMERIC, unitLabel: 'L/min' }, { ...NUMERIC, stationMac: MAC, unitLabel: 'L/min' }]);
    open(r);
    expect(r.el.querySelector('.inherit-label')!.textContent?.trim()).toBe('Use inherited label');
    inherit(r);
    click(r, 'OK', r.el.querySelector('.editor-footer')!);
    expect(r.el.querySelector('.editor-form')).toBeNull();
    const proposal = await preview(r);
    expect(authored(proposal)).not.toHaveProperty('unitLabel');
    const result = await r.previews.at(-1)!;
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    expect(result.changes).toEqual([]);
    expect(result.configOnly).toEqual([]);
    expect(r.el.querySelector('.label-intent-preview')!.textContent).toContain('authorship or inheritance');
    expect(r.el.textContent).not.toContain('saving would change nothing');
  });

  it.each([
    ['too many code points', String.fromCodePoint(0x1F680).repeat(17)],
    ['Arabic letter mark', `x${String.fromCodePoint(0x061C)}y`],
    ['NUL', String.fromCodePoint(0)],
    ['line separator', `x${String.fromCodePoint(0x2028)}y`],
  ])('refuses %s at the real preview boundary without truncation or writes', async (_description, label) => {
    const r = await rig([{ ...NUMERIC, stationMac: MAC, unitLabel: 'L/min' }]);
    const configBefore = readFileSync(r.deps.configPath!, 'utf8');
    const filesBefore = readdirSync(r.deps.persistDir);
    open(r);
    set(r, 'unitLabel', label);
    expect(field<HTMLInputElement>(r, 'unitLabel').value).toBe(label);
    click(r, 'Preview changes');
    await settle(r.fixture);
    const result = await r.previews.at(-1)!;
    await settle(r.fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.code).toBe('invalid-rows'); }
    const proposal = r.requests.filter(q => q.route === '/preview-save').at(-1)!.body.proposal as Record<string, unknown>[];
    expect(authored(proposal)!.unitLabel).toBe(label);
    expect(readFileSync(r.deps.configPath!, 'utf8')).toBe(configBefore);
    expect(readdirSync(r.deps.persistDir)).toEqual(filesBefore);
  });
});

describe('P4 state descriptions agree with real HAP consumers', () => {
  it.each([
    ['leak', 'LeakSensor', 'LeakDetected', 'No leak', 'Leak detected'],
    ['contact', 'ContactSensor', 'ContactSensorState', 'Closed', 'Open'],
    ['occupancy', 'OccupancySensor', 'OccupancyDetected', 'Unoccupied', 'Occupied'],
    ['smoke', 'SmokeSensor', 'SmokeDetected', 'No smoke detected', 'Smoke detected'],
    ['motion', 'MotionSensor', 'MotionDetected', 'No motion', 'Motion detected'],
  ] as const)('%s help describes the real decoder for valid, invalid, missing, and recovery readings', async (kind, serviceName, characteristicName, normal, active) => {
    const authoredRow = { dataPoint: 'xflow', stationMac: MAC, kind, measurement: 'boolean', name: 'State' };
    const r = await rig([authoredRow]);
    open(r);
    const help = r.el.querySelector('.capability-help')!.textContent!;
    expect(help).toContain(`0/false = ${normal}`);
    expect(help).toContain(`1/true = ${active}`);
    expect(help).toContain('indicate a fault and clear the alert');
    expect(help).toContain('Missing data retains the previous state and fault');
    const map = buildEffectiveSensorMap({
      stations: [{ macAddress: MAC, name: 'Roof' }], userOverrides: [authoredRow],
      discovery: { schemaVersion: 1, entries: [] },
      uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
      configMode: 'v2', catalogBaseline: 1, catalogAdopted: 4,
    });
    expect(map.errors).toEqual([]);
    const row = map.rows.find(candidate => candidate.dataPoint === 'xflow')!;
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory({ uniqueId: `${MAC}-xflow`, displayName: 'State' });
    const routing = buildWrapperRouting(platform as unknown as AmbientWeatherSensorsPlatform,
      { rows: [row], errors: [], warnings: [], notes: [] }, () => accessory as never);
    const service = accessory.getService(platform.Service[serviceName]);
    const characteristic = platform.Characteristic[characteristicName];
    const clear = kind === 'motion' ? false : 0;
    const triggered = kind === 'motion' ? true : 1;
    const push = (value: unknown, present = true): void => distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform, routing,
      [{ macAddress: MAC, lastData: present ? { xflow: value } : {} }]);
    const state = () => service.getCharacteristic(characteristic).value;
    const fault = () => service.getCharacteristic(platform.Characteristic.StatusFault).value;
    for (const value of [0, false]) { push(value); expect(state()).toBe(clear); expect(fault()).toBe(0); }
    for (const value of [1, true]) { push(value); expect(state()).toBe(triggered); expect(fault()).toBe(0); }
    push(undefined, false); expect(state()).toBe(triggered); expect(fault()).toBe(0);
    for (const value of ['1', 'open', null, {}, 2]) {
      push(value); expect(state()).toBe(clear); expect(fault()).toBe(1);
      push(undefined, false); expect(state()).toBe(clear); expect(fault()).toBe(1);
      push(1); expect(state()).toBe(triggered); expect(fault()).toBe(0);
    }
  });
});

// @vitest-environment jsdom
/** P4 workflow proofs: real component/service, built handlers, and temporary config files. */
import '@angular/compiler';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AwnRootComponent } from '../../../../homebridge-ui/app-src/awn-root.component';
import { HOMEBRIDGE_IPC, type HomebridgeIpc } from '../../../../homebridge-ui/app-src/homebridge.service';
import type { EditorStateDto, PreviewResultDto, VocabularyDto } from '../../../../homebridge-ui/app-src/dto/editor-state';
import {
  handleCommitSave, handleComposeSave, handleGetEditorState, handleGetVocabulary, handlePreviewSave,
} from '../../../../homebridge-ui/handlers.js';
import type { HandlerDeps } from '../../../../homebridge-ui/handlers';

const MAC = 'AA:BB:CC:DD:EE:01';
const BASE = { platform: 'AmbientWeatherSensors', name: 'Workflow station', _sensorMapV2: true };
const roots: string[] = [];
type Json = Record<string, unknown>;
interface WorkflowApi {
  previewCatalog(operation: 'convert' | 'adopt'): Promise<void>;
  preview(): Promise<void>;
  cancelPreview(): void;
  previewPending(): boolean;
  saving(): boolean;
  previewResult(): PreviewResultDto | null;
  canSavePreview(): boolean;
  reloadRequired(): boolean;
  loadError(): string | undefined;
  state(): EditorStateDto | undefined;
  cleanOperationError(operation: 'convert' | 'adopt'): string | null;
}
interface Rig {
  root: string;
  configPath: string;
  persistDir: string;
  deps: HandlerDeps;
  ipc: HomebridgeIpc;
  requests: Array<{ path: string; body: Json }>;
  events: string[];
  fixture: ComponentFixture<AwnRootComponent>;
  app: WorkflowApi;
  el: HTMLElement;
  readBlock(): Json;
  intercept?: (endpoint: string, body: Json) => Promise<unknown> | undefined;
  cache?: () => Promise<unknown[]>;
  failPersist?: boolean;
  driftAfterSave?: boolean;
  failReload?: boolean;
  failRestore?: boolean;
}

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => {
  TestBed.resetTestingModule();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

async function flush(r: Rig): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await r.fixture.whenStable();
  r.fixture.detectChanges();
}
async function microtasks(r: Rig): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  r.fixture.detectChanges();
}
function button(r: Rig, label: string): HTMLButtonElement | undefined {
  return [...r.el.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
}
function set(r: Rig, control: string, value: string): void {
  const input = r.el.querySelector(`[formcontrolname="${control}"]`) as HTMLInputElement | HTMLSelectElement;
  expect(input, control).not.toBeNull();
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  r.fixture.detectChanges();
}
function open(r: Rig, dataPoint: string): void {
  const row = [...r.el.querySelectorAll('tbody tr')].find(tr => tr.querySelector('td code')?.textContent === dataPoint);
  expect(row, dataPoint).toBeDefined();
  (row!.querySelector('button') as HTMLButtonElement).click();
  r.fixture.detectChanges();
}
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function emptyPreview(digest: string): PreviewResultDto {
  return { ok: true, canonicalSensorMap: [], rows: [], changes: [], configOnly: [], settingsChanged: [],
    batteryPolarity: [], structuralChangeCount: 0, digest, warnings: [], notes: [] };
}

async function rig(block: Json | null, fields = ['tempf', 'flow1', 'door1'], additionalBlocks: Json[] = []): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'p4-workflow-'));
  roots.push(root);
  const configPath = path.join(root, 'config.json');
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const blocks = [...(block ? [block] : []), ...additionalBlocks];
  writeFileSync(configPath, JSON.stringify({ platforms: blocks }));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: fields.map(dataPoint => ({
    stationMac: MAC, stationName: 'Workflow', dataPoint,
    firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
  })) }));
  const deps: HandlerDeps = { configPath, persistDir, version: 'test', env: {}, log: { info() {}, warn() {}, debug() {} } };
  let session: Json[] = JSON.parse(JSON.stringify(blocks));
  let saved = false;
  const r = { root, configPath, persistDir, deps, requests: [], events: [],
    readBlock: () => JSON.parse(readFileSync(configPath, 'utf8')).platforms[0] as Json } as unknown as Rig;
  r.ipc = {
    getPluginConfig: async () => session,
    getCachedAccessories: async () => r.cache ? r.cache() : [],
    disableSaveButton: () => {
      r.events.push('disable');
      if (r.failRestore && r.events.filter(e => e === 'disable').length > 1) throw new Error('restore failed');
    },
    updatePluginConfig: async incoming => {
      r.events.push('update');
      session = incoming.map((b, i) => Object.assign({}, session[i], b)) as Json[];
      if (r.failPersist) throw new Error('effect then lost response');
    },
    savePluginConfig: async () => {
      r.events.push('save');
      writeFileSync(configPath, JSON.stringify({ platforms: session }));
      saved = true;
      if (r.driftAfterSave) {
        const next = r.readBlock();
        next.name = 'External edit after persistence';
        writeFileSync(configPath, JSON.stringify({ platforms: [next] }));
      }
    },
    request: async (endpoint, raw) => {
      const body = (raw ?? {}) as Json;
      r.requests.push({ path: endpoint, body: JSON.parse(JSON.stringify(body)) as Json });
      const intercepted = r.intercept?.(endpoint, body);
      if (intercepted !== undefined) return intercepted;
      if (endpoint === '/editor-state') {
        if (saved && r.failReload) throw new Error('reload could not read configuration');
        return handleGetEditorState(deps, body);
      }
      if (endpoint === '/vocabulary') return handleGetVocabulary(body);
      if (endpoint === '/notices') return { notices: [] };
      if (endpoint === '/preview-save') return handlePreviewSave(deps, body);
      if (endpoint === '/compose-save') return handleComposeSave(deps, body);
      if (endpoint === '/commit-save') return handleCommitSave(deps, body);
      throw new Error(`Unexpected request ${endpoint}`);
    },
  };
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: HOMEBRIDGE_IPC, useValue: r.ipc }] });
  r.fixture = TestBed.createComponent(AwnRootComponent);
  r.app = r.fixture.componentInstance as unknown as WorkflowApi;
  r.el = r.fixture.nativeElement as HTMLElement;
  r.fixture.detectChanges();
  await expect.poll(() => r.app.state() ?? r.app.loadError()).not.toBeUndefined();
  expect(r.app.loadError()).toBeUndefined();
  await flush(r);
  return r;
}

async function save(r: Rig): Promise<void> {
  const save = r.el.querySelector('.save-bar button') as HTMLButtonElement | null;
  expect(save).toBeDefined();
  expect(save!.disabled).toBe(false);
  save!.click();
  await expect.poll(() => r.app.saving()).toBe(false);
  await flush(r);
}

describe('P4 clean catalog workflows through the actual save boundary', () => {
  it('converts a category-off legacy config with no proposal, then adopts, reloads, and assigns numeric', async () => {
    const legacy = { ...BASE, temperatureSensors: false, humiditySensors: true };
    const r = await rig(legacy);
    const conversionNote = 'Conversion keeps known disabled sensors disabled. Future recognized sensors may appear and can be disabled individually.';
    expect(r.el.querySelector('.conversion-note')?.textContent).toBe(conversionNote);
    expect(r.requests.map(x => x.path)).not.toContain('/preview-save');
    const original = readFileSync(r.configPath, 'utf8');
    await r.app.previewCatalog('convert');
    await flush(r);
    expect(r.el.querySelector('.conversion-note')?.textContent).toBe(conversionNote);
    const conversion = r.requests.find(x => x.path === '/preview-save')!.body;
    for (const key of ['proposal', 'settings', 'adoptCatalogVersion']) expect(conversion).not.toHaveProperty(key);
    expect(readFileSync(r.configPath, 'utf8')).toBe(original);
    expect(existsSync(path.join(r.persistDir, 'legacy-config-snapshot.json'))).toBe(false);
    expect(r.app.previewResult()?.ok).toBe(true);
    const wrong = await handlePreviewSave(r.deps, { ...conversion, proposal: [] });
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) throw new Error('Expected comparison preview');
    expect(wrong.changes.some(c => c.dataPoint === 'tempf' && c.change === 'added')).toBe(true);
    expect(r.el.querySelector('.configuration-transition')?.textContent).toContain('legacy');
    const update = r.ipc.updatePluginConfig!;
    r.ipc.updatePluginConfig = async config => {
      expect(existsSync(path.join(r.persistDir, 'legacy-config-snapshot.json'))).toBe(true);
      return update(config);
    };
    await save(r);
    expect(r.readBlock()).toMatchObject({ configVersion: 2, catalogBaseline: 1, catalogAdopted: 1 });
    expect(r.el.querySelector('.conversion-note')).toBeNull();
    expect(r.app.state()?.rows.find(row => row.dataPoint === 'tempf')?.enabled).toBe(false);
    for (const call of r.requests.filter(x => ['/compose-save', '/commit-save'].includes(x.path))) {
      expect(call.body).not.toHaveProperty('proposal');
      expect(call.body).not.toHaveProperty('settings');
    }
    await r.app.previewCatalog('adopt');
    await flush(r);
    expect(r.el.querySelector('.conversion-note')).toBeNull();
    const adoption = r.requests.filter(x => x.path === '/preview-save').at(-1)!.body;
    expect(adoption.adoptCatalogVersion).toBe(4);
    expect(adoption).not.toHaveProperty('settings');
    expect(r.app.state()?.catalog?.adopted).toBe(1);
    await save(r);
    expect(r.app.state()?.catalog).toEqual({ baseline: 1, adopted: 4, current: 4 });
    open(r, 'flow1');
    set(r, 'pair', 'motion|numeric');
    set(r, 'unitLabel', 'L/min');
    await r.app.preview();
    await flush(r);
    await save(r);
    expect((r.readBlock().sensorMap as Json[]).find(row => row.dataPoint === 'flow1')).toMatchObject({
      stationMac: MAC, kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', unitLabel: 'L/min',
    });
    expect(r.app.state()?.rows.find(row => row.dataPoint === 'flow1')?.identityScope).toBe('custom-station');
  });

  it.each([
    { adopted: 1, assignment: { dataPoint: 'door1', stationMac: MAC, kind: 'contact', measurement: 'boolean' } },
    { adopted: 3, assignment: { dataPoint: 'flow1', stationMac: MAC, kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', unitLabel: '' } },
  ])('adopts an unchanged dormant assignment at catalog $adopted despite current no-wrapper diagnostics', async ({ adopted, assignment }) => {
    const r = await rig({ ...BASE, configVersion: 2, catalogBaseline: 1, catalogAdopted: adopted, sensorMap: [assignment] });
    expect(r.app.state()?.errors.some(e => e.code === 'no-wrapper')).toBe(true);
    expect(r.app.cleanOperationError('adopt')).toBeNull();
    await r.app.previewCatalog('adopt');
    await flush(r);
    expect(r.requests.find(x => x.path === '/preview-save')!.body.proposal).toEqual([assignment]);
    const p = r.app.previewResult();
    expect(p?.ok).toBe(true);
    if (!p?.ok) throw new Error('Expected dormant assignment to activate');
    expect(p.changes.some(c => c.dataPoint === assignment.dataPoint && c.change === 'added')).toBe(true);
    expect(r.el.querySelector('.sensor-support-summary')?.textContent).not.toContain('Your existing accessories stay unchanged.');
    expect(r.el.querySelector('.sensor-support-summary')?.textContent).not.toContain('No new Apple Home accessories will be created.');
    await save(r);
    expect((r.readBlock().sensorMap as Json[]).find(row => row.dataPoint === assignment.dataPoint)).toMatchObject(assignment);
    expect(r.app.reloadRequired()).toBe(false);
    expect(r.app.state()?.rows.find(row => row.dataPoint === assignment.dataPoint)?.identityScope).toBe('custom-station');
  });

  it.each([null, { dataPoint: 'flow1', unknownFutureField: 'must not disappear' }])('blocks lossy clean adoption before any request: %j', async fragment => {
    const r = await rig({ ...BASE, configVersion: 2, catalogBaseline: 1, catalogAdopted: 3, sensorMap: [fragment] });
    expect(r.app.cleanOperationError('adopt')).toContain('cannot be reproduced');
    await r.app.previewCatalog('adopt');
    expect(r.requests.some(x => x.path === '/preview-save')).toBe(false);
  });

  it('passes intact rejected raw identity through unchanged, leaving validation to the target catalog', async () => {
    const assignment = { dataPoint: null, stationMac: 42, kind: 'motion', measurement: 'numeric', sourceUnit: 'raw' };
    const r = await rig({ ...BASE, configVersion: 2, catalogBaseline: 1, catalogAdopted: 3, sensorMap: [assignment] });
    expect(r.app.state()?.errors.length).toBeGreaterThan(0);
    expect(r.app.cleanOperationError('adopt')).toBeNull();
    await r.app.previewCatalog('adopt');
    await flush(r);
    expect(r.requests.find(x => x.path === '/preview-save')!.body.proposal).toEqual([assignment]);
    expect(r.app.previewResult()).toMatchObject({ ok: false, error: { code: 'invalid-rows' } });
    expect(r.events).not.toContain('update');
  });

  it('preserves birth stamps on explicit conversion and excludes settings-only creation from transition confirmation', async () => {
    const r = await rig(null, []);
    expect(button(r, 'Preview conversion')).toBeUndefined();
    set(r, 'name', 'New installation');
    await r.app.preview();
    await flush(r);
    expect(r.app.previewResult()?.ok).toBe(true);
    expect(r.app.previewResult()).not.toHaveProperty('configurationTransition');
    expect(r.el.querySelector('.configuration-transition')).toBeNull();
    await save(r);
    expect(r.readBlock()).toMatchObject({ catalogBaseline: 4, catalogAdopted: 4 });
    expect(r.readBlock()).not.toHaveProperty('configVersion');
    writeFileSync(path.join(r.persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: [{
      stationMac: MAC, stationName: 'Workflow', dataPoint: 'tempf', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
    }] }));
    await r.app.previewCatalog('convert');
    await flush(r);
    expect(r.app.previewResult(), r.el.textContent ?? '').toMatchObject({ ok: true });
    await save(r);
    expect(r.readBlock()).toMatchObject({ configVersion: 2, catalogBaseline: 4, catalogAdopted: 4 });
  });
});

describe('P4 operation guards and authoritative save outcomes', () => {
  const current = (sensorMap: unknown[] = []): Json => ({
    ...BASE, configVersion: 2, catalogBaseline: 1, catalogAdopted: 3, sensorMap,
  });

  it('explains a real disabled-field support update, keeps technical stamps collapsed, and cancels without writes', async () => {
    // No inverted-battery host in this configuration. The separate battery
    // lifecycle below must NOT get this unchanged-accessory reassurance.
    const r = await rig({ ...current([
      { dataPoint: 'lightning_day', batteryField: null },
      { dataPoint: 'lightning_hour', batteryField: null },
    ]), catalogAdopted: 1 });
    const original = readFileSync(r.configPath, 'utf8');
    expect(r.el.querySelector('.catalog-panel h3')?.textContent).toBe('Sensor support');
    expect(button(r, 'Review new sensor support')).toBeDefined();
    expect(r.el.querySelector('.catalog-panel details')?.hasAttribute('open')).toBe(false);
    const currentDetails = r.el.querySelector('.catalog-panel details')?.textContent;
    expect(currentDetails).toContain('These numbers track sensor support, not plugin releases.');
    expect(currentDetails).toContain('Starting sensor-support version: 1. Kept unchanged so later sensor definitions default to off.');
    expect(currentDetails).toContain('Sensor-support version in use: 1.');
    expect(currentDetails).toContain('Latest version included with this plugin: 4.');
    button(r, 'Review new sensor support')!.click();
    await expect.poll(() => r.app.previewPending()).toBe(false);
    await flush(r);
    const p = r.app.previewResult();
    if (!p?.ok) throw new Error('Expected support update');
    expect(p.changes).toHaveLength(0);
    expect(p.batteryPolarity).toHaveLength(0);
    expect(p.configOnly.length).toBeGreaterThan(0);
    expect(p.configOnly.every(c => c.change === 'added' && c.after?.enabled === false)).toBe(true);
    const summary = r.el.querySelector('.sensor-support-summary')?.textContent;
    expect(summary).toContain('Your existing accessories stay unchanged.');
    expect(summary).toContain(`Support for ${p.configOnly.length} additional sensor fields will become available, all switched off.`);
    expect(summary).toContain('No new Apple Home accessories will be created.');
    expect(r.el.querySelector('.preview-block')?.textContent).toContain(`Newly supported sensor fields: ${p.configOnly.length}, all off`);
    expect(r.el.querySelectorAll('.preview-block .chip-disabled')).toHaveLength(p.configOnly.length);
    expect(r.el.querySelector('.preview-block .chip-disabled')?.textContent).toBe('Available, switched off');
    const detail = r.el.querySelector('.configuration-transition') as HTMLDetailsElement;
    expect(detail.open).toBe(false);
    expect(detail.textContent).toContain('These numbers track sensor support, not plugin releases.');
    expect(detail.textContent).toContain('Starting sensor-support version: 1 → 1.');
    expect(detail.textContent).toContain('Sensor-support version in use: 1 → 4.');
    expect(button(r, 'Enable new sensor support')?.disabled).toBe(false);
    button(r, 'Cancel preview')!.click();
    await flush(r);
    expect(r.app.previewResult()).toBeNull();
    expect(readFileSync(r.configPath, 'utf8')).toBe(original);
    expect(r.events).toEqual([]);
  });

  it.each([1, 4])('explains the unchanged starting version %s when sensor support is up to date', async baseline => {
    const r = await rig({ ...current(), catalogBaseline: baseline, catalogAdopted: 4 });
    expect(r.el.querySelector('.catalog-panel')?.textContent).toContain('Your configuration has the latest sensor support included with this installed plugin.');
    const details = r.el.querySelector('.catalog-panel details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(`Starting sensor-support version: ${baseline}.`);
    expect(details.textContent).toContain('Sensor-support version in use: 4.');
    expect(details.textContent).toContain('Latest version included with this plugin: 4.');
    expect(button(r, 'Review new sensor support')).toBeUndefined();
    expect(r.requests.some(x => x.path === '/preview-save')).toBe(false);
  });

  it.each(['accessory', 'battery', 'settings', 'single-field', 'mixed-disabled'] as const)(
    'bases support-update copy on the complete displayed consequences: %s', async scenario => {
      const r = await rig(current());
      const p = emptyPreview('copy-probe');
      if (!p.ok) throw new Error('Expected fixture');
      p.configurationTransition = { before: { mode: 'v2', baseline: 1, adopted: 3, stamped: true },
        after: { mode: 'v2', baseline: 1, adopted: 4, stamped: true } };
      const row = r.app.state()!.rows.find(r => r.dataPoint === 'tempf')!;
      if (scenario === 'accessory') {
        // A non-structural change is still an accessory change. Checking
        // structuralChangeCount alone would falsely promise no change.
        p.changes = [{ change: 'modified', stationMac: MAC, dataPoint: 'tempf', structural: false,
          before: row, after: { ...row, name: 'Renamed temperature' } }];
      } else if (scenario === 'battery') {
        p.batteryPolarity = [{ stationMac: MAC, dataPoint: 'tempf', batteryField: 'battout', from: 'standard', to: 'vendor-inverted' }];
      } else if (scenario === 'settings') {
        p.settingsChanged = ['name'];
      } else {
        p.configOnly = [{ change: 'added', stationMac: MAC, dataPoint: 'new_field', after: { ...row, dataPoint: 'new_field', enabled: false } }];
        if (scenario === 'mixed-disabled') p.configOnly.push({ change: 'removed', stationMac: MAC, dataPoint: 'old_field', before: { ...row, enabled: false } });
      }
      r.intercept = endpoint => endpoint === '/preview-save' ? Promise.resolve(p) : undefined;
      await r.app.previewCatalog('adopt');
      await flush(r);
      const text = r.el.querySelector('.sensor-support-summary')?.textContent ?? '';
      if (['accessory', 'battery', 'settings'].includes(scenario)) {
        expect(text).not.toContain('Your existing accessories stay unchanged.');
        expect(text).toContain('Review the accessory, setting, and battery-reporting changes');
      } else {
        expect(text).toContain('Support for 1 additional sensor field will become available, switched off.');
        expect(text).not.toContain('1 additional sensor fields');
      }
      if (scenario === 'mixed-disabled') {
        expect(r.el.querySelector('.preview-block')?.textContent).toContain('Changes to switched-off sensors');
        expect(r.el.querySelector('.preview-block')?.textContent).not.toContain('Newly supported sensor fields: 2');
      }
    },
  );

  it('requires clean row and Connection forms, including a blank invalid row with zero drafts', async () => {
    const r = await rig(current());
    open(r, 'tempf');
    set(r, 'name', '');
    expect(r.fixture.componentInstance.store.draftCount).toBe(0);
    expect(r.app.cleanOperationError('adopt')).toContain('finish or cancel');
    await r.app.previewCatalog('adopt');
    expect(r.requests.some(x => x.path === '/preview-save')).toBe(false);
    button(r, 'Cancel')!.click();
    await flush(r);
    const connection = [...r.el.querySelectorAll('button')].find(b => b.textContent?.includes('Connection & polling'));
    expect(connection).toBeDefined();
    connection!.click();
    r.fixture.detectChanges();
    set(r, 'name', 'Unsaved Connection name');
    expect(r.app.cleanOperationError('adopt')).toContain('Save or discard');
    await r.app.previewCatalog('adopt');
    expect(r.requests.some(x => x.path === '/preview-save')).toBe(false);
    expect((r.el.querySelector('[formcontrolname="name"]') as HTMLInputElement).value).toBe('Unsaved Connection name');
  });

  it('shows real battery consequences and stamp-only transitions without a false no-op claim', async () => {
    const r = await rig({ ...current(), catalogAdopted: 1 }, ['lightning_day', 'batt_lightning']);
    await r.app.previewCatalog('adopt');
    await flush(r);
    const p = r.app.previewResult();
    expect(p?.ok).toBe(true);
    if (!p?.ok) throw new Error('Expected polarity preview');
    expect(p.batteryPolarity.length).toBeGreaterThan(0);
    expect(r.el.querySelectorAll('.battery-polarity').length).toBe(p.batteryPolarity.length);
    expect(r.el.querySelector('.battery-polarity')!.textContent).toContain('0 = low, 1 = normal');
    expect(r.el.querySelector('.battery-polarity')!.textContent).toContain('0 = normal, 1 = low');
    expect(r.el.querySelector('.battery-polarity')!.textContent).toContain(MAC);
    expect(r.el.querySelector('.battery-polarity')!.textContent).toContain('Workflow');
    expect(r.el.textContent).not.toContain('saving would change nothing');
    expect(r.el.querySelector('.battery-polarity button')).toBeNull();
    expect(r.el.querySelector('.sensor-support-summary')?.textContent).not.toContain('Your existing accessories stay unchanged.');
    expect(r.el.querySelector('.sensor-support-summary')?.textContent).toContain('battery-reporting changes');
    await save(r);
    expect(r.readBlock().catalogAdopted).toBe(4);
  });

  it('locks row and Connection editing during adoption and allows cancellation without drafting or writing', async () => {
    const r = await rig(current());
    const baseline = readFileSync(r.configPath, 'utf8');
    open(r, 'tempf');
    expect(r.el.querySelector('.editor-form')).not.toBeNull();
    await r.app.previewCatalog('adopt');
    await flush(r);
    expect(r.el.querySelector('.editor-form')).toBeNull();
    for (const edit of [...r.el.querySelectorAll('button')].filter(b => b.textContent === 'Edit')) expect(edit.disabled).toBe(true);
    expect(r.fixture.componentInstance.store.dirty).toBe(false);
    r.app.cancelPreview();
    await flush(r);
    expect(r.app.previewResult()).toBeNull();
    expect(r.app.canSavePreview()).toBe(false);
    expect(r.fixture.componentInstance.store.dirty).toBe(false);
    expect(r.events).toEqual([]);
    expect(readFileSync(r.configPath, 'utf8')).toBe(baseline);
    expect(r.app.cleanOperationError('adopt')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('a cancelled preview %s cannot overwrite or finish the newer request', async outcome => {
    const r = await rig(current());
    const first = deferred<PreviewResultDto>();
    const second = deferred<PreviewResultDto>();
    let calls = 0;
    r.intercept = endpoint => endpoint === '/preview-save' ? (++calls === 1 ? first.promise : second.promise) : undefined;
    const a = r.app.previewCatalog('adopt');
    await microtasks(r);
    expect(calls).toBe(1);
    r.app.cancelPreview();
    const b = r.app.previewCatalog('adopt');
    await microtasks(r);
    expect(calls).toBe(2);
    if (outcome === 'resolve') first.resolve(emptyPreview('obsolete'));
    else first.reject(new Error('obsolete transport error'));
    await a;
    await microtasks(r);
    expect(r.app.previewPending()).toBe(true);
    expect(r.app.previewResult()).toBeNull();
    expect(r.app.canSavePreview()).toBe(false);
    expect(r.el.textContent).not.toContain('obsolete');
    second.resolve(emptyPreview('current'));
    await b;
    await flush(r);
    expect(r.app.previewPending()).toBe(false);
    expect(r.app.previewResult()).toMatchObject({ digest: 'current' });
    expect(r.app.canSavePreview()).toBe(true);
  });

  it('rejects an obsolete intent before transport when the cache lookup yields across a user edit', async () => {
    const r = await rig({ ...current(), catalogAdopted: 4 });
    open(r, 'tempf');
    set(r, 'name', 'First draft');
    const cache = deferred<unknown[]>();
    r.cache = () => cache.promise;
    const pending = r.app.preview();
    set(r, 'name', 'Later draft');
    cache.resolve([]);
    await pending;
    await flush(r);
    expect(r.requests.some(x => x.path === '/preview-save')).toBe(false);
    expect(r.app.canSavePreview()).toBe(false);
    r.cache = undefined;
    await r.app.preview();
    await flush(r);
    expect((r.requests.find(x => x.path === '/preview-save')!.body.proposal as Json[])
      .find(row => row.dataPoint === 'tempf')?.name).toBe('Later draft');
  });

  it('retires an older Save as soon as a replacement preview starts', async () => {
    const r = await rig({ ...current(), catalogAdopted: 4 });
    open(r, 'tempf');
    set(r, 'name', 'Renamed');
    await r.app.preview();
    await flush(r);
    expect(r.app.canSavePreview()).toBe(true);
    const wait = deferred<PreviewResultDto>();
    r.intercept = endpoint => endpoint === '/preview-save' ? wait.promise : undefined;
    const pending = r.app.preview();
    await microtasks(r);
    expect(r.app.canSavePreview()).toBe(false);
    expect(button(r, 'Save changes')!.disabled).toBe(true);
    wait.resolve(emptyPreview('replacement'));
    await pending;
    await flush(r);
    expect(r.app.canSavePreview()).toBe(true);
  });

  it('keeps the label-intent annotation tied to the displayed result until its replacement is accepted', async () => {
    const r = await rig({ ...current([{ dataPoint: 'flow1', stationMac: MAC, kind: 'motion', measurement: 'numeric',
      sourceUnit: 'raw', unitLabel: 'L/min' }]), catalogAdopted: 4 });
    open(r, 'flow1');
    set(r, 'unitLabel', 'gpm');
    await r.app.preview();
    await flush(r);
    const displayed = r.app.previewResult();
    expect(r.el.querySelector('.label-intent-preview')).not.toBeNull();

    // Exercise the retained-result view-model boundary independently of ordinary
    // edit invalidation: the next request has no label intent, while the old
    // effect list deliberately remains visible during a replacement request.
    const row = r.app.state()!.rows.find(row => row.dataPoint === 'flow1')!;
    r.fixture.componentInstance.store.clearField(row, 'unitLabel');
    const earlier = deferred<PreviewResultDto>();
    const newer = deferred<PreviewResultDto>();
    let count = 0;
    r.intercept = endpoint => endpoint === '/preview-save' ? (++count === 1 ? earlier.promise : newer.promise) : undefined;
    const a = r.app.preview();
    await microtasks(r);
    expect(r.app.previewResult()).toBe(displayed);
    expect(r.el.querySelector('.label-intent-preview')).not.toBeNull();
    expect(button(r, 'Save changes')!.disabled).toBe(true);
    const b = r.app.preview();
    await microtasks(r);
    earlier.resolve(emptyPreview('obsolete-label-result'));
    await a;
    await microtasks(r);
    expect(r.app.previewPending()).toBe(true);
    expect(r.app.previewResult()).toBe(displayed);
    expect(r.el.querySelector('.label-intent-preview')).not.toBeNull();
    newer.resolve(emptyPreview('current-no-label-result'));
    await b;
    await flush(r);
    expect(r.app.previewResult()).toMatchObject({ digest: 'current-no-label-result' });
    expect(r.el.querySelector('.label-intent-preview')).toBeNull();
    expect(r.app.canSavePreview()).toBe(true);
  });

  it('double activation dispatches one validation, commit, and persistence transaction', async () => {
    const r = await rig(current());
    await r.app.previewCatalog('adopt');
    await flush(r);
    const saveButton = button(r, 'Enable new sensor support')!;
    saveButton.click();
    saveButton.click();
    await expect.poll(() => r.app.saving()).toBe(false);
    await flush(r);
    expect(r.requests.filter(x => x.path === '/compose-save')).toHaveLength(1);
    expect(r.requests.filter(x => x.path === '/commit-save')).toHaveLength(1);
    expect(r.events.filter(x => x === 'update')).toHaveLength(1);
    expect(r.events.filter(x => x === 'save')).toHaveLength(1);
  });

  it.each(['failed-reload', 'receipt-drift', 'indeterminate-persist'] as const)('locks every mutation after %s without optimistic capability unlock', async failure => {
    const r = await rig(current());
    await r.app.previewCatalog('adopt');
    await flush(r);
    r.failReload = failure === 'failed-reload';
    r.driftAfterSave = failure === 'receipt-drift';
    r.failPersist = failure === 'indeterminate-persist';
    await save(r);
    expect(r.app.reloadRequired()).toBe(true);
    expect(r.app.canSavePreview()).toBe(false);
    expect(r.el.textContent).toContain('Editing is locked');
    for (const edit of [...r.el.querySelectorAll('button')].filter(b => b.textContent === 'Edit')) expect(edit.disabled).toBe(true);
    if (failure === 'indeterminate-persist') expect(r.el.textContent).toContain('persistence-indeterminate');
    else expect(r.el.textContent).toContain('Saved.');
    const previous = r.requests.length;
    await r.app.previewCatalog('adopt');
    await r.app.preview();
    expect(r.requests).toHaveLength(previous);
    if (failure === 'failed-reload' || failure === 'indeterminate-persist') expect(r.app.state()?.catalog?.adopted).toBe(3);
  });

  it('a structured refusal retires preview, and restore failure is terminal without erasing the refusal', async () => {
    const r = await rig(current());
    await r.app.previewCatalog('adopt');
    await flush(r);
    r.failRestore = true;
    r.intercept = endpoint => endpoint === '/compose-save'
      ? Promise.resolve({ ok: false, error: { code: 'stale-confirmation', message: 'Preview again after reloading.' } }) : undefined;
    await save(r);
    expect(r.el.textContent).toContain('Save failed (stale-confirmation)');
    expect(r.el.textContent).toContain('could not re-assert');
    expect(r.app.reloadRequired()).toBe(true);
    expect(r.app.previewResult()).toBeNull();
    expect(r.events).not.toContain('update');
    expect(r.readBlock().catalogAdopted).toBe(3);
  });

  it('a real stale-base refusal retires consent without persistence or recovery records', async () => {
    const r = await rig(current());
    await r.app.previewCatalog('adopt');
    await flush(r);
    const externallyChanged = { ...r.readBlock(), name: 'Changed by another session' };
    writeFileSync(r.configPath, JSON.stringify({ platforms: [externallyChanged] }));
    const diskBeforeSave = readFileSync(r.configPath, 'utf8');
    await save(r);
    expect(r.el.textContent).toContain('Save failed (stale-base)');
    expect(r.app.previewResult()).toBeNull();
    expect(r.app.canSavePreview()).toBe(false);
    expect(r.events).not.toContain('update');
    expect(r.requests.filter(x => x.path === '/commit-save')).toHaveLength(0);
    expect(readFileSync(r.configPath, 'utf8')).toBe(diskBeforeSave);
    expect(existsSync(path.join(r.persistDir, 'legacy-config-snapshot.json'))).toBe(false);
    expect(existsSync(path.join(r.persistDir, 'legacy-conversion-journal'))).toBe(false);
  });

  it('an unavailable cache remains unknown and empty inventory refuses rather than adopting an empty map', async () => {
    const r = await rig(current([{ dataPoint: 'flow1', kind: 'motion', measurement: 'numeric', sourceUnit: 'raw' }]), []);
    r.cache = async () => { throw new Error('Homebridge cache read unavailable'); };
    await r.app.previewCatalog('adopt');
    await flush(r);
    const preview = r.requests.find(x => x.path === '/preview-save')!;
    expect(preview.body).not.toHaveProperty('cachedAccessoryUniqueIds');
    expect(r.app.previewResult()).toMatchObject({ ok: false, error: { code: 'no-station-inventory' } });
    expect(r.app.canSavePreview()).toBe(false);
    expect(r.readBlock().catalogAdopted).toBe(3);
    expect(r.events).toEqual([]);
  });

  it.each([1, 2, 3, 4])('reflects catalog %i/4 availability in the real pair controls without optimistic adoption', async adopted => {
    const r = await rig({ ...current(), catalogAdopted: adopted });
    open(r, 'flow1');
    const picker = r.el.querySelector('[formcontrolname="pair"]') as HTMLSelectElement;
    expect(picker).not.toBeNull();
    const vocabulary = handleGetVocabulary({ vocabularyProtocol: 2 }) as VocabularyDto;
    for (const pair of vocabulary.assignments) {
      const option = [...picker.options].find(o => o.value === pair.id);
      expect(option, pair.id).toBeDefined();
      expect(option!.disabled, pair.id).toBe(pair.since > adopted);
    }
    expect(r.app.state()?.catalog?.adopted).toBe(adopted);
    expect(r.requests.some(x => ['/preview-save', '/compose-save', '/commit-save'].includes(x.path))).toBe(false);
  });

  it.each(['safe-mode', 'opt-out', 'multi-home'] as const)('offers no writable catalog action for %s', async mode => {
    const block = mode === 'safe-mode' ? { ...current(), catalogAdopted: 99 }
      : mode === 'opt-out' ? { ...current(), _sensorMapV2: false } : current();
    const r = await rig(block, ['tempf'], mode === 'multi-home' ? [{ ...BASE, name: 'Other home' }] : []);
    expect(r.app.state()?.editorAvailable).toBe(false);
    for (const label of ['Preview conversion', 'Review new sensor support']) {
      const action = button(r, label);
      if (action) expect(action.disabled).toBe(true);
    }
    await r.app.previewCatalog('convert');
    await r.app.previewCatalog('adopt');
    expect(r.requests.some(x => x.path === '/preview-save')).toBe(false);
    expect(r.events).toEqual([]);
  });
});

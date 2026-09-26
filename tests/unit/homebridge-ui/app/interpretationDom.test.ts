// @vitest-environment jsdom
/** Real editor -> compiled handlers -> guarded persistence, without a live bridge. */
import '@angular/compiler';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AwnRootComponent } from '../../../../homebridge-ui/app-src/awn-root.component';
import { HOMEBRIDGE_IPC, type HomebridgeIpc } from '../../../../homebridge-ui/app-src/homebridge.service';
import type { EditorRowDto, EditorStateDto, PreviewResultDto } from '../../../../homebridge-ui/app-src/dto/editor-state';
import { handleCommitSave, handleComposeSave, handleGetEditorState, handleGetVocabulary, handlePreviewSave, type HandlerDeps } from '../../../../homebridge-ui/handlers.js';

type Json = Record<string, unknown>;
const A = 'AA:BB:CC:DD:EE:01';
const B = 'AA:BB:CC:DD:EE:02';
const WIND = { dataPoint: 'custom_x', stationMac: A, kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', displayUnit: 'mph', name: 'Wind probe', threshold: 10 };
const BASE = { platform: 'AmbientWeatherSensors', name: 'Test', configVersion: 2, catalogBaseline: 1, catalogAdopted: 4, apiKey: 'secret', applicationKey: 'secret-app' };
const roots: string[] = [];
interface App {
  state(): EditorStateDto;
  store: { proposal(): Json[]; dirty: boolean };
  interpretationRow(): EditorRowDto | null;
  canStartInterpretation(row: EditorRowDto): boolean;
  startInterpretation(row: EditorRowDto): void;
  cancelInterpretation(): void;
  previewInterpretation(): Promise<void>;
  preview(): Promise<void>;
  previewResult(): PreviewResultDto | null;
  canSavePreview(): boolean;
  saving(): boolean;
  reloadRequired(): boolean;
}
interface Rig {
  el: HTMLElement; fixture: ComponentFixture<AwnRootComponent>; app: App; deps: HandlerDeps;
  configPath: string; persistDir: string; requests: Array<{ endpoint: string; body: Json }>;
  writes: number; read(): Json; intercept?: (endpoint: string, body: Json) => Promise<unknown> | undefined;
  failSave?: boolean; failRestore?: boolean;
}
beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => {
  TestBed.resetTestingModule();
  // Storage may be absent or throw in a restricted jsdom environment,
  // just as in a browser. Its availability must not prevent file cleanup.
  try { localStorage.clear(); } catch { /* optional per-viewer storage */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
async function flush(r: Rig) { await new Promise(resolve => setTimeout(resolve, 0)); await r.fixture.whenStable(); r.fixture.detectChanges(); }
async function tick(r: Rig) { await new Promise(resolve => setTimeout(resolve, 0)); r.fixture.detectChanges(); }
const buttons = (r: Rig, text: string) => [...r.el.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === text);
function click(r: Rig, text: string) { const b = buttons(r, text)[0]; expect(b, text).toBeDefined(); expect(b.disabled, text).toBe(false); b.click(); r.fixture.detectChanges(); }
function set(r: Rig, key: string, value: string | boolean) {
  const input = r.el.querySelector(`[formcontrolname="${key}"]`) as HTMLInputElement | HTMLSelectElement;
  expect(input, key).not.toBeNull();
  if (typeof value === 'boolean') (input as HTMLInputElement).checked = value;
  else input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement || typeof value === 'boolean' ? 'change' : 'input'));
  r.fixture.detectChanges();
}
function open(r: Rig, point = 'custom_x', mac = A) {
  const row = r.app.state().rows.find(x => x.dataPoint === point && x.stationMac === mac)!;
  const id = `edit-${encodeURIComponent(`${mac}|${point}`)}`;
  const button = [...r.el.querySelectorAll<HTMLButtonElement>('button[id]')].find(b => b.id === id);
  expect(button, JSON.stringify(row)).toBeDefined(); button!.click(); r.fixture.detectChanges();
  return row;
}
async function begin(r: Rig, point = 'custom_x', mac = A) { open(r, point, mac); click(r, 'Change interpretation'); await flush(r); }
async function preview(r: Rig) { await r.app.previewInterpretation(); await flush(r); expect(r.app.previewResult(), JSON.stringify(r.app.previewResult())).toMatchObject({ ok: true }); return r.app.previewResult() as Extract<PreviewResultDto, { ok: true }>; }
async function save(r: Rig) { click(r, 'Save changes'); await expect.poll(() => r.app.saving()).toBe(false); await flush(r); }
function deferred() { let resolve!: (v: unknown) => void; let reject!: (e: Error) => void; const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function rig(map: Json[] = [WIND], overrides: Json = {}, reported = ['custom_x', 'tempf']): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'interpretation-dom-')); roots.push(root);
  const configPath = path.join(root, 'config.json'); const persistDir = path.join(root, 'data'); mkdirSync(persistDir);
  let session = [{ ...BASE, sensorMap: map, ...overrides }];
  writeFileSync(configPath, JSON.stringify({ platforms: session }));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: [A, B].flatMap(stationMac => reported.map(dataPoint => ({ stationMac, stationName: stationMac === A ? 'Home' : 'Barn', dataPoint, firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' }))) }));
  const deps: HandlerDeps = { persistDir, configPath, version: 'test', env: {}, log: { info() {}, warn() {}, debug() {} } };
  const r = { deps, configPath, persistDir, requests: [], writes: 0, read: () => JSON.parse(readFileSync(configPath, 'utf8')).platforms[0] } as unknown as Rig;
  let disabled = 0;
  const ipc: HomebridgeIpc = {
    getPluginConfig: async () => session,
    getCachedAccessories: async () => [],
    disableSaveButton: () => { disabled++; if (disabled > 1 && r.failRestore) throw new Error('restore failed'); },
    updatePluginConfig: async next => { session = next as typeof session; },
    savePluginConfig: async () => { r.writes++; writeFileSync(configPath, JSON.stringify({ platforms: session })); if (r.failSave) throw new Error('effect then lost response'); },
    request: async (endpoint, body) => {
      const payload = (body ?? {}) as Json; r.requests.push({ endpoint, body: structuredClone(payload) });
      const intercepted = r.intercept?.(endpoint, payload); if (intercepted !== undefined) return intercepted;
      if (endpoint === '/editor-state') return handleGetEditorState(deps, payload);
      if (endpoint === '/vocabulary') return handleGetVocabulary(payload);
      if (endpoint === '/notices') return { notices: [] };
      if (endpoint === '/preview-save') return handlePreviewSave(deps, payload);
      if (endpoint === '/compose-save') return handleComposeSave(deps, payload);
      if (endpoint === '/commit-save') return handleCommitSave(deps, payload);
      throw new Error(endpoint);
    },
  };
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: HOMEBRIDGE_IPC, useValue: ipc }] });
  r.fixture = TestBed.createComponent(AwnRootComponent); r.el = r.fixture.nativeElement;
  r.app = r.fixture.componentInstance as unknown as App; r.fixture.detectChanges();
  await expect.poll(() => r.app.state()).toBeDefined(); await flush(r);
  return r;
}

describe('Change interpretation through real editor and guarded pipeline', () => {
  it('previews a source-only change in place, clears its threshold, preserves scope and reloads byte-stably', async () => {
    const r = await rig(); const before = readFileSync(r.configPath, 'utf8'); const proposal = r.app.store.proposal();
    await begin(r); set(r, 'sourceUnit', 'mps');
    expect((r.el.querySelector('[formcontrolname="threshold"]') as HTMLInputElement).value).toBe('');
    expect(r.app.store.proposal()).toEqual(proposal);
    const p = await preview(r); const changed = p.changes.find(c => c.dataPoint === 'custom_x')!;
    expect(changed).toMatchObject({ structural: false, after: { sourceUnit: 'mps', triggerEnabled: false } });
    expect(r.el.querySelector('.preview-block')?.textContent).toContain('source unit');
    expect(r.el.querySelector('.preview-block')?.textContent).toContain('threshold triggering on → off');
    expect(r.el.querySelectorAll('.exclude-change')).toHaveLength(0);
    expect(readFileSync(r.configPath, 'utf8')).toBe(before);
    await save(r); expect(r.writes).toBe(1);
    const row = r.app.state().rows.find(x => x.dataPoint === 'custom_x' && x.stationMac === A)!;
    expect(row).toMatchObject({ sourceUnit: 'mps', identityScope: 'custom-station', triggerEnabled: false });
    expect(r.read().apiKey).toBe('secret');
    const saved = r.read(); await r.app.preview(); await flush(r); await save(r);
    expect(r.read().sensorMap).toEqual(saved.sensorMap);
  });

  it('changes Contact to Leak as a complete pair and retains the structural confirmation gate', async () => {
    const r = await rig([{ dataPoint: 'custom_x', stationMac: A, kind: 'contact', measurement: 'boolean', name: 'Door' }]);
    await begin(r); set(r, 'pair', 'leak|boolean');
    expect(r.el.querySelector('.interpretation-panel')?.textContent).toContain('1 / true: Leak');
    expect(r.el.querySelector('[formcontrolname="sourceUnit"]')).toBeNull();
    expect(r.el.querySelector('[formcontrolname="threshold"]')).toBeNull();
    const p = await preview(r); expect(p.changes.find(c => c.dataPoint === 'custom_x')).toMatchObject({ structural: true, before: { kind: 'contact' }, after: { kind: 'leak' } });
    expect(r.el.querySelector('.preview-block')?.textContent).toContain('sensor type Contact → Leak');
    const payload = r.requests.filter(x => x.endpoint === '/preview-save').at(-1)!.body;
    expect(await handleComposeSave(r.deps, { ...payload, formBlock: r.read() })).toMatchObject({ ok: false, error: { code: 'confirmation-required' } });
    expect(await handleComposeSave(r.deps, { ...payload, formBlock: r.read(), confirmDigest: 'stale' })).toMatchObject({ ok: false, error: { code: 'stale-confirmation' } });
    await save(r); expect(r.app.state().rows.find(x => x.dataPoint === 'custom_x' && x.stationMac === A)?.kind).toBe('leak');
    expect((r.read().sensorMap as Json[]).find(x => x.dataPoint === 'custom_x')).not.toHaveProperty('sourceUnit');
  });

  it('discloses inherited trigger changes across a global remap without stealing a station identity', async () => {
    const { stationMac: _scope, ...global } = WIND;
    const r = await rig([global, { dataPoint: 'custom_x', stationMac: B, kind: 'motion', measurement: 'pressure', sourceUnit: 'hPa', threshold: 1000, name: 'Barometer' }]);
    await begin(r); expect(r.el.querySelector('.interpretation-panel')?.textContent).toContain('all-stations template');
    set(r, 'sourceUnit', 'mps'); const p = await preview(r);
    const b = p.changes.find(c => c.dataPoint === 'custom_x' && c.stationMac === B)!;
    expect(b).toMatchObject({ after: { measurement: 'pressure', sourceUnit: 'hPa', threshold: 1000, triggerEnabled: false } });
    expect([...r.el.querySelectorAll('.change-row')].find(el => el.textContent?.includes(B) && el.textContent.includes('custom_x'))?.textContent).toContain('threshold triggering on → off');
    await save(r); expect(r.app.state().rows.find(x => x.dataPoint === 'custom_x' && x.stationMac === B)).toMatchObject({ measurement: 'pressure', identityScope: 'custom-station' });
  });

  it('creates only a station remap when a custom global identity has a station settings exception', async () => {
    const { stationMac: _scope, ...global } = WIND;
    const r = await rig([global, { ...WIND, name: 'My exception' }]);
    await begin(r); expect(r.el.querySelector('.interpretation-panel')?.textContent).toContain('this station only');
    set(r, 'sourceUnit', 'mps'); const p = await preview(r);
    expect(p.changes.filter(c => c.dataPoint === 'custom_x').map(c => c.stationMac)).toEqual([A]);
    await save(r); expect(r.app.state().rows.find(x => x.dataPoint === 'custom_x' && x.stationMac === B)).toMatchObject({ sourceUnit: 'mph', triggerEnabled: true });
  });

  it('resets labels and incompatible fields on pair switches and does not resurrect embedding', async () => {
    const r = await rig([{ dataPoint: 'custom_x', stationMac: A, kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', unitLabel: 'L/min', embedName: true, threshold: 8 }]);
    await begin(r); set(r, 'pair', 'motion|wind-speed'); set(r, 'sourceUnit', 'mph');
    expect(r.el.querySelector('[formcontrolname="unitLabel"]')).toBeNull();
    set(r, 'pair', 'motion|numeric');
    expect((r.el.querySelector('[formcontrolname="unitLabel"]') as HTMLInputElement).value).toBe('');
    // Same pair/source still is not a remap, even with a different label.
    expect(buttons(r, 'Preview interpretation')[0].disabled).toBe(true);
    set(r, 'pair', 'humidity|humidity'); set(r, 'sourceUnit', 'percent');
    await preview(r); await save(r);
    const saved = (r.read().sensorMap as Json[]).find(x => x.dataPoint === 'custom_x')!;
    for (const field of ['unitLabel', 'threshold', 'triggerDirection', 'triggerEnabled', 'embedName']) expect(saved).not.toHaveProperty(field);
    await begin(r); set(r, 'pair', 'motion|numeric'); await preview(r); await save(r);
    const back = (r.read().sensorMap as Json[]).find(x => x.dataPoint === 'custom_x')!;
    expect(back.unitLabel).toBe(''); expect(back.embedName).not.toBe(true);
  });

  it('allows explicit trigger recovery after save/reload without enabling on an unrelated edit', async () => {
    const r = await rig(); await begin(r); set(r, 'sourceUnit', 'mps'); await preview(r); await save(r);
    open(r); set(r, 'name', 'Renamed'); await r.app.preview(); await flush(r); await save(r);
    expect(r.app.state().rows.find(x => x.dataPoint === 'custom_x' && x.stationMac === A)?.triggerEnabled).toBe(false);
    open(r); set(r, 'triggerEnabled', true);
    expect(buttons(r, 'Preview changes')[0].disabled).toBe(true);
    set(r, 'threshold', '7'); expect(buttons(r, 'Preview changes')[0].disabled).toBe(false);
    await r.app.preview(); await flush(r); await save(r);
    expect(r.app.state().rows.find(x => x.dataPoint === 'custom_x' && x.stationMac === A)).toMatchObject({ threshold: 7, triggerEnabled: true, sourceUnit: 'mps' });
  });

  it('keeps pristine threshold-less rows valid on open and rename', async () => {
    const { threshold: _drop, ...withoutThreshold } = WIND;
    const r = await rig([withoutThreshold]); open(r); expect(r.app.store.dirty).toBe(false);
    set(r, 'name', 'Still informational'); await r.app.preview(); await flush(r);
    expect(r.app.previewResult()).toMatchObject({ ok: true });
    expect(r.app.store.proposal().find(x => x.dataPoint === 'custom_x')).not.toHaveProperty('threshold');
  });

  it('associates every form control with a label and supports focus entry, ordinary control focus and Cancel restoration', async () => {
    const r = await rig(); await begin(r);
    expect(r.el.isConnected, 'fixture is mounted for native focus assertions').toBe(true);
    expect(r.el.ownerDocument.activeElement?.id).toBe('interpretation-heading');
    const form = r.el.querySelector('.interpretation-panel form')!;
    expect(form.getAttribute('aria-labelledby')).toBe('interpretation-heading');
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) {
      expect(control.labels?.length).toBeGreaterThan(0); expect(control.tabIndex).toBe(0);
      control.focus(); expect(r.el.ownerDocument.activeElement).toBe(control);
    }
    click(r, 'Cancel'); await flush(r);
    expect(r.el.ownerDocument.activeElement?.textContent?.trim()).toBe('Edit');
    open(r); const checkbox = r.el.querySelector<HTMLInputElement>('[formcontrolname="triggerEnabled"]')!;
    expect(checkbox.labels?.[0].textContent).toContain('Threshold triggering'); expect(checkbox.tabIndex).toBe(0);
    checkbox.focus(); expect(r.el.ownerDocument.activeElement).toBe(checkbox);
  });

  it.each(['resolve', 'reject'] as const)('cancels a pending preview and discards its late %s without changing drafts or disk', async outcome => {
    const r = await rig(); const original = readFileSync(r.configPath, 'utf8'); const d = deferred();
    await begin(r); set(r, 'sourceUnit', 'mps'); r.intercept = endpoint => endpoint === '/preview-save' ? d.promise : undefined;
    const pending = r.app.previewInterpretation(); await tick(r); click(r, 'Cancel');
    if (outcome === 'reject') d.reject(new Error('obsolete error'));
    else d.resolve({ ok: true, digest: 'obsolete', rows: [], changes: [], configOnly: [], settingsChanged: [], batteryPolarity: [], structuralChangeCount: 0, warnings: [], notes: [] });
    await pending; await flush(r); expect(r.app.previewResult()).toBeNull(); expect(r.app.canSavePreview()).toBe(false);
    expect(readFileSync(r.configPath, 'utf8')).toBe(original); expect(r.app.store.dirty).toBe(false);
  });

  it('retains a never-reported target under the display filter through Cancel and restores its Edit focus', async () => {
    const r = await rig([WIND], {}, ['tempf']); const row = open(r);
    expect(row.everReported).toBe(false);
    const filter = [...r.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(x => x.closest('label')?.textContent?.includes('Hide sensors'))!;
    filter.checked = true; filter.dispatchEvent(new Event('change')); r.fixture.detectChanges();
    click(r, 'Change interpretation'); await flush(r);
    expect(r.el.textContent).toContain('Wind probe');
    click(r, 'Cancel'); await flush(r);
    expect(r.el.ownerDocument.activeElement?.id).toBe(`edit-${encodeURIComponent(`${A}|custom_x`)}`);
    expect(r.app.store.dirty).toBe(false);
  });

  it('refuses invalid numeric labels at the real preview boundary without writing', async () => {
    const r = await rig(); const bytes = readFileSync(r.configPath, 'utf8'); await begin(r);
    set(r, 'pair', 'motion|numeric'); set(r, 'unitLabel', String.fromCodePoint(0x61c));
    await r.app.previewInterpretation(); await flush(r);
    expect(r.app.previewResult()).toMatchObject({ ok: false, error: { code: 'invalid-rows' } });
    expect(r.app.canSavePreview()).toBe(false); expect(r.writes).toBe(0); expect(readFileSync(r.configPath, 'utf8')).toBe(bytes);
  });

  it('invalidates a pending preview on another mapping edit, and also invalidates a displayed preview', async () => {
    const r = await rig(); await begin(r); set(r, 'sourceUnit', 'mps'); const d = deferred();
    r.intercept = endpoint => endpoint === '/preview-save' ? d.promise : undefined;
    const pending = r.app.previewInterpretation(); await tick(r); set(r, 'sourceUnit', 'kph');
    d.reject(new Error('obsolete')); await pending; await flush(r); expect(r.app.previewResult()).toBeNull();
    r.intercept = undefined; await preview(r); expect(r.app.canSavePreview()).toBe(true);
    set(r, 'threshold', '3'); expect(r.app.canSavePreview()).toBe(false); expect(r.app.previewResult()).toBeNull();
  });

  it('guards Cancel and duplicate activation once persistence starts', async () => {
    const r = await rig(); await begin(r); set(r, 'sourceUnit', 'mps'); await preview(r);
    const d = deferred(); r.intercept = (endpoint, body) => endpoint === '/compose-save' ? d.promise.then(() => handleComposeSave(r.deps, body)) : undefined;
    click(r, 'Save changes'); await tick(r); r.app.cancelInterpretation();
    expect(r.app.interpretationRow()).not.toBeNull(); expect(buttons(r, 'Cancel')[0].disabled).toBe(true);
    buttons(r, 'Save changes')[0].click();
    expect((r.el.querySelector('[formcontrolname="sourceUnit"]') as HTMLSelectElement).disabled).toBe(true);
    d.resolve(undefined); await expect.poll(() => r.app.saving()).toBe(false); await flush(r);
    expect(r.requests.filter(x => x.endpoint === '/compose-save')).toHaveLength(1); expect(r.writes).toBe(1);
  });

  it.each(['failSave', 'failRestore'] as const)('retains the terminal lock after %s', async failure => {
    const r = await rig(); await begin(r); set(r, 'sourceUnit', 'mps'); await preview(r); r[failure] = true;
    // Successful persistence intentionally leaves the native Save disabled and
    // has no unfreeze call. Exercise failed cleanup on the actual refusal path.
    if (failure === 'failRestore') r.intercept = endpoint => endpoint === '/compose-save'
      ? Promise.resolve({ ok: false, error: { code: 'stale-confirmation', message: 'Preview again.' } }) : undefined;
    await save(r); expect(r.app.reloadRequired()).toBe(true); expect(r.app.canSavePreview()).toBe(false);
    r.app.cancelInterpretation(); expect(r.app.reloadRequired()).toBe(true);
  });

  it('refuses dirty, known, legacy and lossy states without modifying anything', async () => {
    const r = await rig(); const known = r.app.state().rows.find(x => x.dataPoint === 'tempf')!;
    expect(r.app.canStartInterpretation(known)).toBe(false);
    open(r); set(r, 'name', 'Draft'); expect(buttons(r, 'Change interpretation')[0].disabled).toBe(true);
    const row = r.app.state().rows.find(x => x.dataPoint === 'custom_x')!;
    const before = r.app.store.proposal(); r.app.startInterpretation(row); expect(r.app.interpretationRow()).toBeNull(); expect(r.app.store.proposal()).toEqual(before);
  });

  it.each([
    { configVersion: undefined }, { catalogAdopted: 99 }, { sensorMap: [{ ...WIND, futureKey: 'withheld' }] },
  ])('keeps the operation unavailable for a non-authorizing configuration %j', async override => {
    const r = await rig([WIND], override);
    for (const row of r.app.state().rows) expect(r.app.canStartInterpretation(row)).toBe(false);
    expect(r.writes).toBe(0);
  });

  it('withholds saved no-wrapper repairs and refuses unadopted pairs selected programmatically', async () => {
    const r = await rig([WIND, { dataPoint: 'door1', kind: 'contact', measurement: 'boolean' }], { catalogAdopted: 1 });
    expect(r.app.state().errors.some(e => e.dataPoint === 'door1' && e.code === 'no-wrapper')).toBe(true);
    expect(r.app.state().rows.filter(x => x.dataPoint === 'door1' && r.app.canStartInterpretation(x))).toHaveLength(0);
    await begin(r); set(r, 'pair', 'leak|boolean');
    expect(buttons(r, 'Preview interpretation')[0].disabled).toBe(true);
    await r.app.previewInterpretation(); expect(r.requests.filter(x => x.endpoint === '/preview-save')).toHaveLength(0);
  });
});

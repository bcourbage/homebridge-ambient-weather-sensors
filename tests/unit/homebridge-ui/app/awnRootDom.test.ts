// @vitest-environment jsdom
/**
 * Committed browser-like acceptance gates for the Angular editor app
 * (review #32 F4) — the manual faked-bridge/iframe evidence from PR A,
 * made permanent: bridge loading, cached-inventory pass-through,
 * grouped rendering, duplicate diagnostics, the no-bridge fallback,
 * and bidirectional parent-theme synchronization.
 *
 * Runs the REAL component + service through Angular's TestBed with
 * JIT compilation under jsdom; the only fake is the HOMEBRIDGE_IPC
 * token (the same seam production fills from window.homebridge).
 */
import '@angular/compiler';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AwnRootComponent } from '../../../../homebridge-ui/app-src/awn-root.component';
import {
  HOMEBRIDGE_IPC,
  observeParentTheme,
  syncThemeClasses,
  type HomebridgeIpc,
} from '../../../../homebridge-ui/app-src/homebridge.service';
import type { EditorStateDto, PreviewResultDto, VocabularyDto } from '../../../../homebridge-ui/app-src/dto/editor-state';

const MAC = 'AA:BB:CC:DD:EE:01';
const OTHER_MAC = 'AA:BB:CC:DD:EE:02';

const VOCAB: VocabularyDto = {
  measurements: {
    temperature: {
      customSource: [{ unit: 'fahrenheit', label: '°F' }, { unit: 'celsius', label: '°C' }],
      extendedDisplay: [],
    },
    'wind-speed': {
      customSource: [{ unit: 'mph', label: 'mph' }, { unit: 'fps', label: 'ft/sec' }],
      extendedDisplay: [{ unit: 'mph', label: 'mph' }, { unit: 'fps', label: 'ft/sec' }],
    },
  },
};

function editorState(overrides: Partial<EditorStateDto> = {}): EditorStateDto {
  return {
    configMode: 'v2',
    v2FlagEnabled: true,
    editorAvailable: true,
    baseDigest: 'digest-live',
    blockIndex: 0,
    version: 'test',
    stations: [
      { mac: MAC, name: 'Roof', source: 'discovery' },
      { mac: OTHER_MAC, source: 'override' },
    ],
    authored: [],
    authoredSource: 'sensorMap',
    mirrorState: 'recognized',
    rows: [
      {
        stationMac: MAC, dataPoint: 'tempf', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', name: 'Outdoor Temp', enabled: true, batteryField: 'battout',
        origin: 'global',
      },
      {
        stationMac: MAC, dataPoint: 'windspeedmph', kind: 'motion', measurement: 'wind-speed',
        sourceUnit: 'mph', displayUnit: 'fps', name: 'Wind', enabled: false, batteryField: null,
        origin: 'station', threshold: 10, triggerEnabled: true, triggerDirection: 'above',
      },
      {
        stationMac: OTHER_MAC, dataPoint: 'tempinf', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'celsius', name: 'Indoor', enabled: true, batteryField: null, origin: 'default',
      },
    ],
    errors: [],
    warnings: [],
    notes: [],
    ...overrides,
  };
}

function makeIpc(
  state: EditorStateDto,
  cachedAccessories?: unknown[],
  previewResult?: PreviewResultDto,
  composeResult?: unknown,
): HomebridgeIpc & {
  requests: Array<{ path: string; body: unknown }>;
  persisted: Array<{ event: string; arg?: unknown }>;
} {
  const requests: Array<{ path: string; body: unknown }> = [];
  const persisted: Array<{ event: string; arg?: unknown }> = [];
  // WITHOUT composeResult the fake has NO updatePluginConfig /
  // savePluginConfig: preview-only flows must never need them.
  return {
    requests,
    persisted,
    getPluginConfig: async () => [{ platform: 'AmbientWeatherSensors' }],
    ...(cachedAccessories !== undefined
      ? { getCachedAccessories: async () => cachedAccessories }
      : {}),
    ...(composeResult !== undefined
      ? {
        updatePluginConfig: async (arg: unknown[]) => {
          persisted.push({ event: 'update', arg });
        },
        savePluginConfig: async () => {
          persisted.push({ event: 'save' });
        },
      }
      : {}),
    request: async (path: string, body?: unknown) => {
      requests.push({ path, body });
      if (path === '/editor-state') {
        return state;
      }
      if (path === '/vocabulary') {
        return VOCAB;
      }
      if (path === '/preview-save' && previewResult !== undefined) {
        return previewResult;
      }
      if (path === '/compose-save' && composeResult !== undefined) {
        return composeResult;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

afterEach(() => {
  TestBed.resetTestingModule();
  document.body.className = '';
});

async function render(ipc: HomebridgeIpc | undefined): Promise<ComponentFixture<AwnRootComponent>> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: HOMEBRIDGE_IPC, useValue: ipc },
    ],
  });
  const fixture = TestBed.createComponent(AwnRootComponent);
  fixture.detectChanges();
  // Let the component's async load settle (two request round-trips).
  await new Promise((r) => setTimeout(r, 0));
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('AwnRootComponent (TestBed, jsdom)', () => {
  it('renders the no-bridge fallback outside HB UI X', async () => {
    const fixture = await render(undefined);
    const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('running outside Homebridge UI X');
    expect(fixture.nativeElement.querySelectorAll('table')).toHaveLength(0);
  });

  it('loads via the bridge and renders rows grouped by station with vocabulary labels', async () => {
    const ipc = makeIpc(editorState());
    const fixture = await render(ipc);
    const el = fixture.nativeElement as HTMLElement;
    const headings = [...el.querySelectorAll('h3')].map(h => h.textContent!.trim());
    expect(headings.some(h => h.startsWith('Roof'))).toBe(true);
    expect(el.querySelectorAll('table')).toHaveLength(2);
    const text = el.textContent!;
    expect(text).toContain('°F');               // vocabulary label, not the unit code
    expect(text).toContain('mph → ft/sec');     // source → display conversion
    expect(text).toContain('battout');
    expect(ipc.requests.map(r => r.path).sort()).toEqual(['/editor-state', '/vocabulary']);
  });

  it('passes cached-accessory uniqueIds to /editor-state (§8.7 source 3)', async () => {
    const ipc = makeIpc(editorState(), [
      { context: { device: { uniqueId: `${MAC}-tempf` } } },
      { context: { device: { uniqueId: `${MAC}-windspeedmph` } } },
      { context: {} },            // accessory without a device — skipped
      { somethingElse: true },    // foreign accessory shape — skipped
    ]);
    await render(ipc);
    const req = ipc.requests.find(r => r.path === '/editor-state');
    expect(req?.body).toEqual({
      cachedAccessoryUniqueIds: [`${MAC}-tempf`, `${MAC}-windspeedmph`],
    });
  });

  it('shows the POSITIVE rollback-mirror indicator when the mirror is recognized (review #45 round 4)', async () => {
    const verified = await render(makeIpc(editorState()));
    expect((verified.nativeElement as HTMLElement).textContent).toContain('Rollback mirror: verified');
  });

  it('warns against the marker-deletion rollback for any non-recognized mirror state', async () => {
    const absent = await render(makeIpc(editorState({ mirrorState: 'absent' })));
    const text = (absent.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('Rollback mirror: absent');
    expect(text).toContain('Do NOT use the marker-deletion rollback');
    expect(text).not.toContain('Rollback mirror: verified');
  });

  it('renders duplicate diagnostics as separate banners (index-tracked)', async () => {
    const dup = { severity: 'warning' as const, code: 'row-warning', message: 'Same message twice.' };
    const ipc = makeIpc(editorState({ warnings: [dup, { ...dup }] }));
    const fixture = await render(ipc);
    const banners = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.banner')]
      .filter(b => b.textContent!.includes('Same message twice.'));
    expect(banners).toHaveLength(2);
  });

  it('renders ownership notes in a distinct Notes section', async () => {
    const ipc = makeIpc(editorState({
      notes: [{
        severity: 'note',
        code: 'orphan-battery-field',
        message: "'co2_in_aqin' is disabled, but it is the reserved owner of batteryField 'batt_co2'.",
        source: 'override',
        stationMac: MAC,
      }],
    }));
    const fixture = await render(ipc);
    const el = fixture.nativeElement as HTMLElement;
    const headings = [...el.querySelectorAll('h3')].map(h => h.textContent!.trim());
    expect(headings).toContain('Notes');
    const noteBanner = [...el.querySelectorAll('.banner.info')]
      .find(b => b.textContent!.includes('batt_co2'));
    expect(noteBanner).toBeDefined();
  });

  it('renders a load-failure banner when the bridge request rejects', async () => {
    const ipc: HomebridgeIpc = {
      getPluginConfig: async () => [{}],
      request: async () => {
        throw new Error('bridge exploded');
      },
    };
    const fixture = await render(ipc);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('bridge exploded');
  });
});

describe('draft editing + preview (PR B — no persistence)', () => {
  async function settle(fixture: ComponentFixture<AwnRootComponent>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Expand the edit form on the row whose Data point cell shows `dp`. */
  function openEditor(fixture: ComponentFixture<AwnRootComponent>, dp: string): HTMLElement {
    const el = fixture.nativeElement as HTMLElement;
    const tr = [...el.querySelectorAll('tbody tr')]
      .find(r => r.querySelector('td code')?.textContent === dp)!;
    (tr.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    return el;
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  const PREVIEW_OK: PreviewResultDto = {
    ok: true,
    canonicalSensorMap: [],
    rows: [],
    changes: [
      {
        stationMac: OTHER_MAC, dataPoint: 'tempinf', change: 'modified', structural: false,
        before: editorState().rows[2],
        after: { ...editorState().rows[2], name: 'Patio Temp' },
      },
      {
        stationMac: MAC, dataPoint: 'customx', change: 'added', structural: true,
        after: { ...editorState().rows[0], dataPoint: 'customx' },
      },
    ],
    structuralChangeCount: 1,
    digest: 'ab'.repeat(32),
    warnings: [],
    notes: [],
  };

  it('drafting a rename shows the dirty bar and sends the exact station-scoped proposal', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf'); // origin 'default' → new station fragment

    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    expect(el.textContent).toContain('1 draft change.');

    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);

    const req = ipc.requests.find(r => r.path === '/preview-save');
    expect(req?.body).toEqual({
      // The session token from /editor-state — NEVER a block copy from
      // getPluginConfig() (beta.13 smoke F1: HB UI X returns the
      // schema form's mutated config, which cannot byte-match disk).
      baseDigest: 'digest-live',
      proposal: [{ dataPoint: 'tempinf', stationMac: OTHER_MAC, name: 'Patio Temp' }],
      cachedAccessoryUniqueIds: [],
    });
  });

  it('renders the preview diff with structural chips and the re-register banner', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);

    expect(el.querySelector('.change-kind.modified')).not.toBeNull();
    expect(el.querySelector('.change-kind.added')).not.toBeNull();
    // Structural chips must not merely be attribute-hidden (an
    // explicit CSS display defeats [hidden] — caught in the browser
    // smoke): non-structural changes render NO chip element at all.
    expect(el.querySelectorAll('.structural-chip')).toHaveLength(1);
    // The chip names what the accessory DOES (review #43 P1-1):
    // 'added' registers — never a blanket "re-registers".
    expect(el.querySelector('.structural-chip')?.textContent).toBe('registers');
    expect(el.textContent).toContain('1 accessory would register, deregister, or re-register on save');
    expect(el.textContent).toContain('This preview wrote nothing; saving will ask for confirmation first.');
  });

  it('renders a structured refusal', async () => {
    const refusal: PreviewResultDto = {
      ok: false,
      error: { code: 'stale-base', message: 'The configuration changed since this editor session loaded.' },
    };
    const ipc = makeIpc(editorState(), [], refusal);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'X Y');
    await settle(fixture);
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.textContent).toContain('Preview refused (stale-base)');
  });

  it('discard clears drafts and the shown preview', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.querySelector('.change-kind')).not.toBeNull();

    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Discard drafts') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.textContent).toContain('No draft changes.');
    expect(el.querySelector('.change-kind')).toBeNull();
  });

  it('reverting every control clears its draft (review #43 P1-3)', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'windspeedmph'); // motion row: all controls
    const dirty = (): boolean => el.textContent!.includes('draft change.');

    // enabled: original false → toggle on → dirty → toggle off → clean
    const checkbox = el.querySelector('.editor-form input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await settle(fixture);
    expect(dirty()).toBe(true);
    checkbox.click();
    await settle(fixture);
    expect(dirty()).toBe(false);

    // name: 'Wind' → 'Gale' → dirty → back to 'Wind' → clean
    const name = el.querySelector('.editor-form input[type="text"]') as HTMLInputElement;
    typeInto(name, 'Gale');
    await settle(fixture);
    expect(dirty()).toBe(true);
    typeInto(name, 'Wind');
    await settle(fixture);
    expect(dirty()).toBe(false);

    // displayUnit: 'fps' → 'mph' → dirty → back → clean
    const unit = el.querySelector('.editor-form select') as HTMLSelectElement;
    unit.value = 'mph';
    unit.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(dirty()).toBe(true);
    unit.value = 'fps';
    unit.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(dirty()).toBe(false);

    // threshold: 10 → 25 → dirty → back to 10 → clean
    const threshold = el.querySelector('.editor-form input[type="number"]') as HTMLInputElement;
    typeInto(threshold, '25');
    await settle(fixture);
    expect(dirty()).toBe(true);
    typeInto(threshold, '10');
    await settle(fixture);
    expect(dirty()).toBe(false);

    // triggerDirection: 'above' → 'below' → dirty → back → clean
    const direction = [...el.querySelectorAll('.editor-form select')][1] as HTMLSelectElement;
    direction.value = 'below';
    direction.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(dirty()).toBe(true);
    direction.value = 'above';
    direction.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(dirty()).toBe(false);
  });

  it('a blanked NAME is an invalid form state: error shown, Preview blocked, proposal never diverges (review #43 round 2)', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'windspeedmph');

    // Make another field dirty, then blank the name.
    const checkbox = el.querySelector('.editor-form input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await settle(fixture);
    const name = el.querySelector('.editor-form input[type="text"]') as HTMLInputElement;
    typeInto(name, '');
    await settle(fixture);

    expect(el.textContent).toContain('Name is required');
    const previewBtn = [...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
    previewBtn.click(); // disabled — must not fire
    await settle(fixture);
    expect(ipc.requests.some(r => r.path === '/preview-save')).toBe(false);

    // Restore the name: error clears, Preview unblocks, and the
    // submitted proposal carries ONLY the enabled change — no stale
    // name draft from the blank interlude.
    typeInto(name, 'Wind');
    await settle(fixture);
    expect(el.textContent).not.toContain('Name is required');
    expect(previewBtn.disabled).toBe(false);
    previewBtn.click();
    await settle(fixture);
    const req = ipc.requests.find(r => r.path === '/preview-save');
    expect(req?.body).toMatchObject({
      proposal: [{ dataPoint: 'windspeedmph', stationMac: MAC, enabled: true }],
    });
  });

  it('a blanked THRESHOLD on a row that displays one blocks Preview until restored', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'windspeedmph'); // threshold: 10
    const checkbox = el.querySelector('.editor-form input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await settle(fixture);

    const threshold = el.querySelector('.editor-form input[type="number"]') as HTMLInputElement;
    typeInto(threshold, '');
    await settle(fixture);
    expect(el.textContent).toContain('Threshold is required');
    const previewBtn = [...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);

    typeInto(threshold, '10');
    await settle(fixture);
    expect(el.textContent).not.toContain('Threshold is required');
    expect(previewBtn.disabled).toBe(false);
  });

  it('closing an invalid form unblocks Preview (the blank state is gone with the form)', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'windspeedmph');
    const checkbox = el.querySelector('.editor-form input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    await settle(fixture);
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, '');
    await settle(fixture);

    // Close the form while invalid: the blanked control disappears,
    // its draft was already cleared, and Preview reflects the
    // remaining (valid) drafts only.
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Close') as HTMLButtonElement).click();
    await settle(fixture);
    const previewBtn = [...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(false);
    previewBtn.click();
    await settle(fixture);
    const req = ipc.requests.find(r => r.path === '/preview-save');
    expect(req?.body).toMatchObject({
      proposal: [{ dataPoint: 'windspeedmph', stationMac: MAC, enabled: true }],
    });
  });

  it('Reset row closes the form so a later event cannot resurrect the edits', async () => {
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    expect(el.textContent).toContain('1 draft change.');

    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Reset row') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.textContent).toContain('No draft changes.');
    expect(el.querySelector('.editor-form')).toBeNull(); // form is closed
  });

  it('a stale in-flight preview never overwrites a newer draft (review #43 P2-4)', async () => {
    let resolvePreview!: (v: PreviewResultDto) => void;
    const requests: Array<{ path: string; body: unknown }> = [];
    const ipc: HomebridgeIpc & { requests: typeof requests } = {
      requests,
      getPluginConfig: async () => [{}],
      getCachedAccessories: async () => [],
      request: async (path: string, body?: unknown) => {
        requests.push({ path, body });
        if (path === '/editor-state') {
          return editorState();
        }
        if (path === '/vocabulary') {
          return VOCAB;
        }
        // Deferred: resolves only when the test says so.
        return new Promise((r) => {
          resolvePreview = r as (v: PreviewResultDto) => void;
        });
      },
    };
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);

    // Edit AGAIN while the request is in flight...
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Newer Name');
    await settle(fixture);
    // ...then the OLD response arrives. It must be discarded.
    resolvePreview(PREVIEW_OK);
    await settle(fixture);
    expect(el.querySelector('.change-kind')).toBeNull();
    expect(el.textContent).not.toContain('accessory would register');
  });

  it('renders proposal-specific notes from the preview (review #43 P2-5)', async () => {
    const withNotes: PreviewResultDto = {
      ...PREVIEW_OK,
      notes: [{
        severity: 'note', code: 'orphan-battery-field', source: 'override',
        message: "'co2_in_aqin' is disabled, but it is the reserved owner of batteryField 'batt_co2'.",
      }],
    };
    const ipc = makeIpc(editorState(), [], withNotes);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);

    const headings = [...el.querySelectorAll('h3')].map(h => h.textContent!.trim());
    expect(headings).toContain('Preview notes');
    expect([...el.querySelectorAll('.banner.info')].some(b => b.textContent!.includes('batt_co2'))).toBe(true);
  });

  it('NEVER persists: the whole edit/preview flow touches only read + preview endpoints', async () => {
    // The fake bridge does not even implement updatePluginConfig /
    // savePluginConfig — if the component tried to persist, it would
    // throw. Additionally: every request it made is on the allowlist.
    const ipc = makeIpc(editorState(), [], PREVIEW_OK);
    const fixture = await render(ipc);
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    ([...el.querySelectorAll('button')].find(b => b.textContent === 'Preview changes') as HTMLButtonElement).click();
    await settle(fixture);

    const paths = new Set(ipc.requests.map(r => r.path));
    expect([...paths].sort()).toEqual(['/editor-state', '/preview-save', '/vocabulary']);
    expect('updatePluginConfig' in ipc).toBe(false);
    expect('savePluginConfig' in ipc).toBe(false);
  });
});

describe('save flow (PR C / finding 5 — the ONE route is composeAndPersist)', () => {
  async function settle(fixture: ComponentFixture<AwnRootComponent>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }
  function openEditor(fixture: ComponentFixture<AwnRootComponent>, dp: string): HTMLElement {
    const el = fixture.nativeElement as HTMLElement;
    const tr = [...el.querySelectorAll('tbody tr')]
      .find(r => r.querySelector('td code')?.textContent === dp)!;
    (tr.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    return el;
  }
  function typeInto(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  const btn = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;

  const NON_STRUCTURAL_PREVIEW: PreviewResultDto = {
    ok: true, canonicalSensorMap: [], rows: [],
    changes: [{
      stationMac: OTHER_MAC, dataPoint: 'tempinf', change: 'modified', structural: false,
      before: editorState().rows[2], after: { ...editorState().rows[2], name: 'Patio Temp' },
    }],
    structuralChangeCount: 0, digest: 'cd'.repeat(32), warnings: [], notes: [],
  };
  const STRUCTURAL_PREVIEW: PreviewResultDto = {
    ...NON_STRUCTURAL_PREVIEW,
    changes: [{
      stationMac: OTHER_MAC, dataPoint: 'tempinf', change: 'removed', structural: true,
      before: editorState().rows[2],
    }],
    structuralChangeCount: 1, digest: 'ef'.repeat(32),
  };
  const NEXT_CONFIG = {
    platform: 'AmbientWeatherSensors', configVersion: 2,
    sensorMap: [{ dataPoint: 'tempinf', stationMac: OTHER_MAC, name: 'Patio Temp' }],
    _legacyMirror: { version: 1, hash: 'x' },
  };
  const COMPOSE_OK = {
    ok: true, nextConfig: NEXT_CONFIG, snapshot: 'written',
    // Matches the fixture editor-state's baseDigest: the post-save
    // reload sees exactly what compose produced (no drift).
    nextConfigDigest: 'digest-live',
    canonicalSensorMap: [], warnings: [], notes: [],
  };

  async function draftAndPreview(fixture: ComponentFixture<AwnRootComponent>): Promise<HTMLElement> {
    const el = openEditor(fixture, 'tempinf');
    typeInto(el.querySelector('.editor-form input[type="text"]') as HTMLInputElement, 'Patio Temp');
    await settle(fixture);
    btn(el, 'Preview changes')!.click();
    await settle(fixture);
    return el;
  }

  it('a non-structural save persists verbatim through update → save with the preview digest', async () => {
    const ipc = makeIpc(editorState(), [], NON_STRUCTURAL_PREVIEW, COMPOSE_OK);
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);

    btn(el, 'Save changes')!.click();
    await settle(fixture);

    const compose = ipc.requests.find(r => r.path === '/compose-save');
    expect((compose?.body as { confirmDigest?: string }).confirmDigest).toBe('cd'.repeat(32));
    // The session token travels; the mutable getPluginConfig block
    // does NOT (beta.13 smoke F1).
    expect((compose?.body as { baseDigest?: string }).baseDigest).toBe('digest-live');
    expect((compose?.body as { base?: unknown }).base).toBeUndefined();
    // The in-memory block travels as formBlock so the server can refuse
    // when the settings form holds unsaved changes (review #47 P1-1).
    expect((compose?.body as { formBlock?: unknown }).formBlock).toEqual({ platform: 'AmbientWeatherSensors' });
    expect(ipc.persisted.map(p => p.event)).toEqual(['update', 'update', 'save']);
    // Verbatim replacement: the FIRST update clears HB UI X's
    // merge-prone in-memory copy; the second carries the composed block.
    expect(ipc.persisted[0].arg).toEqual([]);
    const updated = (ipc.persisted[1].arg as unknown[])[0];
    expect(updated).toEqual(NEXT_CONFIG);
    expect(el.textContent).toContain('Saved.');
    expect(el.textContent).toContain('legacy-config-snapshot.json');
    // Receipt clean: reloaded digest equals what compose produced.
    expect(el.textContent).not.toContain('does not exactly match');
  });

  it('a post-save digest mismatch surfaces the drift warning (receipt check)', async () => {
    const ipc = makeIpc(editorState(), [], NON_STRUCTURAL_PREVIEW, {
      ...COMPOSE_OK,
      nextConfigDigest: 'digest-composed-elsewhere',
    });
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);
    btn(el, 'Save changes')!.click();
    await settle(fixture);
    expect(el.textContent).toContain('Saved.');
    expect(el.textContent).toContain('does not exactly match');
  });

  it('a structural save opens the confirmation modal; Cancel persists NOTHING', async () => {
    const ipc = makeIpc(editorState(), [], STRUCTURAL_PREVIEW, COMPOSE_OK);
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);

    btn(el, 'Save changes')!.click();
    await settle(fixture);
    expect(el.querySelector('.modal')).not.toBeNull();
    expect(el.textContent).toContain('Confirm registration changes');

    btn(el, 'Cancel')!.click();
    await settle(fixture);
    expect(el.querySelector('.modal')).toBeNull();
    expect(ipc.requests.some(r => r.path === '/compose-save')).toBe(false);
    expect(ipc.persisted).toEqual([]);
  });

  it('Confirm save sends the digest and persists', async () => {
    const ipc = makeIpc(editorState(), [], STRUCTURAL_PREVIEW, COMPOSE_OK);
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);
    btn(el, 'Save changes')!.click();
    await settle(fixture);
    btn(el, 'Confirm save')!.click();
    await settle(fixture);

    const compose = ipc.requests.find(r => r.path === '/compose-save');
    expect((compose?.body as { confirmDigest?: string }).confirmDigest).toBe('ef'.repeat(32));
    expect(ipc.persisted.map(p => p.event)).toEqual(['update', 'update', 'save']);
    expect(el.querySelector('.modal')).toBeNull();
  });

  it('a compose refusal persists NOTHING and renders the structured refusal', async () => {
    const refusal = {
      ok: false,
      error: { code: 'stale-confirmation', message: 'The configuration changed since this save was previewed.' },
    };
    const ipc = makeIpc(editorState(), [], NON_STRUCTURAL_PREVIEW, refusal);
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);
    btn(el, 'Save changes')!.click();
    await settle(fixture);

    expect(ipc.persisted).toEqual([]);
    // The banner renders the structured message verbatim — the
    // component never adds its own "nothing was written" claim
    // (review #45 P1-2: indeterminate failures must not be assured).
    expect(el.textContent).toContain('Save failed (stale-confirmation)');
  });

  it('editing is LOCKED while a save is in flight (review #45 P2-4)', async () => {
    let resolveCompose!: (v: unknown) => void;
    const requests: Array<{ path: string; body: unknown }> = [];
    const persisted: string[] = [];
    const ipc: HomebridgeIpc & { requests: typeof requests } = {
      requests,
      getPluginConfig: async () => [{ platform: 'AmbientWeatherSensors' }],
      getCachedAccessories: async () => [],
      updatePluginConfig: async () => {
        persisted.push('update');
      },
      savePluginConfig: async () => {
        persisted.push('save');
      },
      request: async (path: string, body?: unknown) => {
        requests.push({ path, body });
        if (path === '/editor-state') {
          return editorState();
        }
        if (path === '/vocabulary') {
          return VOCAB;
        }
        if (path === '/preview-save') {
          return NON_STRUCTURAL_PREVIEW;
        }
        return new Promise((r) => {
          resolveCompose = r; // /compose-save: resolves when the test says
        });
      },
    };
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);
    btn(el, 'Save changes')!.click();
    // Flush microtasks only (no whenStable — the compose promise is
    // deliberately pending) so the async chain reaches /compose-save.
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    // The open form is closed and every draft control disables — a
    // slow save cannot race a newer draft into the post-save discard.
    expect(el.querySelector('.editor-form')).toBeNull();
    for (const b of [...el.querySelectorAll('button')].filter(x => x.textContent === 'Edit')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }

    resolveCompose(COMPOSE_OK);
    await settle(fixture);
    expect(el.textContent).toContain('Saved.');
    expect(persisted).toEqual(['update', 'update', 'save']);
    for (const b of [...el.querySelectorAll('button')].filter(x => x.textContent === 'Edit')) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('a persistence failure renders as INDETERMINATE, never as nothing-was-written (review #45 P1-2)', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const ipc: HomebridgeIpc & { requests: typeof requests } = {
      requests,
      getPluginConfig: async () => [{ platform: 'AmbientWeatherSensors' }],
      getCachedAccessories: async () => [],
      updatePluginConfig: async () => {
        throw new Error('ipc channel dropped');
      },
      savePluginConfig: async () => undefined,
      request: async (path: string, body?: unknown) => {
        requests.push({ path, body });
        if (path === '/editor-state') {
          return editorState();
        }
        if (path === '/vocabulary') {
          return VOCAB;
        }
        if (path === '/preview-save') {
          return NON_STRUCTURAL_PREVIEW;
        }
        return COMPOSE_OK;
      },
    };
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);
    btn(el, 'Save changes')!.click();
    await settle(fixture);

    expect(el.textContent).toContain('Save failed (persistence-indeterminate)');
    expect(el.textContent).toContain('reload the plugin settings');
    expect(el.textContent).not.toContain('Nothing was written');

    // Terminal until reload (review #45 round 2): every editor action
    // locks — no blind retry with stale drafts against a config that
    // may already have changed — and a reload path is offered.
    expect(el.textContent).toContain('Editing is locked until this page is reloaded');
    expect([...el.querySelectorAll('button')].some(b => b.textContent === 'Reload now')).toBe(true);
    for (const b of [...el.querySelectorAll('button')].filter(x => x.textContent === 'Edit')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    const save = [...el.querySelectorAll('button')].find(b => b.textContent === 'Save changes');
    if (save) {
      expect((save as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('no Save button when the server says the editor is unavailable', async () => {
    const ipc = makeIpc(editorState({ editorAvailable: false }), [], NON_STRUCTURAL_PREVIEW, COMPOSE_OK);
    const fixture = await render(ipc);
    const el = await draftAndPreview(fixture);
    expect(btn(el, 'Save changes')).toBeUndefined();
  });
});

describe('parent theme synchronization', () => {
  it('mirrors theme classes both directions, leaving non-theme classes alone', () => {
    const parent = document.createElement('body');
    const own = document.createElement('body');
    own.className = 'modal-content my-app-class';
    parent.className = 'config-ui-x-dark dark-mode some-parent-junk';

    syncThemeClasses(parent.classList, own.classList);
    expect(own.classList.contains('dark-mode')).toBe(true);
    expect(own.classList.contains('config-ui-x-dark')).toBe(true);
    expect(own.classList.contains('some-parent-junk')).toBe(false); // non-theme parent class not copied
    expect(own.classList.contains('my-app-class')).toBe(true);      // own non-theme class untouched

    // dark → light: the REMOVAL half add-only handlers lack.
    parent.className = 'config-ui-x-light some-parent-junk';
    syncThemeClasses(parent.classList, own.classList);
    expect(own.classList.contains('dark-mode')).toBe(false);
    expect(own.classList.contains('config-ui-x-dark')).toBe(false);
    expect(own.classList.contains('config-ui-x-light')).toBe(true);
    expect(own.classList.contains('my-app-class')).toBe(true);
  });

  it('observeParentTheme follows live dark → light → dark switches', async () => {
    const parent = document.createElement('div');
    const own = document.createElement('div');
    parent.className = 'config-ui-x-dark dark-mode';
    const observer = observeParentTheme(parent, own);
    try {
      // Initial sync is immediate.
      expect(own.classList.contains('dark-mode')).toBe(true);

      parent.classList.remove('dark-mode', 'config-ui-x-dark');
      parent.classList.add('config-ui-x-light');
      await vi.waitFor(() => {
        expect(own.classList.contains('dark-mode')).toBe(false);
        expect(own.classList.contains('config-ui-x-light')).toBe(true);
      });

      parent.classList.add('dark-mode', 'config-ui-x-dark');
      parent.classList.remove('config-ui-x-light');
      await vi.waitFor(() => {
        expect(own.classList.contains('dark-mode')).toBe(true);
        expect(own.classList.contains('config-ui-x-light')).toBe(false);
      });
    } finally {
      observer.disconnect();
    }
  });
});

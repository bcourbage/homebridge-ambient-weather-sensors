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
import type { EditorStateDto, VocabularyDto } from '../../../../homebridge-ui/app-src/dto/editor-state';

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
    editorAvailable: false,
    version: 'test',
    stations: [
      { mac: MAC, name: 'Roof', source: 'discovery' },
      { mac: OTHER_MAC, source: 'override' },
    ],
    authored: [],
    authoredSource: 'sensorMap',
    rows: [
      {
        stationMac: MAC, dataPoint: 'tempf', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'fahrenheit', name: 'Outdoor Temp', enabled: true, batteryField: 'battout',
        origin: 'global',
      },
      {
        stationMac: MAC, dataPoint: 'windspeedmph', kind: 'wind', measurement: 'wind-speed',
        sourceUnit: 'mph', displayUnit: 'fps', name: 'Wind', enabled: false, batteryField: null,
        origin: 'station',
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

function makeIpc(state: EditorStateDto, cachedAccessories?: unknown[]): HomebridgeIpc & { requests: Array<{ path: string; body: unknown }> } {
  const requests: Array<{ path: string; body: unknown }> = [];
  return {
    requests,
    getPluginConfig: async () => [{}],
    ...(cachedAccessories !== undefined
      ? { getCachedAccessories: async () => cachedAccessories }
      : {}),
    request: async (path: string, body?: unknown) => {
      requests.push({ path, body });
      if (path === '/editor-state') {
        return state;
      }
      if (path === '/vocabulary') {
        return VOCAB;
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
    const headings = [...el.querySelectorAll('h2')].map(h => h.textContent!.trim());
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
    const headings = [...el.querySelectorAll('h2')].map(h => h.textContent!.trim());
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

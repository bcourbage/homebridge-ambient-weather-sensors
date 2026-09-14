/**
 * Downgrade safety against the REAL published 1.7.3 (§5 — the second
 * half of the GA migration gate).
 *
 * Every prior downgrade test simulated the 1.7 side with HEAD's own
 * flag-off pipeline, resting on the ASSERTED (never executed) claim
 * that Stage 4 kept it byte-identical to the v1.7 registration
 * pipeline. This suite executes the actual npm-published 1.7.3
 * (devDependency alias `awn-v1-7-3`, imported by file path because its
 * exports map only exposes the plugin entry) in-process, against the
 * same real-HAP lifecycle harness, and proves:
 *
 *   1. GUARD: 1.7.3 freezes on a v2-marked config emitted by HEAD's
 *      composeV2ConfigSave — no fetch, no registrations, no
 *      unregistrations, cache preserved.
 *   2. ROLLBACK EQUIVALENCE: after the documented marker-key deletion,
 *      real 1.7.3 and HEAD's flag-off path produce IDENTICAL real HAP
 *      graphs over the whole shared corpus (synthetic + Demeter
 *      baselines) — the "byte-identical" claim, executed; and with it
 *      §5's property that 1.7 registers exactly the v1.7-representable
 *      set the mirror encodes.
 *   3. CUSTOM-ROW LOSS BOUNDARY: a converted map carrying a custom
 *      dataPoint rolls back to a mirror whose exclusions defeat
 *      1.7.3's broad matchers — the custom row is dropped, never
 *      misregistered as a wrong wrapper.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { canonicalizeSensorMap } from '../../src/sensorMap/canonicalizeSensorMap';
import { compatToOverrides } from '../../src/sensorMap/compat';
import { buildEffectiveSensorMap } from '../../src/sensorMap/buildEffectiveMap';
import { composeV2ConfigSave } from '../../src/sensorMap/legacyMirror';
import { emptyDiscoveryStore } from '../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../src/sensorMap/persistence/uiStateStore';
import { convertedConfigFor, documentedRollback, inventoryOf } from '../helpers/conversion';
import {
  HapMockAPI,
  serializeRegistered,
  type SerializedAccessory,
} from '../helpers/hapLifecycle';
import {
  CONFIG_MATRIX,
  OUTDOOR_STATION,
  AQIN_STATION,
  LIGHTNING_STATION,
  demeterBaselines,
  type RawStation,
} from '../helpers/legacyConfigCorpus';
import { MockLogger } from '../helpers/mockHomebridge';

// Real published 1.7.3, by file path (the exports map exposes only the
// plugin entry point). The cast is deliberate: 1.7.3's own types are
// not part of HEAD's compilation.
import { AmbientWeatherSensorsPlatform as Platform173 } from '../../node_modules/awn-v1-7-3/dist/platform.js';

type PlatformCtor = new (log: never, config: never, api: never) => unknown;

afterEach(() => {
  vi.restoreAllMocks();
});

const ALL_STATIONS = [OUTDOOR_STATION, AQIN_STATION, LIGHTNING_STATION];

async function runLifecycleWith(
  Ctor: PlatformCtor,
  config: Record<string, unknown>,
  stations: RawStation[],
): Promise<{ accessories: SerializedAccessory[]; unregisteredCount: number; log: MockLogger }> {
  const api = new HapMockAPI();
  const log = new MockLogger();
  vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify(stations),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

  new Ctor(
    log as never,
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', ...config } as never,
    api as never,
  );
  api.emit('didFinishLaunching');
  // Both 1.7.3's pipeline and HEAD's end by logging `Data source:`.
  await vi.waitFor(() => {
    expect(log.logs.some(l => l.message.startsWith('Data source:'))).toBe(true);
  }, { timeout: 10000 });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
  vi.restoreAllMocks();
  return { accessories: serializeRegistered(api), unregisteredCount: api.unregistered.length, log };
}

describe('real 1.7.3 guard: HEAD-emitted v2 config freezes the plugin', () => {
  it('no fetch, no registrations, no unregistrations, guard error logged', async () => {
    const fullHouse = CONFIG_MATRIX.find(c => c.label === 'full house — every category')!;
    const converted = convertedConfigFor(fullHouse.config, ALL_STATIONS);

    const api = new HapMockAPI();
    const log = new MockLogger();
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('[]'));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    new (Platform173 as unknown as PlatformCtor)(
      log as never,
      { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', ...converted } as never,
      api as never,
    );
    api.emit('didFinishLaunching');
    await vi.waitFor(() => {
      expect(log.logs.some(l => l.level === 'error' && /written by plugin version 2\.x/.test(l.message))).toBe(true);
    });
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.registered).toEqual([]);
    expect(api.unregistered).toEqual([]);
  });
});

describe('rollback equivalence — real 1.7.3 vs HEAD flag-off, full HAP graph, whole corpus', () => {
  for (const { label, config } of [...CONFIG_MATRIX, ...demeterBaselines()]) {
    it(`graphs match after documented rollback: ${label}`, async () => {
      const rolledBack = documentedRollback(convertedConfigFor(config, ALL_STATIONS));

      const head = await runLifecycleWith(
        AmbientWeatherSensorsPlatform as unknown as PlatformCtor, rolledBack, ALL_STATIONS,
      );
      const v173 = await runLifecycleWith(
        Platform173 as unknown as PlatformCtor, rolledBack, ALL_STATIONS,
      );

      expect(head.unregisteredCount).toBe(0);
      expect(v173.unregisteredCount).toBe(0);
      expect(v173.accessories.map(a => a.uniqueId))
        .toEqual(head.accessories.map(a => a.uniqueId));
      for (let i = 0; i < head.accessories.length; i++) {
        const h = head.accessories[i];
        const o = v173.accessories[i];
        expect(o.displayName, `${h.uniqueId} displayName`).toBe(h.displayName);
        expect(o.graph, `${h.uniqueId} graph`).toEqual(h.graph);
      }
    });
  }
});

describe('custom-row downgrade loss boundary on real 1.7.3', () => {
  it('the mirror exclusions defeat the broad matchers: barn_temp is dropped, never misregistered', async () => {
    const inventory = inventoryOf([OUTDOOR_STATION]);
    const legacy = { temperatureSensors: true, humiditySensors: true };
    const overrides = [
      ...compatToOverrides(legacy, inventory),
      {
        dataPoint: 'barn_temp', stationMac: OUTDOOR_STATION.macAddress,
        kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius',
        name: 'Barn Temp', enabled: true,
      },
    ];
    const canonical = canonicalizeSensorMap({
      overrides, stations: inventory,
      discovery: emptyDiscoveryStore(), uiState: emptyUiStateStore(),
    });
    const effectiveMap = buildEffectiveSensorMap({
      userOverrides: canonical, discovery: emptyDiscoveryStore(), uiState: emptyUiStateStore(),
      stations: inventory, configMode: 'v2',
    });
    expect(effectiveMap.errors).toEqual([]);
    const { nextConfig } = composeV2ConfigSave(
      { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', _sensorMapV2: true, ...legacy },
      canonical, effectiveMap, 'legacy',
    );
    const rolledBack = documentedRollback(nextConfig as Record<string, unknown>);

    const payload: RawStation = {
      ...OUTDOOR_STATION,
      lastData: { ...OUTDOOR_STATION.lastData, barn_temp: 21 },
    };
    const v173 = await runLifecycleWith(
      Platform173 as unknown as PlatformCtor, rolledBack, [payload],
    );
    const ids = v173.accessories.map(a => a.uniqueId);
    expect(ids).not.toContain(`${OUTDOOR_STATION.macAddress}-barn_temp`);
    expect(ids).toContain(`${OUTDOOR_STATION.macAddress}-tempf`);
    expect(ids).toContain(`${OUTDOOR_STATION.macAddress}-humidity`);
    expect(v173.unregisteredCount).toBe(0);
  });
});

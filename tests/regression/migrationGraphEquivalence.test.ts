/**
 * Migration equivalence at the FULL HAP GRAPH level (§12.7 — the GA
 * gate this file discharges).
 *
 * For every legacy config in the shared corpus (synthetic matrix +
 * the captured Demeter conversion baselines), the REAL platform
 * lifecycle runs twice against real @homebridge/hap-nodejs objects:
 *
 *   legacy path:    didFinishLaunching on the legacy config, flag off
 *   converted path: didFinishLaunching on composeV2ConfigSave's OUTPUT
 *                   for that same config (the byte-real conversion the
 *                   editor writes), flag on
 *
 * and the two runs must produce identical accessories: same uniqueId
 * set, same platform-composed display names, and per-accessory
 * byte-equal serialized graphs — services, subtypes, linked/optional
 * sets, and every characteristic's props and value
 * (AccessoryInformation.Name included). Because the payload seeds
 * initial values through each path's own construction, value equality
 * covers initial-value behavior, not just structure.
 *
 * This is the piece the row-level suite explicitly deferred
 * (migrationEquivalence.test.ts: "Full HAP-service-graph equivalence
 * ... lives on the v2.0.0 GA task list") and the piece graphParity
 * cannot see (it builds wrappers from DEFAULT rows with an empty
 * config — never a converted config, never the platform's naming).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { compatToOverrides, type LegacyConfig } from '../../src/sensorMap/compat';
import { buildEffectiveSensorMap } from '../../src/sensorMap/buildEffectiveMap';
import { canonicalizeSensorMap } from '../../src/sensorMap/canonicalizeSensorMap';
import { composeV2ConfigSave } from '../../src/sensorMap/legacyMirror';
import { emptyDiscoveryStore } from '../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../src/sensorMap/persistence/uiStateStore';
import type { StationInventory } from '../../src/sensorMap/types';
import {
  HapMockAPI,
  serializeRegistered,
  type SerializedAccessory,
} from '../helpers/hapLifecycle';
import {
  CONFIG_MATRIX,
  PAYLOAD_MATRIX,
  demeterBaselines,
  type RawStation,
} from '../helpers/legacyConfigCorpus';
import { MockLogger } from '../helpers/mockHomebridge';

afterEach(() => {
  vi.restoreAllMocks();
});

function inventoryOf(stations: RawStation[]): StationInventory {
  return stations.map(s => ({ macAddress: s.macAddress, name: s.info?.name ?? s.macAddress }));
}

/**
 * Run the real platform lifecycle over a config and an AWN payload,
 * against real HAP, and return the registered accessories serialized.
 * The poll timer is stubbed out; the single seeded fetch is the data
 * both paths construct from.
 */
async function runLifecycle(
  config: Record<string, unknown>,
  stations: RawStation[],
): Promise<{ accessories: SerializedAccessory[]; unregisteredCount: number }> {
  const api = new HapMockAPI();
  const log = new MockLogger();
  const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify(stations),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

  new AmbientWeatherSensorsPlatform(
    log as never,
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', ...config } as never,
    api as never,
  );
  api.emit('didFinishLaunching');
  // Zero-registration corpus entries are legitimate (empty config,
  // master toggle off), so completion cannot be "registered.length
  // grew" — and counting quiet event-loop ticks is unsound, because
  // the lifecycle's chain includes real filesystem writes whose
  // millisecond gaps dwarf a microsecond tick. The deterministic
  // terminal marker is the `Data source:` log line: both the legacy
  // and the v2 pipeline end by calling startDataSource(), which logs
  // it and then only arms the (stubbed) poll timer.
  void fetchSpy;
  await vi.waitFor(() => {
    expect(log.logs.some(l => l.message.startsWith('Data source:'))).toBe(true);
  }, { timeout: 10000 });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
  vi.restoreAllMocks();
  return { accessories: serializeRegistered(api), unregisteredCount: api.unregistered.length };
}

/**
 * The byte-real conversion: exactly what the guarded save pipeline
 * writes for this legacy config — compat translation, canonical
 * sensorMap, legacy mirror, configVersion 2 — with the v2 flag on
 * (the editor requires the flag before it may convert).
 */
function convertedConfigFor(config: LegacyConfig, stations: RawStation[]): Record<string, unknown> {
  const inventory = inventoryOf(stations);
  const overrides = compatToOverrides(config, inventory);
  const canonical = canonicalizeSensorMap({
    overrides,
    stations: inventory,
    discovery: emptyDiscoveryStore(),
    uiState: emptyUiStateStore(),
  });
  const effectiveMap = buildEffectiveSensorMap({
    userOverrides: canonical,
    discovery: emptyDiscoveryStore(),
    uiState: emptyUiStateStore(),
    stations: inventory,
    configMode: 'v2',
  });
  expect(effectiveMap.errors).toEqual([]);
  const { nextConfig } = composeV2ConfigSave(
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', _sensorMapV2: true, ...config },
    canonical,
    effectiveMap,
    'legacy',
  );
  return nextConfig as Record<string, unknown>;
}

const CORPUS = [...CONFIG_MATRIX, ...demeterBaselines()];

/**
 * ACCEPTED graph deviations, pinned exactly (label → the complete list
 * of characteristic-value differences allowed for that corpus entry).
 * The one accepted class: v1.6 formats extended values with the RAW
 * config unit string, so a malformed unit renders as garbage
 * ("NaN furlongs-per-fortnight"); conversion runs validation, which
 * warn-strips the illegal unit, so the converted row renders in the
 * documented default. Cleansing a broken config is a designed
 * improvement, not churn: same accessory, same structure, better
 * text. Anything beyond this exact list fails the gate.
 */
const ACCEPTED_VALUE_DEVIATIONS: Record<string, Array<{
  uniqueId: string; characteristic: string; legacy: unknown; converted: unknown;
}>> = {
  'malformed units shape (unknown unit falls back to plugin default)': [
    { uniqueId: 'AA:BB:CC:DD:EE:01-maxdailygust', characteristic: 'Value', legacy: 'NaN furlongs-per-fortnight', converted: '22 mph' },
    { uniqueId: 'AA:BB:CC:DD:EE:01-windgustmph', characteristic: 'Value', legacy: 'NaN furlongs-per-fortnight', converted: '12 mph' },
    { uniqueId: 'AA:BB:CC:DD:EE:01-windspeedmph', characteristic: 'Value', legacy: 'NaN furlongs-per-fortnight', converted: '8 mph' },
  ],
};

interface GraphValueDiff {
  uniqueId: string; characteristic: string; legacy: unknown; converted: unknown;
}

/**
 * Structural comparison with value-diff collection: returns the list
 * of characteristic-value differences between two accessories whose
 * graphs are otherwise required to be identical (any NON-value
 * difference throws the ordinary deep-equality failure).
 */
function valueDiffs(l: SerializedAccessory, c: SerializedAccessory): GraphValueDiff[] {
  const lg = l.graph as Array<{ uuid: string; subtype: string | null; characteristics: Array<Record<string, unknown>> }>;
  const cg = c.graph as typeof lg;
  const stripValues = (g: typeof lg): unknown =>
    g.map(svc => ({ ...svc, characteristics: svc.characteristics.map(({ value: _v, ...rest }) => rest) }));
  expect(stripValues(cg), `${l.uniqueId} graph structure`).toEqual(stripValues(lg));
  const out: GraphValueDiff[] = [];
  for (let s = 0; s < lg.length; s++) {
    for (let k = 0; k < lg[s].characteristics.length; k++) {
      const lc = lg[s].characteristics[k];
      const cc = cg[s].characteristics[k];
      if (JSON.stringify(lc.value) !== JSON.stringify(cc.value)) {
        out.push({
          uniqueId: l.uniqueId,
          characteristic: String(lc.name),
          legacy: lc.value,
          converted: cc.value,
        });
      }
    }
  }
  return out;
}

describe('migration equivalence — full HAP graph, legacy path vs converted path (§12.7)', () => {
  for (const { label: cfgLabel, config } of CORPUS) {
    for (const { label: payloadLabel, stations } of PAYLOAD_MATRIX) {
      it(`graphs match: ${cfgLabel} / ${payloadLabel}`, async () => {
        const legacy = await runLifecycle(config as Record<string, unknown>, stations);
        const converted = await runLifecycle(convertedConfigFor(config, stations), stations);

        // Fresh-start runs must never unregister anything.
        expect(legacy.unregisteredCount).toBe(0);
        expect(converted.unregisteredCount).toBe(0);

        // Same accessory universe...
        expect(converted.accessories.map(a => a.uniqueId))
          .toEqual(legacy.accessories.map(a => a.uniqueId));

        // ...and per accessory: same platform-composed name and a
        // byte-equal full HAP graph — except where a deviation is
        // pinned, in which case the COMPLETE set of value diffs must
        // equal the pinned list exactly.
        const allowed = ACCEPTED_VALUE_DEVIATIONS[cfgLabel] ?? [];
        const observed: GraphValueDiff[] = [];
        for (let i = 0; i < legacy.accessories.length; i++) {
          const l = legacy.accessories[i];
          const c = converted.accessories[i];
          expect(c.displayName, `${l.uniqueId} displayName`).toBe(l.displayName);
          if (allowed.length === 0) {
            expect(c.graph, `${l.uniqueId} graph`).toEqual(l.graph);
          } else {
            observed.push(...valueDiffs(l, c));
          }
        }
        if (allowed.length > 0) {
          const present = new Set(legacy.accessories.map(a => a.uniqueId));
          expect(observed).toEqual(allowed.filter(d => present.has(d.uniqueId)));
        }
      });
    }
  }
});

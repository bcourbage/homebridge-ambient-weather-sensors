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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { describe, expect, it, afterEach, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { convertedConfigFor } from '../helpers/conversion';
import {
  HapMockAPI,
  serializeRegistered,
  type HapLifecyclePlatformAccessory,
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

/**
 * Run the real platform lifecycle over a config and an AWN payload,
 * against real HAP, and return the registered accessories serialized.
 * The poll timer is stubbed out; the single seeded fetch is the data
 * both paths construct from.
 */
async function runLifecycle(
  config: Record<string, unknown>,
  stations: RawStation[],
  cached: HapLifecyclePlatformAccessory[] = [],
): Promise<{
  accessories: SerializedAccessory[];
  unregisteredCount: number;
  api: HapMockAPI;
  raw: HapLifecyclePlatformAccessory[];
  configBytesChanged: boolean;
}> {
  const api = new HapMockAPI();
  // A REAL config.json behind api.user.configPath, so an unsolicited
  // write by the lifecycle is detectable byte-for-byte.
  const cfgDir = mkdtempSync(nodePath.join(os.tmpdir(), 'awn-graph-cfg-'));
  const cfgFile = nodePath.join(cfgDir, 'config.json');
  const cfgBytes = JSON.stringify({ bridge: { name: 'T' }, platforms: [config] }, null, 4);
  writeFileSync(cfgFile, cfgBytes);
  (api.user as { configPath?: () => string }).configPath = () => cfgFile;
  const log = new MockLogger();
  const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify(stations),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

  const platform = new AmbientWeatherSensorsPlatform(
    log as never,
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', ...config } as never,
    api as never,
  );
  // Homebridge hands cached accessories to configureAccessory BEFORE
  // didFinishLaunching; the cached-upgrade journey does the same.
  for (const a of cached) {
    platform.configureAccessory(a as never);
  }
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
  const configBytesChanged = readFileSync(cfgFile, 'utf8') !== cfgBytes;
  rmSync(cfgDir, { recursive: true, force: true });
  return {
    accessories: serializeRegistered(api),
    unregisteredCount: api.unregistered.length,
    api,
    raw: api.registered,
    configBytesChanged,
  };
}

/** Serialize an arbitrary accessory list the same way serializeRegistered does. */
function serializeAccessories(list: HapLifecyclePlatformAccessory[]): SerializedAccessory[] {
  const api = new HapMockAPI();
  api.registered.push(...list);
  return serializeRegistered(api);
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
        // POST-FLIP (GA #65): the v1.6.0 pipeline is reachable only
        // through the explicit opt-out; that is the baseline this
        // equivalence gate measures against.
        const legacy = await runLifecycle({ ...(config as Record<string, unknown>), _sensorMapV2: false }, stations);
        const convertedCfg = convertedConfigFor(config, stations);
        const converted = await runLifecycle(convertedCfg, stations);

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

        // ---- Cached-upgrade journey (PR #59 review F1): the REAL
        // user path is not a fresh start — the v1.6 cache exists when
        // the converted config first boots. The legacy run's real HAP
        // accessories ARE that cache. The converted boot must restore
        // and reconcile them IN PLACE: zero registrations (a
        // replace-the-cache mutation fails here), zero
        // unregistrations (churn fails here), and the same objects
        // carry the same graphs afterward.
        const cachedBoot = await runLifecycle(convertedCfg, stations, legacy.raw);
        expect(cachedBoot.api.registered, 'cached boot registered').toEqual([]);
        expect(cachedBoot.api.unregistered, 'cached boot unregistered').toEqual([]);
        const reconciled = serializeAccessories(legacy.raw);
        expect(reconciled.map(a => a.uniqueId)).toEqual(converted.accessories.map(a => a.uniqueId));
        const cachedObserved: GraphValueDiff[] = [];
        for (let i = 0; i < converted.accessories.length; i++) {
          const fresh = converted.accessories[i];
          const rec = reconciled[i];
          expect(rec.displayName, `${fresh.uniqueId} displayName after cached boot`).toBe(fresh.displayName);
          if (allowed.length === 0) {
            expect(rec.graph, `${fresh.uniqueId} graph after cached boot`).toEqual(fresh.graph);
          } else {
            cachedObserved.push(...valueDiffs(fresh, rec));
          }
        }
        if (allowed.length > 0) {
          // The cached boot runs the CONVERTED config on both sides of
          // this comparison, so even the pinned legacy-vs-converted
          // value deviations must vanish here.
          expect(cachedObserved).toEqual([]);
        }

        // ---- Default-on journey (GA #65 / beta.17 requirement): the
        // UNMODIFIED legacy config, no flag anywhere, now runs the v2
        // pipeline via the compat layer. It must produce EXACTLY the
        // converted run's graphs (both sides are v2, so even the
        // pinned deviations vanish), churn nothing, and never write
        // config.json.
        const defaultOn = await runLifecycle(config as Record<string, unknown>, stations);
        expect(defaultOn.unregisteredCount, 'default-on unregistered').toBe(0);
        expect(defaultOn.accessories.map(a => a.uniqueId))
          .toEqual(converted.accessories.map(a => a.uniqueId));
        for (let i = 0; i < converted.accessories.length; i++) {
          expect(defaultOn.accessories[i].displayName, `${converted.accessories[i].uniqueId} displayName default-on`)
            .toBe(converted.accessories[i].displayName);
          expect(defaultOn.accessories[i].graph, `${converted.accessories[i].uniqueId} graph default-on`)
            .toEqual(converted.accessories[i].graph);
        }
        expect(defaultOn.configBytesChanged, 'default-on config.json write').toBe(false);
      });
    }
  }
});

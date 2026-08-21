/**
 * Compose-save boundary integration suite (GA task #67 / finding 5) —
 * the ordering proof the release gate requires, driven through the
 * REAL handler and the REAL client orchestrator against real files:
 *
 *   /compose-save → await → updatePluginConfig(...) → savePluginConfig()
 *
 * with the pre-conversion legacy record (immutable snapshot, or the
 * conversion-journal baseline on reconversion) durable on disk BEFORE
 * updatePluginConfig is invoked, and ZERO update/save calls on any
 * refusal (safe mode, stale base, invalid rows, empty inventory,
 * snapshot corruption, snapshot/journal write failure).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleComposeSave, handlePreviewSave, syntheticProbeMac, type HandlerDeps } from '../../homebridge-ui/handlers';
import { composeAndPersist, type OrchestratorDeps } from '../../homebridge-ui/saveOrchestrator';
import { LEGACY_JOURNAL_FILE, LEGACY_SENSOR_FIELDS, LEGACY_SNAPSHOT_FILE, recognizeMirror } from '../../src/sensorMap/legacyMirror';

const MAC = 'AA:BB:CC:DD:EE:01';
const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

interface Rig {
  root: string;
  persistDir: string;
  configPath: string;
  deps: HandlerDeps;
}

const rigs: Rig[] = [];

function makeRig(platformBlock: Record<string, unknown>, extraBlocks: Record<string, unknown>[] = []): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'compose-save-'));
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    bridge: { name: 'Test Bridge' },
    platforms: [platformBlock, ...extraBlocks],
  }, null, 2));
  const rig: Rig = {
    root, persistDir, configPath,
    deps: { persistDir, log: silentLog, version: 'test', configPath },
  };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    chmodSync(rig.persistDir, 0o755);
    rmSync(rig.root, { recursive: true, force: true });
  }
});

const LEGACY_BLOCK = {
  platform: 'AmbientWeatherSensors',
  name: 'Test Station',
  apiKey: 'k', applicationKey: 'a',
  _sensorMapV2: true, // saves require the v2 opt-in (review #45 P1-1)
  temperatureSensors: true,
  humiditySensors: false,
  extendedSensors: true,
  windSensors: true,
};

function discoveryStore(rig: Rig, macs: string[] = [MAC]): void {
  writeFileSync(path.join(rig.persistDir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    entries: macs.flatMap(mac => [
      { stationMac: mac, stationName: 'Home', dataPoint: 'tempf', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
      { stationMac: mac, stationName: 'Home', dataPoint: 'windspeedmph', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
    ]),
  }));
}

/**
 * The realistic PR C flow: obtain the structural-confirmation digest
 * the way the editor does — by previewing exactly what will be saved.
 */
async function digestFor(rig: Rig, payload: Record<string, unknown>): Promise<string> {
  const preview = await handlePreviewSave(rig.deps, payload);
  if (!preview.ok) {
    throw new Error(`preview refused: ${preview.error.code}`);
  }
  return preview.digest;
}

/** Event-logging fake of HB UI X's client API, wired to the REAL handler. */
function makeClient(rig: Rig): {
  deps: OrchestratorDeps;
  events: string[];
  snapshotExistedAtUpdate: boolean | undefined;
  persistedArray: Array<Record<string, unknown>> | undefined;
} {
  const state = {
    events: [] as string[],
    snapshotExistedAtUpdate: undefined as boolean | undefined,
    persistedArray: undefined as Array<Record<string, unknown>> | undefined,
  };
  const cfg = JSON.parse(readFileSync(rig.configPath, 'utf8')) as { platforms: Array<Record<string, unknown>> };
  const deps: OrchestratorDeps = {
    async request(p, payload) {
      expect(p).toBe('/compose-save');
      state.events.push('compose');
      return handleComposeSave(rig.deps, payload);
    },
    async getPluginConfig() {
      return cfg.platforms.filter(b => b.platform === 'AmbientWeatherSensors');
    },
    async updatePluginConfig(next) {
      state.events.push('update');
      state.snapshotExistedAtUpdate = existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE));
      state.persistedArray = next;
    },
    async savePluginConfig() {
      state.events.push('save');
    },
  };
  return Object.assign(state, { deps });
}

describe('structural confirmation digest (PR C / finding 5)', () => {
  const STRUCTURAL_PAYLOAD = {
    base: LEGACY_BLOCK,
    proposal: [{ dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X' }],
  };

  it('a structural save WITHOUT a digest is refused with zero writes', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleComposeSave(rig.deps, STRUCTURAL_PAYLOAD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('confirmation-required');
      expect((result.error as { structuralChangeCount: number }).structuralChangeCount).toBeGreaterThan(0);
      // The refusal must NOT hand back a usable digest — /preview-save
      // is the only source, which is what forces the confirmation UX.
      expect(JSON.stringify(result.error)).not.toMatch(/[0-9a-f]{64}/);
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('a STALE digest (discovery gained a station after the preview) is refused', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const digest = await digestFor(rig, STRUCTURAL_PAYLOAD);
    discoveryStore(rig, [MAC, 'AA:BB:CC:DD:EE:77']); // world moved on
    const result = await handleComposeSave(rig.deps, { ...STRUCTURAL_PAYLOAD, confirmDigest: digest });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-confirmation');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('a FRESH digest is accepted', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleComposeSave(rig.deps, {
      ...STRUCTURAL_PAYLOAD,
      confirmDigest: await digestFor(rig, STRUCTURAL_PAYLOAD),
    });
    expect(result.ok).toBe(true);
  });

  it('a pure legacy migration (zero accessory changes) needs NO digest — the Demeter case', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    // Migration equivalence: converting the config touches no
    // accessories, so no confirmation is demanded and the snapshot is
    // written on the way through.
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toBe('written');
    }
  });

  it('a mismatched digest is refused even when the save is non-structural (fail closed)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      confirmDigest: 'ab'.repeat(32), // not what the server derives
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-confirmation');
    }
  });
});

describe('v2-flag gate on saves (review #45 P1-1)', () => {
  it('a save with the flag OFF is refused — the preview still works', async () => {
    const flagOff = { ...LEGACY_BLOCK } as Record<string, unknown>;
    delete flagOff._sensorMapV2;
    const rig = makeRig(flagOff);
    discoveryStore(rig);
    const preview = await handlePreviewSave(rig.deps, { base: flagOff });
    expect(preview.ok).toBe(true); // dry runs are how users decide to opt in
    const save = await handleComposeSave(rig.deps, { base: flagOff });
    expect(save.ok).toBe(false);
    if (!save.ok) {
      expect(save.error.code).toBe('v2-flag-off');
      expect(save.error.message).toContain('restart Homebridge');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });
});

describe('post-compose persistence failures are INDETERMINATE (review #45 P1-2)', () => {
  it('updatePluginConfig rejecting reports the stage and never claims nothing was written', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.updatePluginConfig = async () => {
      throw new Error('ipc channel dropped');
    };
    const result = await composeAndPersist(client.deps, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('persistence-indeterminate');
      expect((result.error as { stage: string }).stage).toBe('updatePluginConfig');
      expect(result.error.message).toContain('reload the plugin settings');
      expect(result.error.message).not.toContain('Nothing was written');
    }
  });

  it('savePluginConfig rejecting AFTER update took effect reports uncertainty', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.savePluginConfig = async () => {
      throw new Error('save endpoint 500');
    };
    const result = await composeAndPersist(client.deps, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('persistence-indeterminate');
      expect((result.error as { stage: string }).stage).toBe('savePluginConfig');
      expect(result.error.message).toContain('MAY have been applied');
    }
    // update DID take effect before the failure — the effect-then-throw shape.
    expect(client.events).toEqual(['compose', 'update']);
    expect(client.persistedArray).toBeDefined();
  });
});

describe('no-bypass: preview → confirm → compose → update → save (PR C)', () => {
  it('the confirmed structural save persists the returned config verbatim, mirror included', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const payload = {
      proposal: [{ dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X' }],
    };
    // 1. Preview (the REAL handler) issues the digest.
    const preview = await handlePreviewSave(rig.deps, { base: LEGACY_BLOCK, ...payload });
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.structuralChangeCount).toBeGreaterThan(0);
    // 2-4. Confirmed save through the ONE route.
    const result = await composeAndPersist(client.deps, { ...payload, confirmDigest: preview.digest });
    expect(result.ok).toBe(true);
    expect(client.events).toEqual(['compose', 'update', 'save']);
    expect(client.snapshotExistedAtUpdate).toBe(true); // durable BEFORE persistence
    // Verbatim persistence, synchronized mirror included.
    const persisted = client.persistedArray!.find(b => b.platform === 'AmbientWeatherSensors')!;
    if (result.ok) {
      expect(persisted).toEqual(result.nextConfig);
    }
    expect(persisted.configVersion).toBe(2);
    expect(persisted).toHaveProperty('_legacyMirror');
    expect(Array.isArray(persisted.sensorMap)).toBe(true);
  });

  it('a structural save without confirmation makes ZERO config writes through the orchestrator', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const result = await composeAndPersist(client.deps, {
      proposal: [{ dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('confirmation-required');
    }
    expect(client.events).toEqual(['compose']); // no update, no save
    expect(client.persistedArray).toBeUndefined();
  });
});

describe('ordering: snapshot is durable before the client persistence half runs', () => {
  it('full success sequence is compose → update → save, with the snapshot on disk at update time', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);

    const result = await composeAndPersist(client.deps, {}); // pure migration
    expect(result.ok).toBe(true);
    expect(client.events).toEqual(['compose', 'update', 'save']);
    expect(client.snapshotExistedAtUpdate).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toBe('written');
      expect(result.nextConfig.configVersion).toBe(2);
      expect(Array.isArray(result.nextConfig.sensorMap)).toBe(true);
    }
    // Snapshot content = the authoritative pre-conversion legacy subset.
    const snap = JSON.parse(readFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), 'utf8'));
    expect(snap.legacy).toEqual({
      temperatureSensors: true,
      humiditySensors: false,
      extendedSensors: true,
      windSensors: true,
    });
  });

  it('a pure migration preserves the legacy enable/disable state (compat-seeded, not defaults)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // humiditySensors: false must survive as a mirror toggle, not be
      // re-enabled by a defaults-only composition.
      expect(result.nextConfig.humiditySensors).toBe(false);
      expect(result.nextConfig.temperatureSensors).toBe(true);
    }
  });

  it('snapshot write failure aborts the save: no nextConfig, zero update/save calls', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    chmodSync(rig.persistDir, 0o500); // snapshot temp-file creation fails
    const client = makeClient(rig);

    const result = await composeAndPersist(client.deps, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('snapshot-write-failed');
    }
    expect(client.events).toEqual(['compose']);
    expect(client.snapshotExistedAtUpdate).toBeUndefined();
  });
});

describe('authoritative on-disk config (never the client copy)', () => {
  it('an actual safe-mode config with a forged matching base is refused as safe-mode', async () => {
    const safeBlock = { ...LEGACY_BLOCK, configVersion: 99 };
    const rig = makeRig(safeBlock);
    discoveryStore(rig);
    // The client submits the on-disk block verbatim but BELIEVES it is
    // legacy — the server's own detection (from disk) wins.
    const result = await handleComposeSave(rig.deps, { base: safeBlock, proposal: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('safe-mode');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('a stale base (on-disk config changed since the session loaded) is refused', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const staleBase = { ...LEGACY_BLOCK, windSensors: false }; // client's outdated view
    const result = await handleComposeSave(rig.deps, { base: staleBase, proposal: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-base');
    }
  });

  it('zero update/save calls on a refusal through the orchestrator', async () => {
    const safeBlock = { ...LEGACY_BLOCK, configVersion: 99 };
    const rig = makeRig(safeBlock);
    discoveryStore(rig);
    const client = makeClient(rig);
    const result = await composeAndPersist(client.deps, { proposal: [] });
    expect(result.ok).toBe(false);
    expect(client.events).toEqual(['compose']);
  });
});

describe('station inventory (§8.7)', () => {
  it('absent discovery + cached-accessory uniqueIds still produce a correct mirror', async () => {
    const rig = makeRig(LEGACY_BLOCK); // no discovery.json at all
    const result = await handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      cachedAccessoryUniqueIds: [`${MAC}-tempf`, `${MAC}-windspeedmph`],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextConfig.temperatureSensors).toBe(true);
      expect(result.nextConfig.windSensors).toBe(true);
      expect(result.nextConfig.humiditySensors).toBe(false);
    }
  });

  it('all sources empty while the legacy config enables sensors: conversion refused', async () => {
    const rig = makeRig(LEGACY_BLOCK); // no discovery, no cache, no live
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no-station-inventory');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });
});

describe('proposal normalization (identity-first → merge → body validation)', () => {
  it('duplicate incomplete fragments merge into one valid custom row', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const payload = {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'barn_baro', kind: 'motion' },
        { dataPoint: 'barn_baro', measurement: 'pressure', sourceUnit: 'mmHg' },
      ],
    };
    const result = await handleComposeSave(rig.deps, { ...payload, confirmDigest: await digestFor(rig, payload) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.canonicalSensorMap.find(e => e.dataPoint === 'barn_baro');
      expect(entry).toEqual({
        dataPoint: 'barn_baro', kind: 'motion', measurement: 'pressure', sourceUnit: 'mmHg',
      });
    }
  });

  it('invalid rows refuse the whole save with structured row errors and no writes', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const result = await composeAndPersist(client.deps, {
      proposal: [{ dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed' }], // missing sourceUnit
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-rows');
      expect((result.error as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    }
    expect(client.events).toEqual(['compose']);
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });
});

describe('canonicalization at the boundary', () => {
  it('repeated compose calls are byte-stable (idempotent canonical output)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const first = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = await handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      proposal: first.canonicalSensorMap,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(JSON.stringify(second.canonicalSensorMap, null, 2))
        .toBe(JSON.stringify(first.canonicalSensorMap, null, 2));
    }
  });
});

describe('canonical-divergence hard gate (review #67 P1-1)', () => {
  it('reverse-alphabetical battery claimants (order-dependent ownership) refuse the save', () => {
    // z_custom is authored FIRST and owns barn_batt by earliest index;
    // canonical sorting would put a_custom first and flip ownership —
    // both signatures would change and HomeKit would re-register.
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    return handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'z_custom', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', batteryField: 'barn_batt' },
        { dataPoint: 'a_custom', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', batteryField: 'barn_batt' },
      ],
    }).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('canonical-divergence');
        const rows = (result.error as { rows: Array<{ dataPoint: string }> }).rows;
        // Divergence is reported per (station, dataPoint) — including
        // the synthetic template-equivalence station — so dedupe.
        expect([...new Set(rows.map(r => r.dataPoint))].sort()).toEqual(['a_custom', 'z_custom']);
      }
      expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
    });
  });

  it('the same claimants save cleanly once ownership is explicit (batteryField: null on the loser)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const payload = {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'z_custom', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', batteryField: 'barn_batt' },
        { dataPoint: 'a_custom', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', batteryField: null },
      ],
    };
    const result = await handleComposeSave(rig.deps, { ...payload, confirmDigest: await digestFor(rig, payload) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const z = result.canonicalSensorMap.find(e => e.dataPoint === 'z_custom');
      expect(z).toHaveProperty('batteryField', 'barn_batt');
    }
  });
});

describe('global-template preservation (review #67 round 2 P1)', () => {
  it('a global template with a station exception survives canonicalization for FUTURE stations', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, [MAC, 'AA:BB:CC:DD:EE:02']);
    const payload = {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X' },
        { dataPoint: 'barn_x', stationMac: 'AA:BB:CC:DD:EE:02', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X (Cabin)' },
      ],
    };
    const result = await handleComposeSave(rig.deps, { ...payload, confirmDigest: await digestFor(rig, payload) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const globalEntry = result.canonicalSensorMap.find(e => e.dataPoint === 'barn_x' && e.stationMac === undefined);
      const exception = result.canonicalSensorMap.find(e => e.dataPoint === 'barn_x' && e.stationMac === 'AA:BB:CC:DD:EE:02');
      expect(globalEntry).toBeDefined();
      expect(globalEntry).toHaveProperty('name', 'Barn X');
      expect(exception).toBeDefined();
      expect(exception).toHaveProperty('name', 'Barn X (Cabin)');
    }
  });

  it("a PARTIAL custom station exception (the reviewer's literal repro) is refused loudly as invalid-rows", async () => {
    // The frozen per-key validation (§3.7) requires identity on every
    // custom entry — the boundary refuses rather than letting the
    // serializer see (and previously corrupt) the input.
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, [MAC, 'AA:BB:CC:DD:EE:02']);
    const result = await handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X' },
        { dataPoint: 'barn_x', stationMac: 'AA:BB:CC:DD:EE:02', name: 'Barn X (Cabin)' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-rows');
      const rows = (result.error as { rows: Array<{ code: string }> }).rows;
      expect(rows.some(r => r.code === 'custom-missing-kind')).toBe(true);
    }
  });
});

describe('synthetic probe MAC is genuinely outside the inventory (review #67 round 3)', () => {
  it('skips candidates already present and picks the next unused one', () => {
    expect(syntheticProbeMac([])).toBe('02:00:00:00:00:00');
    expect(syntheticProbeMac(['02:00:00:00:00:00'])).toBe('02:00:00:00:00:01');
    expect(syntheticProbeMac(['02:00:00:00:00:00', '02:00:00:00:00:01', MAC]))
      .toBe('02:00:00:00:00:02');
    // Case-insensitive against lowercase inventory entries.
    expect(syntheticProbeMac(['02:00:00:00:00:00'.toLowerCase()])).toBe('02:00:00:00:00:01');
  });

  it('the gate still proves template equivalence when the first probe candidate IS a real station', async () => {
    const PROBE0 = '02:00:00:00:00:00';
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, [MAC, PROBE0]); // a real station squats on the first candidate
    // Order-dependent battery claims must STILL be refused — proving
    // the divergence gate ran with a genuinely fresh probe rather than
    // deduplicating into the existing PROBE0 station.
    const refused = await handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'z_custom', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', batteryField: 'barn_batt' },
        { dataPoint: 'a_custom', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', batteryField: 'barn_batt' },
      ],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('canonical-divergence');
    }
    // And a clean template save still passes with PROBE0 occupied.
    const cleanPayload = {
      base: LEGACY_BLOCK,
      proposal: [{ dataPoint: 'barn_x', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Barn X' }],
    };
    const saved = await handleComposeSave(rig.deps, { ...cleanPayload, confirmDigest: await digestFor(rig, cleanPayload) });
    expect(saved.ok).toBe(true);
  });
});

describe('successful saves surface warnings (review #67 P2-5)', () => {
  it('warn-and-strip validation stays visible in the compose response', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const payload = {
      base: LEGACY_BLOCK,
      // displayUnit on a native-HAP measurement is warn-and-stripped.
      proposal: [{ dataPoint: 'tempf', name: 'Patio', displayUnit: 'celsius' }],
    };
    const result = await handleComposeSave(rig.deps, { ...payload, confirmDigest: await digestFor(rig, payload) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.warnings.map(w => w.code);
      expect(codes).toContain('ignored-native-displayunit');
    }
  });
});

describe('immutable snapshot lifecycle', () => {
  it('an existing MATCHING snapshot verifies and proceeds as exists', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const first = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(first.ok && first.snapshot === 'written').toBe(true);
    // Same legacy config converts again (config save never happened).
    const again = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.snapshot).toBe('exists');
    }
  });

  it('an existing MISMATCHING snapshot journals the differing baseline and proceeds; the snapshot is never overwritten', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const snapPath = path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE);
    const staleBody = JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z',
      legacy: { temperatureSensors: false }, // differs from the live config
    }, null, 2);
    writeFileSync(snapPath, staleBody);
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toBe('journaled');
    }
    expect(readFileSync(snapPath, 'utf8')).toBe(staleBody); // untouched
    const journal = JSON.parse(readFileSync(path.join(rig.persistDir, LEGACY_JOURNAL_FILE), 'utf8'));
    expect(journal.schemaVersion).toBe(1);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0].legacy).toEqual({
      temperatureSensors: true, humiditySensors: false,
      extendedSensors: true, windSensors: true,
    });
  });

  it('a corrupt conversion journal fails a reconversion closed and is never replaced', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    writeFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z',
      legacy: { temperatureSensors: false }, // forces the journal path
    }, null, 2));
    const journalPath = path.join(rig.persistDir, LEGACY_JOURNAL_FILE);
    writeFileSync(journalPath, '{not json');
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conversion-journal-error');
    }
    expect(readFileSync(journalPath, 'utf8')).toBe('{not json'); // untouched
  });

  it('a corrupt snapshot refuses the conversion', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    writeFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), '{not json');
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('legacy-snapshot-corrupt');
    }
  });

  it('an unrecognized snapshot schemaVersion is corrupt even when the legacy fields match (review P2-4)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    writeFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), JSON.stringify({
      schemaVersion: 99,
      savedAt: '2026-01-01T00:00:00Z',
      legacy: {
        temperatureSensors: true, humiditySensors: false,
        extendedSensors: true, windSensors: true,
      },
    }, null, 2));
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('legacy-snapshot-corrupt');
    }
  });

  it('concurrent first conversions: exactly one written, the rest verify as exists, payload intact', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const results = await Promise.all([
      handleComposeSave(rig.deps, { base: LEGACY_BLOCK }),
      handleComposeSave(rig.deps, { base: LEGACY_BLOCK }),
      handleComposeSave(rig.deps, { base: LEGACY_BLOCK }),
    ]);
    const outcomes = results.map(r => (r.ok ? r.snapshot : `refused:${r.error.code}`));
    expect(outcomes.filter(o => o === 'written')).toHaveLength(1);
    expect(outcomes.filter(o => o === 'exists')).toHaveLength(2);
    const snap = JSON.parse(readFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), 'utf8'));
    expect(snap.legacy.temperatureSensors).toBe(true);
  });
});

describe('explicit-base orchestration (review #67 P1-3)', () => {
  it('a CLONED base (deep-equal, not reference-equal) replaces the block instead of appending a duplicate', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const clonedBase = JSON.parse(JSON.stringify(LEGACY_BLOCK)) as Record<string, unknown>;
    const result = await composeAndPersist(client.deps, { base: clonedBase });
    expect(result.ok).toBe(true);
    expect(client.events).toEqual(['compose', 'update', 'save']);
    const awsBlocks = (client.persistedArray ?? []).filter(b => b.platform === 'AmbientWeatherSensors');
    expect(awsBlocks).toHaveLength(1);
    expect(awsBlocks[0].configVersion).toBe(2);
  });
});

describe('subsequent v2 saves', () => {
  it('leave the snapshot untouched and refresh a recognized mirror', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const first = await composeAndPersist(client.deps, {});
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const snapPath = path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE);
    const snapBefore = readFileSync(snapPath, 'utf8');
    const mtimeBefore = statSync(snapPath).mtimeMs;

    // Simulate the client's persistence: the composed block is now the
    // on-disk config.
    writeFileSync(rig.configPath, JSON.stringify({
      bridge: { name: 'Test Bridge' },
      platforms: [first.nextConfig],
    }, null, 2));

    // A later v2-mode edit: rename tempf.
    const second = await handleComposeSave(rig.deps, {
      base: first.nextConfig,
      proposal: [...first.canonicalSensorMap, { dataPoint: 'tempf', name: 'Patio' }],
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.snapshot).toBe('not-applicable');
      expect(second.canonicalSensorMap.some(e => e.dataPoint === 'tempf' && e.name === 'Patio')).toBe(true);
      // Mirror metadata is recognized (hash binds mirror + sensorMap).
      expect(recognizeMirror(second.nextConfig as never).state).toBe('recognized');
    }
    expect(readFileSync(snapPath, 'utf8')).toBe(snapBefore);
    expect(statSync(snapPath).mtimeMs).toBe(mtimeBefore);
    // v2-mode saves never touch the conversion journal either — it
    // records LEGACY conversion baselines only.
    expect(existsSync(path.join(rig.persistDir, LEGACY_JOURNAL_FILE))).toBe(false);
  });
});

describe('rollback is a two-way door (conversion journal)', () => {
  /** The documented current-state rollback: delete the three markers
   * and disable the flag; the remaining synchronized mirror fields ARE
   * the working legacy configuration. */
  function documentedRollback(nextConfig: Record<string, unknown>): Record<string, unknown> {
    const rolled = { ...nextConfig };
    delete rolled.sensorMap;
    delete rolled.configVersion;
    delete rolled._legacyMirror;
    delete rolled._sensorMapV2;
    return rolled;
  }

  function persistAsConfig(rig: Rig, block: Record<string, unknown>): void {
    writeFileSync(rig.configPath, JSON.stringify({
      bridge: { name: 'Test Bridge' },
      platforms: [block],
    }, null, 2));
  }

  it('legacy → v2 save → verified-mirror rollback → re-enable → v2 save succeeds, preserving the snapshot and journaling the rolled-back baseline', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const snapPath = path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE);
    const journalPath = path.join(rig.persistDir, LEGACY_JOURNAL_FILE);

    // First conversion writes the immutable snapshot.
    const first = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.snapshot).toBe('written');
    const snapshotBytes = readFileSync(snapPath, 'utf8');

    // The rollback precondition the documentation requires: the mirror
    // must be RECOGNIZED before the marker-deletion rollback is used.
    expect(recognizeMirror(first.nextConfig as never).state).toBe('recognized');
    const reEnabled = { ...documentedRollback(first.nextConfig), _sensorMapV2: true };
    persistAsConfig(rig, reEnabled);

    // Reconversion: the projected mirror form differs from the
    // original, so the save journals it and proceeds — the rollback is
    // not a one-way door.
    const second = await handleComposeSave(rig.deps, { base: reEnabled });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.snapshot).toBe('journaled');
    expect(second.nextConfig.configVersion).toBe(2);
    expect(recognizeMirror(second.nextConfig as never).state).toBe('recognized');

    // The original snapshot is byte-identical, and the journal holds
    // exactly the rolled-back operative baseline.
    expect(readFileSync(snapPath, 'utf8')).toBe(snapshotBytes);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(journal.schemaVersion).toBe(1);
    expect(journal.entries).toHaveLength(1);
    const expectedBaseline: Record<string, unknown> = {};
    for (const key of LEGACY_SENSOR_FIELDS) {
      if (reEnabled[key] !== undefined) {
        expectedBaseline[key] = reEnabled[key];
      }
    }
    expect(journal.entries[0].legacy).toEqual(expectedBaseline);

    // An identical second rollback/reconvert cycle deduplicates: the
    // journal stays at one entry and the snapshot stays untouched.
    const rolledAgain = { ...documentedRollback(second.nextConfig), _sensorMapV2: true };
    persistAsConfig(rig, rolledAgain);
    const third = await handleComposeSave(rig.deps, { base: rolledAgain });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.snapshot).toBe('journaled');
    }
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).entries).toHaveLength(1);
    expect(readFileSync(snapPath, 'utf8')).toBe(snapshotBytes);
  });

  it('an EDITED rolled-back baseline appends a second journal entry instead of deduplicating', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const journalPath = path.join(rig.persistDir, LEGACY_JOURNAL_FILE);

    const first = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const reEnabled = { ...documentedRollback(first.nextConfig), _sensorMapV2: true };
    persistAsConfig(rig, reEnabled);
    const second = await handleComposeSave(rig.deps, { base: reEnabled });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    // Roll back again, then hand-edit a legacy field before the third
    // conversion — a genuinely different baseline must be preserved.
    const edited = { ...documentedRollback(second.nextConfig), _sensorMapV2: true, windSensors: false };
    persistAsConfig(rig, edited);
    const third = await handleComposeSave(rig.deps, { base: edited });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.snapshot).toBe('journaled');
    }
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[1].legacy.windSensors).toBe(false);
  });
});

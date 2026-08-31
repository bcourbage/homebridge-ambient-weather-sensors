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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { blockDigest, handleCommitSave, handleComposeSave, handlePreviewSave, syntheticProbeMac, type HandlerDeps } from '../../homebridge-ui/handlers';
import { composeAndPersist, type OrchestratorDeps } from '../../homebridge-ui/saveOrchestrator';
import { LEGACY_JOURNAL_DIR, LEGACY_SENSOR_FIELDS, LEGACY_SNAPSHOT_FILE, recognizeMirror } from '../../src/sensorMap/legacyMirror';

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

function journalDir(rig: Rig): string {
  return path.join(rig.persistDir, LEGACY_JOURNAL_DIR);
}

/** Read the journal directory's entry files in sequence order. */
function readJournalEntries(rig: Rig): Array<{ savedAt: string; legacy: Record<string, unknown> }> {
  return readdirSync(journalDir(rig))
    .filter(n => !n.startsWith('.'))
    .sort()
    .map(n => JSON.parse(readFileSync(path.join(journalDir(rig), n), 'utf8')) as {
      savedAt: string; legacy: Record<string, unknown>;
    });
}

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

/**
 * The realistic COMMIT flow (review #47 round 5): validate first,
 * present the issued token to the commit — exactly what the
 * orchestrator does.
 */
async function commitFor(rig: Rig, payload: Record<string, unknown>): Promise<Awaited<ReturnType<typeof handleCommitSave>>> {
  const validated = await handleComposeSave(rig.deps, payload);
  if (!validated.ok) {
    throw new Error(`validate refused: ${validated.error.code}`);
  }
  return handleCommitSave(rig.deps, { ...payload, validationToken: validated.validationToken });
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
      expect(['/compose-save', '/commit-save']).toContain(p);
      if (p === '/compose-save') {
        state.events.push('compose');
        return handleComposeSave(rig.deps, payload);
      }
      state.events.push('commit');
      return handleCommitSave(rig.deps, payload);
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
    freezeSettingsForm() {
      state.events.push('freeze');
    },
    unfreezeSettingsForm() {
      state.events.push('unfreeze');
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
    const result = await commitFor(rig, { base: LEGACY_BLOCK });
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
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'unfreeze']);
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
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'save', 'unfreeze']);
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
    expect(client.events).toEqual(['freeze', 'compose', 'unfreeze']); // no update, no save
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
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'save', 'unfreeze']);
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
    // Validate passes (dir readable, snapshot absent); the write fails
    // at COMMIT — still zero config persistence.
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'unfreeze']);
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
    expect(client.events).toEqual(['freeze', 'compose', 'unfreeze']);
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
    expect(client.events).toEqual(['freeze', 'compose', 'unfreeze']);
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
    const first = await commitFor(rig, { base: LEGACY_BLOCK });
    expect(first.ok && first.snapshot === 'written').toBe(true);
    // Same legacy config converts again (config save never happened).
    const again = await commitFor(rig, { base: LEGACY_BLOCK });
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
    const result = await commitFor(rig, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toBe('journaled');
    }
    expect(readFileSync(snapPath, 'utf8')).toBe(staleBody); // untouched
    const entries = readJournalEntries(rig);
    expect(entries).toHaveLength(1);
    expect(entries[0].legacy).toEqual({
      temperatureSensors: true, humiditySensors: false,
      extendedSensors: true, windSensors: true,
    });
  });

  it('a corrupt conversion-journal entry fails a reconversion closed and is never replaced', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    writeFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z',
      legacy: { temperatureSensors: false }, // forces the journal path
    }, null, 2));
    mkdirSync(journalDir(rig), { recursive: true });
    const entryFile = path.join(journalDir(rig), 'entry-000001.json');
    writeFileSync(entryFile, '{not json');
    // Two-phase: the corrupt journal refuses at VALIDATE, before any
    // durable step could run.
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conversion-journal-error');
    }
    expect(readFileSync(entryFile, 'utf8')).toBe('{not json'); // untouched
    expect(readdirSync(journalDir(rig))).toEqual(['entry-000001.json']); // nothing added
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

  it('concurrent first conversions: exactly one written; the rest verify as exists or refuse as drift', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const results = await Promise.all([
      commitFor(rig, { base: LEGACY_BLOCK }),
      commitFor(rig, { base: LEGACY_BLOCK }),
      commitFor(rig, { base: LEGACY_BLOCK }),
    ]);
    const outcomes = results.map(r => (r.ok ? r.snapshot : `refused:${r.error.code}`));
    expect(outcomes.filter(o => o === 'written')).toHaveLength(1);
    // A loser either validated after the winner's write ('exists') or
    // validated before it — its token then binds 'pending-write',
    // which the commit's recomputation correctly reports as drift
    // (retrying re-validates and succeeds as 'exists').
    for (const o of outcomes) {
      expect(['written', 'exists', 'refused:stale-confirmation']).toContain(o);
    }
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
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'save', 'unfreeze']);
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
    expect(existsSync(journalDir(rig))).toBe(false);
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

    // First conversion writes the immutable snapshot.
    const first = await commitFor(rig, { base: LEGACY_BLOCK });
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
    const second = await commitFor(rig, { base: reEnabled });
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
    const entries = readJournalEntries(rig);
    expect(entries).toHaveLength(1);
    const expectedBaseline: Record<string, unknown> = {};
    for (const key of LEGACY_SENSOR_FIELDS) {
      if (reEnabled[key] !== undefined) {
        expectedBaseline[key] = reEnabled[key];
      }
    }
    expect(entries[0].legacy).toEqual(expectedBaseline);

    // An identical second rollback/reconvert cycle deduplicates: the
    // journal stays at one entry and the snapshot stays untouched.
    const rolledAgain = { ...documentedRollback(second.nextConfig), _sensorMapV2: true };
    persistAsConfig(rig, rolledAgain);
    const third = await commitFor(rig, { base: rolledAgain });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.snapshot).toBe('journaled');
    }
    expect(readJournalEntries(rig)).toHaveLength(1);
    expect(readFileSync(snapPath, 'utf8')).toBe(snapshotBytes);
  });

  it('an EDITED rolled-back baseline appends a second journal entry instead of deduplicating', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);

    const first = await commitFor(rig, { base: LEGACY_BLOCK });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const reEnabled = { ...documentedRollback(first.nextConfig), _sensorMapV2: true };
    persistAsConfig(rig, reEnabled);
    const second = await commitFor(rig, { base: reEnabled });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    // Roll back again, then hand-edit a legacy field before the third
    // conversion — a genuinely different baseline must be preserved.
    const edited = { ...documentedRollback(second.nextConfig), _sensorMapV2: true, windSensors: false };
    persistAsConfig(rig, edited);
    const third = await commitFor(rig, { base: edited });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.snapshot).toBe('journaled');
    }
    const entries = readJournalEntries(rig);
    expect(entries).toHaveLength(2);
    expect(entries[1].legacy.windSensors).toBe(false);
  });
});

describe('session-digest staleness (beta.13 smoke F1: getPluginConfig is schema-form-mutated)', () => {
  it('a contaminated base copy refuses stale-base while the SAME session succeeds via baseDigest', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    // The reproduced browser condition: HB UI X's settings form
    // materializes schema defaults into the in-memory config that
    // getPluginConfig() hands the client.
    const contaminated = { ...LEGACY_BLOCK, includeOnly: [], stationFilter: [] };
    const viaBase = await handlePreviewSave(rig.deps, { base: contaminated });
    expect(viaBase.ok).toBe(false);
    if (!viaBase.ok) {
      expect(viaBase.error.code).toBe('stale-base');
    }

    const digest = blockDigest(LEGACY_BLOCK);
    const viaDigest = await handlePreviewSave(rig.deps, { baseDigest: digest });
    expect(viaDigest.ok).toBe(true);

    const composed = await handleComposeSave(rig.deps, { baseDigest: digest, formBlock: LEGACY_BLOCK });
    expect(composed.ok).toBe(true);
    if (composed.ok) {
      expect(composed.nextConfigDigest).toBe(blockDigest(composed.nextConfig));
    }
  });

  it('a digest that matches no on-disk block refuses stale-base; a matching digest wins over a stale base', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const wrong = await handleComposeSave(rig.deps, { baseDigest: 'f'.repeat(64), formBlock: LEGACY_BLOCK });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.code).toBe('stale-base');
    }
    // baseDigest takes precedence: a contaminated base alongside a
    // valid digest must not re-introduce the refusal.
    const both = await handlePreviewSave(rig.deps, {
      base: { ...LEGACY_BLOCK, includeOnly: [] },
      baseDigest: blockDigest(LEGACY_BLOCK),
    });
    expect(both.ok).toBe(true);
  });

  it('composeAndPersist via baseDigest+blockIndex succeeds against a contaminated array and persists the composed block verbatim', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    // Contaminate what getPluginConfig returns, exactly as the
    // schema form does in the real page.
    const realGet = client.deps.getPluginConfig.bind(client.deps);
    client.deps.getPluginConfig = async () =>
      (await realGet()).map(b => ({ ...b, includeOnly: [], stationFilter: [] }));

    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'save', 'unfreeze']);
    if (!result.ok) {
      return;
    }

    // The submitted block carries explicit undefined TOMBSTONES for
    // every key the composed config removed (the contamination and any
    // deleted legacy field), so HB UI X's Object.assign merge produces
    // EXACTLY the composed block and its JSON persistence drops the
    // keys. (An earlier clear-then-set design left HB UI X's session
    // empty when a save died mid-sequence — measured on production.)
    const persisted = (client.persistedArray ?? [])[0];
    expect('includeOnly' in persisted).toBe(true);
    expect(persisted.includeOnly).toBeUndefined();
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(JSON.parse(JSON.stringify(result.nextConfig)));
  });

  it('an out-of-range blockIndex refuses before composing (zero writes)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-base');
    }
    expect(client.events).toEqual(['freeze', 'unfreeze']);
  });
});

describe('unsaved settings-form changes (review #47 P1-1)', () => {
  it('a REAL form edit refuses the save with zero writes; saving the form first clears it', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    // The user changed a credential in the settings form (unsaved):
    // the in-memory copy differs from disk beyond materialization.
    const realGet = client.deps.getPluginConfig.bind(client.deps);
    client.deps.getPluginConfig = async () =>
      (await realGet()).map(b => ({ ...b, includeOnly: [], apiKey: 'edited-but-not-saved' }));

    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
      expect(result.error.message).toContain("'apiKey'");
    }
    // Zero persistence AND zero snapshot: the refusal precedes the
    // snapshot write.
    expect(client.events).toEqual(['freeze', 'compose', 'unfreeze']);
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('a dropped key and a changed nested value are unsaved edits too; a malformed formBlock refuses', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const digest = blockDigest(LEGACY_BLOCK);

    const dropped: Record<string, unknown> = { ...LEGACY_BLOCK };
    delete dropped.temperatureSensors;
    const r1 = await handleComposeSave(rig.deps, { baseDigest: digest, formBlock: dropped });
    expect(!r1.ok && r1.error.code).toBe('unsaved-settings-changes');

    const r2 = await handleComposeSave(rig.deps, {
      baseDigest: digest,
      formBlock: { ...LEGACY_BLOCK, humiditySensors: true }, // true vs false on disk
    });
    expect(!r2.ok && r2.error.code).toBe('unsaved-settings-changes');

    const r3 = await handleComposeSave(rig.deps, { baseDigest: digest, formBlock: 'not-an-object' });
    expect(!r3.ok && r3.error.code).toBe('unsaved-settings-changes');

    // The exact disk state (with or without tolerated materialization)
    // composes fine.
    const r4 = await handleComposeSave(rig.deps, {
      baseDigest: digest,
      formBlock: { ...LEGACY_BLOCK, includeOnly: [], stationFilter: [] },
    });
    expect(r4.ok).toBe(true);
  });
});

describe('multi-block hard refusal (review #47 P1-2)', () => {
  const SECOND_BLOCK = { ...LEGACY_BLOCK, name: 'Second Home', apiKey: 'k2' };

  it('two DISTINCT plugin blocks: preview and compose refuse even with a uniquely matching digest', async () => {
    const rig = makeRig(LEGACY_BLOCK, [SECOND_BLOCK]);
    discoveryStore(rig);
    const digest = blockDigest(LEGACY_BLOCK); // uniquely matches block 0
    const pv = await handlePreviewSave(rig.deps, { baseDigest: digest });
    expect(!pv.ok && pv.error.code).toBe('ambiguous-platform-block');
    const cs = await handleComposeSave(rig.deps, { baseDigest: digest, formBlock: LEGACY_BLOCK });
    expect(!cs.ok && cs.error.code).toBe('ambiguous-platform-block');
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('the orchestrator refuses two blocks client-side with zero requests, and a forged blockIndex with zero requests', async () => {
    const rig = makeRig(LEGACY_BLOCK, [SECOND_BLOCK]);
    discoveryStore(rig);
    const twoBlocks = makeClient(rig);
    const r1 = await composeAndPersist(twoBlocks.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(!r1.ok && r1.error.code).toBe('ambiguous-platform-block');
    expect(twoBlocks.events).toEqual(['freeze', 'unfreeze']);

    // Single block, forged index: the orchestrator derives the
    // position itself and refuses the disagreement before composing.
    const rigOne = makeRig(LEGACY_BLOCK);
    discoveryStore(rigOne);
    const one = makeClient(rigOne);
    const r2 = await composeAndPersist(one.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 3,
    });
    expect(!r2.ok && r2.error.code).toBe('stale-base');
    expect(one.events).toEqual(['freeze', 'unfreeze']);
    expect(existsSync(path.join(rigOne.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });
});


describe('settings-form gate hardening (review #47 round 3)', () => {
  it('a digest save WITHOUT formBlock is refused before any snapshot exists (the gate is not optional)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleComposeSave(rig.deps, { baseDigest: blockDigest(LEGACY_BLOCK) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('an UNKNOWN field holding an intentionally empty array refuses (allowlist, not a shape rule)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleComposeSave(rig.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      formBlock: { ...LEGACY_BLOCK, futureField: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
      expect(result.error.message).toContain("'futureField'");
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('a settings mutation racing the compose is caught by the pre-persistence re-read (zero writes)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    // Hostile simulation of the TOCTOU window: the freeze is
    // client-cooperative, so model a writer that mutates the
    // in-memory config AFTER the first read. The re-read taken just
    // before persistence must refuse rather than erase the edit.
    let reads = 0;
    const realGet = client.deps.getPluginConfig.bind(client.deps);
    client.deps.getPluginConfig = async () => {
      reads += 1;
      const blocks = await realGet();
      return reads === 1 ? blocks : blocks.map(b => ({ ...b, apiKey: 'edited-mid-save' }));
    };
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
      expect(result.error.message).toContain('while the save was running');
    }
    expect(client.events).toEqual(['freeze', 'compose', 'unfreeze']);
    expect(reads).toBeGreaterThanOrEqual(2);
    // The abandoned attempt consumed NOTHING durable: validation wrote
    // no snapshot, and the commit phase was never reached (review #47
    // round 4 — "nothing was written" is now literally true).
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(journalDir(rig))).toBe(false);
  });
});


describe('two-phase save: validate writes nothing (review #47 round 4)', () => {
  it('the validate phase reports pending-write with NO snapshot on disk; commit then writes it', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const validated = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.snapshot).toBe('pending-write');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);

    const committed = await commitFor(rig, { base: LEGACY_BLOCK });
    expect(committed.ok).toBe(true);
    if (committed.ok) {
      expect(committed.snapshot).toBe('written');
      if (validated.ok) {
        expect(committed.nextConfigDigest).toBe(validated.nextConfigDigest);
      }
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(true);
  });

  it('a reconversion validates as pending-journal with NO journal entry written', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    writeFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z',
      legacy: { temperatureSensors: false }, // differs -> journal path
    }, null, 2));
    const validated = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.snapshot).toBe('pending-journal');
    }
    expect(existsSync(journalDir(rig))).toBe(false);
  });

  it('a corrupt journal refuses at VALIDATE, before anything could be recorded', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    writeFileSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE), JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z',
      legacy: { temperatureSensors: false },
    }, null, 2));
    mkdirSync(journalDir(rig), { recursive: true });
    writeFileSync(path.join(journalDir(rig), 'entry-000001.json'), '{not json');
    const validated = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.error.code).toBe('conversion-journal-error');
    }
  });
});

describe('freeze failure safety (review #47 round 4)', () => {
  it('a throwing freeze refuses cleanly, attempts the restore, and makes zero requests', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.freezeSettingsForm = () => {
      client.events.push('freeze-throw');
      throw new Error('save button API rejected');
    };
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
      expect(result.error.message).toContain('could not be frozen');
    }
    // A partial freeze is restored before refusing; nothing was
    // requested or written.
    expect(client.events).toEqual(['freeze-throw', 'unfreeze']);
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('an unfreeze failure AFTER successful persistence never masks the save outcome', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.unfreezeSettingsForm = () => {
      client.events.push('unfreeze-throw');
      throw new Error('showSchemaForm rejected');
    };
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    // The save completed and persisted; the cleanup failure is
    // swallowed rather than replacing the authoritative outcome.
    expect(result.ok).toBe(true);
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'save', 'unfreeze-throw']);
  });
});


describe('server-enforced two-phase protocol (review #47 round 5)', () => {
  it('a DIRECT commit without a validation token refuses with nothing recorded', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const result = await handleCommitSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('commit-without-validation');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(journalDir(rig))).toBe(false);
  });

  it('a token presented with a DIFFERENT proposal refuses with nothing recorded', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const validated = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    // The validated canonical map plus a DISABLED-row edit: zero
    // structural consequences, so no earlier gate
    // (confirmation-required) can mask the token check.
    const result = await handleCommitSave(rig.deps, {
      base: LEGACY_BLOCK,
      proposal: [...validated.canonicalSensorMap, { dataPoint: 'humidity', enabled: false, name: 'Renamed After Validation' }],
      validationToken: validated.validationToken,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-confirmation');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(journalDir(rig))).toBe(false);
  });

  it('state drift between the phases refuses with nothing recorded', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const digest = blockDigest(LEGACY_BLOCK);
    const validated = await handleComposeSave(rig.deps, {
      baseDigest: digest,
      formBlock: LEGACY_BLOCK,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    // The settings-form state the commit presents differs from the
    // validated one (a tolerated materialization appeared in between —
    // still a drift the token must catch, because the token binds the
    // EXACT validated state).
    const result = await handleCommitSave(rig.deps, {
      baseDigest: digest,
      formBlock: { ...LEGACY_BLOCK, includeOnly: [] },
      validationToken: validated.validationToken,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-confirmation');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(journalDir(rig))).toBe(false);
  });
});

describe('settings-form restore failures are surfaced (review #47 round 5, P2)', () => {
  it('an unfreeze failure after successful persistence returns ok WITH the restore flag', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.unfreezeSettingsForm = () => {
      client.events.push('unfreeze-throw');
      throw new Error('showSchemaForm rejected');
    };
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.settingsRestoreFailed).toBe(true);
  });

  it('a successful restore attaches NO flag', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.settingsRestoreFailed).toBeUndefined();
  });
});


describe('lost responses become visible outcomes (beta.14 smoke: the frozen save)', () => {
  it('a never-resolving updatePluginConfig times out as persistence-indeterminate', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.timeouts = { request: 2_000, persist: 120 };
    client.deps.updatePluginConfig = () => new Promise(() => { /* response lost */ });
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('persistence-indeterminate');
      expect(result.error.message).toContain('no response from the Homebridge UI (updatePluginConfig)');
    }
  });

  it('a never-resolving bridge request times out as a thrown transport error with zero writes', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.timeouts = { request: 120, persist: 2_000 };
    client.deps.request = () => new Promise(() => { /* response lost */ });
    await expect(composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    })).rejects.toThrow(/no response from the plugin service/);
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
    // The settings form was restored on the way out.
    expect(client.events[client.events.length - 1]).toBe('unfreeze');
  });

  it('an EMPTY in-memory config refuses with reload guidance, not multi-Home advice', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = makeClient(rig);
    client.deps.getPluginConfig = async () => [];
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('stale-base');
      expect(result.error.message).toContain('Reload the plugin settings page');
      expect(result.error.message).not.toContain('MultiHome');
    }
    expect(client.events).toEqual(['freeze', 'unfreeze']);
  });
});

describe('HB UI X form-value replacement (beta.14 smoke #6, measured on 5.28)', () => {
  // HB UI X's settings modal binds its schema form two-way into
  // pluginConfig[0] and REPLACES the block with the form VALUE: only
  // schema-declared properties survive (`platform` does not), and
  // every declared default is materialized — top-level and nested.
  // This helper reproduces that measured shape from the real
  // config.schema.json, so these tests exercise exactly what a
  // production session hands the orchestrator.
  const SCHEMA_PROPS = (JSON.parse(readFileSync(
    path.resolve(__dirname, '../../config.schema.json'), 'utf8',
  )) as { schema: { properties: Record<string, { default?: unknown; properties?: Record<string, { default?: unknown }> }> } })
    .schema.properties;

  function formValueOf(block: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(SCHEMA_PROPS)) {
      const nestedDefaults = prop.properties
        ? Object.fromEntries(Object.entries(prop.properties)
          .filter(([, np]) => np.default !== undefined)
          .map(([nk, np]) => [nk, np.default]))
        : undefined;
      if (key in block) {
        out[key] = nestedDefaults && block[key] && typeof block[key] === 'object'
          ? { ...nestedDefaults, ...(block[key] as Record<string, unknown>) }
          : block[key];
      } else if (prop.default !== undefined) {
        out[key] = prop.default;
      } else if (nestedDefaults && Object.keys(nestedDefaults).length > 0) {
        out[key] = nestedDefaults;
      }
    }
    return out;
  }

  function sessionClient(rig: Rig, sessionBlocks: Array<Record<string, unknown>>): ReturnType<typeof makeClient> {
    const client = makeClient(rig);
    client.deps.getPluginConfig = async () => JSON.parse(JSON.stringify(sessionBlocks)) as Array<Record<string, unknown>>;
    return client;
  }

  it('a pristine form-replaced session (platform dropped, defaults materialized) SAVES', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const client = sessionClient(rig, [formValueOf(LEGACY_BLOCK)]);
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(LEGACY_BLOCK),
      blockIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(client.events).toEqual(['freeze', 'compose', 'commit', 'update', 'save', 'unfreeze']);
    // The write carries the canonical platform key even though the
    // session copy lost it (HB UI X re-injects it too; belt and
    // braces so a merge-through never persists a platformless block).
    expect(client.persistedArray![0].platform).toBe('AmbientWeatherSensors');
  });

  it('a REAL edit hiding inside the replacement noise still refuses: changed value, and non-default form-only value', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);

    const changed = formValueOf({ ...LEGACY_BLOCK, humiditySensors: true }); // disk: false
    const r1 = await composeAndPersist(sessionClient(rig, [changed]).deps, {
      baseDigest: blockDigest(LEGACY_BLOCK), blockIndex: 0,
    });
    expect(!r1.ok && r1.error.code).toBe('unsaved-settings-changes');
    expect(!r1.ok && r1.error.message).toContain("'humiditySensors'");

    const formOnly = { ...formValueOf(LEGACY_BLOCK), co2Sensors: true }; // absent on disk, default false
    const r2 = await composeAndPersist(sessionClient(rig, [formOnly]).deps, {
      baseDigest: blockDigest(LEGACY_BLOCK), blockIndex: 0,
    });
    expect(!r2.ok && r2.error.code).toBe('unsaved-settings-changes');
    expect(!r2.ok && r2.error.message).toContain("'co2Sensors'");
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });

  it('nested defaults materialized into a sparse thresholds object pass; a nested EDIT refuses with its path', async () => {
    const sparse = { ...LEGACY_BLOCK, thresholds: { windSpeedMph: 18 } };
    const rig = makeRig(sparse);
    discoveryStore(rig);

    const pristine = formValueOf(sparse);
    expect((pristine.thresholds as Record<string, unknown>).windSpeedMph).toBe(18);
    expect((pristine.thresholds as Record<string, unknown>).uvEnabled).toBe(true); // materialized
    const ok = await composeAndPersist(sessionClient(rig, [pristine]).deps, {
      baseDigest: blockDigest(sparse), blockIndex: 0,
    });
    expect(ok.ok).toBe(true);

    const rig2 = makeRig(sparse);
    discoveryStore(rig2);
    const edited = formValueOf(sparse);
    (edited.thresholds as Record<string, unknown>).windSpeedMph = 30;
    const r = await composeAndPersist(sessionClient(rig2, [edited]).deps, {
      baseDigest: blockDigest(sparse), blockIndex: 0,
    });
    expect(!r.ok && r.error.code).toBe('unsaved-settings-changes');
    expect(!r.ok && r.error.message).toContain("'thresholds.windSpeedMph'");
  });

  it('non-schema keys the form cannot express (_bridge) neither refuse the save nor get lost', async () => {
    const bridged = { ...LEGACY_BLOCK, _bridge: { username: '0E:22:33:44:55:66', port: 51900 } };
    const rig = makeRig(bridged);
    discoveryStore(rig);
    const client = sessionClient(rig, [formValueOf(bridged)]); // form value drops _bridge
    const result = await composeAndPersist(client.deps, {
      baseDigest: blockDigest(bridged),
      blockIndex: 0,
    });
    expect(result.ok).toBe(true);
    // Composed from DISK, so the child-bridge settings survive the
    // save even though the session copy never carried them.
    expect(client.persistedArray![0]._bridge).toEqual({ username: '0E:22:33:44:55:66', port: 51900 });
  });
});

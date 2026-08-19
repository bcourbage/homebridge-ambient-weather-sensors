/**
 * Compose-save boundary integration suite (GA task #67 / finding 5) —
 * the ordering proof the release gate requires, driven through the
 * REAL handler and the REAL client orchestrator against real files:
 *
 *   /compose-save → await → updatePluginConfig(...) → savePluginConfig()
 *
 * with the immutable legacy snapshot durable on disk BEFORE
 * updatePluginConfig is invoked, and ZERO update/save calls on any
 * refusal (safe mode, stale base, invalid rows, empty inventory,
 * snapshot mismatch/corruption, snapshot write failure).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleComposeSave, type HandlerDeps } from '../../homebridge-ui/handlers';
import { composeAndPersist, type OrchestratorDeps } from '../../homebridge-ui/saveOrchestrator';
import { LEGACY_SNAPSHOT_FILE, recognizeMirror } from '../../src/sensorMap/legacyMirror';

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
    const result = await handleComposeSave(rig.deps, {
      base: LEGACY_BLOCK,
      proposal: [
        { dataPoint: 'barn_baro', kind: 'motion' },
        { dataPoint: 'barn_baro', measurement: 'pressure', sourceUnit: 'mmHg' },
      ],
    });
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

  it('an existing MISMATCHING snapshot refuses the conversion and is never overwritten', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig);
    const snapPath = path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE);
    const staleBody = JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z',
      legacy: { temperatureSensors: false }, // differs from the live config
    }, null, 2);
    writeFileSync(snapPath, staleBody);
    const result = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('legacy-snapshot-mismatch');
    }
    expect(readFileSync(snapPath, 'utf8')).toBe(staleBody); // untouched
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
  });
});

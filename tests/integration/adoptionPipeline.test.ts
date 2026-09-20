/**
 * Catalog adoption through the guarded save pipeline (issue #63 P2 —
 * sensor-map.md §18.3). Pipeline-level halves of the checkpoint test
 * matrix: birth stamps, stamp preservation across conversion and first
 * saves, the explicit adoption operation and its refusals, fail-closed
 * stamp handling at the save boundary, and the editor's catalog view.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FRESH_INSTALL_DIGEST,
  handleCommitSave,
  handleComposeSave,
  handleGetEditorState,
  handlePreviewSave,
  type HandlerDeps,
} from '../../homebridge-ui/handlers';
import { CURRENT_CATALOG_VERSION } from '../../src/sensorMap/catalogVersion';

const MAC = 'AA:BB:CC:DD:EE:01';
const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

interface Rig { root: string; persistDir: string; configPath: string; deps: HandlerDeps }
const rigs: Rig[] = [];

function makeRig(blocks: Record<string, unknown>[]): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'adoption-'));
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test' }, platforms: blocks }, null, 2));
  const rig: Rig = { root, persistDir, configPath, deps: { persistDir, log: silentLog, version: 'test', configPath } };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rmSync(rig.root, { recursive: true, force: true });
  }
});

function discoveryStore(rig: Rig): void {
  writeFileSync(path.join(rig.persistDir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    entries: [
      { stationMac: MAC, stationName: 'Home', dataPoint: 'tempf', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
    ],
  }));
}

/** Validate-then-commit, exactly as the orchestrator drives it. */
async function commit(rig: Rig, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const validated = await handleComposeSave(rig.deps, payload);
  expect(validated.ok, validated.ok ? '' : `validate refused: ${(validated as { error: { code: string; message: string } }).error.code}`).toBe(true);
  if (!validated.ok) throw new Error('unreachable');
  const committed = await handleCommitSave(rig.deps, { ...payload, validationToken: validated.validationToken });
  expect(committed.ok, committed.ok ? '' : `commit refused: ${(committed as { error: { code: string } }).error.code}`).toBe(true);
  if (!committed.ok) throw new Error('unreachable');
  return committed.nextConfig as Record<string, unknown>;
}

const V2_BLOCK = {
  platform: 'AmbientWeatherSensors', name: 'AW',
  apiKey: 'k', applicationKey: 'a', _sensorMapV2: true,
  configVersion: 2, sensorMap: [] as unknown[],
};

const LEGACY_BLOCK = {
  platform: 'AmbientWeatherSensors', name: 'AW',
  apiKey: 'k', applicationKey: 'a', _sensorMapV2: true,
  temperatureSensors: true,
};

describe('birth stamps and preservation (§18.3)', () => {
  it('a fresh installation is born stamped at the current catalog version', async () => {
    const rig = makeRig([]);
    const preview = await handlePreviewSave(rig.deps, {
      baseDigest: FRESH_INSTALL_DIGEST, proposal: [], settings: { apiKey: { set: 'k' }, applicationKey: { set: 'a' } },
    });
    expect(preview.ok).toBe(true);
    const validated = await handleComposeSave(rig.deps, {
      baseDigest: FRESH_INSTALL_DIGEST, proposal: [], settings: { apiKey: { set: 'k' }, applicationKey: { set: 'a' } },
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const block = validated.nextConfig as Record<string, unknown>;
    expect(block.catalogBaseline).toBe(CURRENT_CATALOG_VERSION);
    expect(block.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);
    // Born plain otherwise: no conversion happened.
    expect(block.configVersion).toBeUndefined();
    expect(block.sensorMap).toBeUndefined();
  });

  it('converting an unstamped legacy config initializes exactly (1, 1)', async () => {
    const rig = makeRig([LEGACY_BLOCK]);
    discoveryStore(rig);
    const next = await commit(rig, { base: LEGACY_BLOCK });
    expect(next.configVersion).toBe(2);
    expect(next.catalogBaseline).toBe(1);
    expect(next.catalogAdopted).toBe(1);
  });

  it('the first sensor-map save of a config born at (2, 2) preserves the pair verbatim — never rewinds', async () => {
    const born = { ...LEGACY_BLOCK, catalogBaseline: CURRENT_CATALOG_VERSION, catalogAdopted: CURRENT_CATALOG_VERSION };
    const rig = makeRig([born]);
    discoveryStore(rig);
    const next = await commit(rig, { base: born });
    expect(next.configVersion).toBe(2);
    expect(next.catalogBaseline).toBe(CURRENT_CATALOG_VERSION);
    expect(next.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);
  });

  it('an ordinary v2 save preserves existing stamps and never advances them', async () => {
    const stamped = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: 1 };
    const rig = makeRig([stamped]);
    discoveryStore(rig);
    const next = await commit(rig, {
      base: stamped,
      proposal: [{ dataPoint: 'tempf', name: 'Yard' }],
    });
    expect(next.catalogBaseline).toBe(1);
    expect(next.catalogAdopted).toBe(1);
  });
});

describe('explicit adoption (§18.3)', () => {
  it('adoption advances catalogAdopted only, previews ZERO accessory consequences, and leaves the sensorMap alone', async () => {
    const rig = makeRig([V2_BLOCK]);
    discoveryStore(rig);
    const payload = { base: V2_BLOCK, proposal: [], adoptCatalogVersion: CURRENT_CATALOG_VERSION };
    const preview = await handlePreviewSave(rig.deps, payload);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // Adopted definitions arrive DISABLED, so adoption alone
    // registers, removes, and re-registers nothing.
    expect(preview.changes).toEqual([]);

    // The commit returns the persistable config (the CLIENT persists
    // it through the HB UI config API) with only the stamp advanced.
    const next = await commit(rig, payload);
    expect(next.catalogBaseline).toBe(1);
    expect(next.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);
    expect(next.sensorMap).toEqual([]);
  });

  it('adoption is refused on a legacy configuration (convert first)', async () => {
    const rig = makeRig([LEGACY_BLOCK]);
    discoveryStore(rig);
    const r = await handlePreviewSave(rig.deps, { base: LEGACY_BLOCK, adoptCatalogVersion: CURRENT_CATALOG_VERSION });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-adoption');
  });

  it('adoption is refused for any version other than the shipped catalog', async () => {
    const rig = makeRig([V2_BLOCK]);
    discoveryStore(rig);
    for (const v of [1, CURRENT_CATALOG_VERSION + 1, 'x', null]) {
      const r = await handlePreviewSave(rig.deps, { base: V2_BLOCK, proposal: [], adoptCatalogVersion: v });
      expect(r.ok, `adoptCatalogVersion ${String(v)}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-adoption');
    }
  });

  it('adoption is refused on the fresh-install path (born current)', async () => {
    const rig = makeRig([]);
    const r = await handlePreviewSave(rig.deps, {
      baseDigest: FRESH_INSTALL_DIGEST, proposal: [],
      settings: { apiKey: { set: 'k' } }, adoptCatalogVersion: CURRENT_CATALOG_VERSION,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-adoption');
  });

  it('enabling an adopted definition is an ordinary previewed structural save', async () => {
    const adopted = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION };
    const rig = makeRig([adopted]);
    discoveryStore(rig);
    const payload = { base: adopted, proposal: [{ dataPoint: 'windgustdir', enabled: true }] };
    const preview = await handlePreviewSave(rig.deps, payload);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const added = preview.changes.filter(c => c.change === 'added');
    expect(added.map(c => c.dataPoint)).toContain('windgustdir');
    const next = await commit(rig, { ...payload, confirmDigest: preview.digest });
    expect((next.sensorMap as unknown[]).length).toBeGreaterThan(0);
    expect(next.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);
  });
});

describe('fail-closed stamps at the save boundary (§18.3)', () => {
  it('a v2 block with invalid stamps refuses saves as safe mode', async () => {
    const broken = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION + 7 };
    const rig = makeRig([broken]);
    discoveryStore(rig);
    const r = await handlePreviewSave(rig.deps, { base: broken, proposal: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('safe-mode');
  });

  it('a legacy block with hand-broken stamps refuses conversion with the stamp diagnostic', async () => {
    const broken = { ...LEGACY_BLOCK, catalogAdopted: 2 };
    const rig = makeRig([broken]);
    discoveryStore(rig);
    const r = await handlePreviewSave(rig.deps, { base: broken });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('catalog-stamps');
  });

  it('repairing the stamps restores normal saves', async () => {
    const repaired = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: 1 };
    const rig = makeRig([repaired]);
    discoveryStore(rig);
    const r = await handlePreviewSave(rig.deps, { base: repaired, proposal: [] });
    expect(r.ok).toBe(true);
  });
});

describe('the editor view of adoption (§18.4 AP-2, /editor-state)', () => {
  it('an unstamped v2 config reports (1, 1) with the current version, and adopted definitions stay invisible', async () => {
    const rig = makeRig([V2_BLOCK]);
    discoveryStore(rig);
    const state = await handleGetEditorState(rig.deps, {});
    expect(state.catalog).toEqual({ baseline: 1, adopted: 1, current: CURRENT_CATALOG_VERSION });
    expect(state.rows.find(r => r.dataPoint === 'windgustdir')).toBeUndefined();
  });

  it('after adoption the definitions appear as disabled KNOWN rows; an explicit assignment stays custom', async () => {
    const adopted = {
      ...V2_BLOCK,
      catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION,
      sensorMap: [{
        dataPoint: 'windspdmph_avg10m', stationMac: MAC,
        kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph',
        name: 'Wind Speed Average',
      }],
    };
    const rig = makeRig([adopted]);
    discoveryStore(rig);
    const state = await handleGetEditorState(rig.deps, {});
    expect(state.catalog).toEqual({ baseline: 1, adopted: CURRENT_CATALOG_VERSION, current: CURRENT_CATALOG_VERSION });

    const gustDir = state.rows.find(r => r.dataPoint === 'windgustdir');
    expect(gustDir).toBeDefined();
    expect(gustDir!.enabled).toBe(false);
    expect(gustDir!.identityScope).toBe('known');
    // Use defaults attaches for inherited-identity rows (the F2 rule
    // keyed on identityScope 'known').
    expect(gustDir!.defaults).toBeDefined();
    expect(gustDir!.defaults!.enabled).toBe(false);

    const wind = state.rows.find(r => r.dataPoint === 'windspdmph_avg10m' && r.stationMac === MAC);
    expect(wind).toBeDefined();
    expect(wind!.identityScope).toBe('custom-station');
    expect(wind!.name).toBe('Wind Speed Average');
    expect(wind!.enabled).toBe(true);
  });

  it('a safe-mode config (broken stamps) reports no catalog state and a read-only editor', async () => {
    const broken = { ...V2_BLOCK, catalogBaseline: 'x', catalogAdopted: 1 };
    const rig = makeRig([broken]);
    const state = await handleGetEditorState(rig.deps, {});
    expect(state.configMode).toBe('safe-mode');
    expect(state.catalog).toBeUndefined();
    expect(state.editorAvailable).toBe(false);
  });
});

/**
 * Generic numeric passthrough through the guarded save pipeline
 * (issue #63 P3.1 — sensor-map.md §19.9). Adoption of catalog 4 makes
 * the pair resolvable; a numeric assignment previews as `added` and
 * commits; a label-only edit is a non-structural, digest-bound change;
 * the digest binds the label (a stale confirmation refuses); and a
 * refused commit writes nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  handleCommitSave,
  handleComposeSave,
  handlePreviewSave,
  type HandlerDeps,
} from '../../homebridge-ui/handlers';
import { CURRENT_CATALOG_VERSION } from '../../src/sensorMap/catalogVersion';

const MAC = 'AA:BB:CC:DD:EE:01';
const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

interface Rig { root: string; persistDir: string; configPath: string; deps: HandlerDeps }
const rigs: Rig[] = [];

function makeRig(blocks: Record<string, unknown>[]): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'numeric-adopt-'));
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test' }, platforms: blocks }, null, 2));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    entries: [
      { stationMac: MAC, stationName: 'Home', dataPoint: 'tempf', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
      { stationMac: MAC, stationName: 'Home', dataPoint: 'flow1', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
    ],
  }));
  const rig: Rig = { root, persistDir, configPath, deps: { persistDir, log: silentLog, version: 'test', configPath } };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rmSync(rig.root, { recursive: true, force: true });
  }
});

async function commit(rig: Rig, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const validated = await handleComposeSave(rig.deps, payload);
  expect(validated.ok, validated.ok ? '' : `validate refused: ${(validated as { error: { code: string } }).error.code}`).toBe(true);
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
const NUMERIC = {
  dataPoint: 'flow1', kind: 'motion', measurement: 'numeric', sourceUnit: 'raw',
  unitLabel: 'L/min', name: 'Irrigation Flow',
};

describe('numeric adoption through the guarded pipeline (§19.9)', () => {
  it('adopting catalog 4 with a numeric assignment previews as added and commits with its label', async () => {
    const rig = makeRig([{ ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: 1 }]);
    const payload = {
      base: { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: 1 },
      proposal: [NUMERIC], adoptCatalogVersion: CURRENT_CATALOG_VERSION,
    };
    const preview = await handlePreviewSave(rig.deps, payload);
    expect(preview.ok, preview.ok ? '' : (preview as { error: { code: string } }).error.code).toBe(true);
    if (!preview.ok) return;
    const added = preview.changes.filter(c => c.change === 'added');
    expect(added.map(c => c.dataPoint)).toContain('flow1');
    expect(added.find(c => c.dataPoint === 'flow1')!.after!.unitLabel).toBe('L/min');

    const next = await commit(rig, { ...payload, confirmDigest: preview.digest });
    expect(next.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);
    const saved = (next.sensorMap as Record<string, unknown>[]).find(r => r.dataPoint === 'flow1');
    expect(saved).toMatchObject({ measurement: 'numeric', sourceUnit: 'raw', unitLabel: 'L/min' });
  });

  it('a label-only edit is a non-structural, digest-bound change', async () => {
    const adopted = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION, sensorMap: [NUMERIC] };
    const rig = makeRig([adopted]);
    const payload = { base: adopted, proposal: [{ ...NUMERIC, unitLabel: 'gpm' }] };
    const preview = await handlePreviewSave(rig.deps, payload);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const change = preview.changes.find(c => c.dataPoint === 'flow1');
    expect(change, 'label change surfaced').toBeDefined();
    expect(change!.change).toBe('modified');
    expect(change!.structural).toBe(false);            // no re-registration
    expect(change!.after!.unitLabel).toBe('gpm');

    const next = await commit(rig, { ...payload, confirmDigest: preview.digest });
    const saved = (next.sensorMap as Record<string, unknown>[]).find(r => r.dataPoint === 'flow1');
    expect(saved!.unitLabel).toBe('gpm');
  });

  it('the digest binds the label: a confirmation for a different label refuses as stale', async () => {
    const adopted = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION, sensorMap: [NUMERIC] };
    const rig = makeRig([adopted]);
    const previewA = await handlePreviewSave(rig.deps, { base: adopted, proposal: [{ ...NUMERIC, unitLabel: 'L/min' }] });
    const previewB = await handlePreviewSave(rig.deps, { base: adopted, proposal: [{ ...NUMERIC, unitLabel: 'gpm' }] });
    expect(previewA.ok && previewB.ok).toBe(true);
    if (!previewA.ok || !previewB.ok) return;
    // Different label ⇒ different digest (the label is in the digest).
    expect(previewA.digest).not.toBe(previewB.digest);

    // Commit the label-'gpm' proposal but confirm with the STALE 'L/min'
    // digest: the guarded save refuses and writes nothing.
    const before = readFileSync(rig.configPath, 'utf8');
    const validated = await handleComposeSave(rig.deps, {
      base: adopted, proposal: [{ ...NUMERIC, unitLabel: 'gpm' }], confirmDigest: previewA.digest,
    });
    expect(validated.ok).toBe(false);
    expect(readFileSync(rig.configPath, 'utf8'), 'no durable write on refusal').toBe(before);
  });

  it('rejects a bidi-control (U+061C) label at the real save boundary with zero writes', async () => {
    const adopted = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION, sensorMap: [NUMERIC] };
    const rig = makeRig([adopted]);
    const before = readFileSync(rig.configPath, 'utf8');
    // U+061C ARABIC LETTER MARK is Bidi_Control; built from a code point
    // so this source stays reviewable ASCII.
    const bad = `x${String.fromCodePoint(0x061C)}y`;
    const payload = { base: adopted, proposal: [{ ...NUMERIC, unitLabel: bad }] };
    const preview = await handlePreviewSave(rig.deps, payload);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.code).toBe('invalid-rows');
    const compose = await handleComposeSave(rig.deps, payload);
    expect(compose.ok).toBe(false);
    expect(readFileSync(rig.configPath, 'utf8'), 'no durable write on refusal').toBe(before);
  });

  it('a disabled numeric row change is config-only, not a registered change', async () => {
    const disabled = { ...NUMERIC, enabled: false };
    const adopted = { ...V2_BLOCK, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION, sensorMap: [disabled] };
    const rig = makeRig([adopted]);
    const payload = { base: adopted, proposal: [{ ...disabled, unitLabel: 'gpm' }] };
    const preview = await handlePreviewSave(rig.deps, payload);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // A disabled row has no live accessory, so a change to it is
    // config-only, never a structural/registered change.
    expect(preview.changes.some(c => c.dataPoint === 'flow1')).toBe(false);
    expect(preview.configOnly.some(c => c.dataPoint === 'flow1')).toBe(true);
    const next = await commit(rig, { ...payload, confirmDigest: preview.digest });
    const saved = (next.sensorMap as Record<string, unknown>[]).find(r => r.dataPoint === 'flow1');
    expect(saved).toMatchObject({ unitLabel: 'gpm', enabled: false });
  });
});

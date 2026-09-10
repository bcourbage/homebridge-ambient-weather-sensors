/**
 * /preview-save — the server-authoritative save dry run (#69 PR B).
 *
 * Contract under test:
 *   - ZERO writes, even where the real save would write the legacy
 *     snapshot (the pure-migration case);
 *   - the preview runs the EXACT save pipeline: same refusal codes,
 *     same canonical output as /compose-save for the same input;
 *   - the diff labels added/removed configured rows structural, and
 *     modified rows structural only when the signature changes;
 *   - a legacy pure migration previews as CHANGE-FREE (migration
 *     equivalence, §11);
 *   - the digest is deterministic and sensitive to base and proposal;
 *   - the malformed-sensorMap hard stop refuses preview AND save.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleCommitSave, handleComposeSave, handlePreviewSave, type HandlerDeps } from '../../../homebridge-ui/handlers';
import { syncDynamicSchema } from '../../../src/sensorMap/dynamicSchema';
import { PLUGIN_NAME } from '../../../src/settings';
import { LEGACY_SNAPSHOT_FILE } from '../../../src/sensorMap/legacyMirror';

const MAC = 'AA:BB:CC:DD:EE:01';
const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

interface Rig {
  root: string;
  persistDir: string;
  configPath: string;
  deps: HandlerDeps;
}

const rigs: Rig[] = [];

function makeRig(platformBlock: Record<string, unknown>): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'preview-save-'));
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: [platformBlock] }, null, 2));
  const rig: Rig = { root, persistDir, configPath, deps: { persistDir, log: silentLog, version: 'test', configPath } };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rmSync(rig.root, { recursive: true, force: true });
  }
});

function discoveryStore(rig: Rig, dataPoints: string[]): void {
  writeFileSync(path.join(rig.persistDir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    entries: dataPoints.map(dp => ({
      stationMac: MAC, stationName: 'Home', dataPoint: dp,
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
    })),
  }));
}

const LEGACY_BLOCK = {
  platform: 'AmbientWeatherSensors',
  name: 'Test Station',
  apiKey: 'k', applicationKey: 'a',
  _sensorMapV2: true,
  temperatureSensors: true,
  windSensors: true,
};

const CUSTOM_ROW = { dataPoint: 'customtemp1', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius' };

const V2_BLOCK = {
  platform: 'AmbientWeatherSensors',
  name: 'Test Station',
  apiKey: 'k', applicationKey: 'a',
  _sensorMapV2: true,
  configVersion: 2,
  sensorMap: [CUSTOM_ROW],
};

describe('/preview-save — no writes, ever', () => {
  it('a legacy pure-migration preview writes NOTHING (the save would write the snapshot)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, ['tempf', 'windspeedmph']);
    const configBefore = readFileSync(rig.configPath, 'utf8');
    const filesBefore = readdirSync(rig.persistDir).sort();

    const result = await handlePreviewSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(true);

    expect(readFileSync(rig.configPath, 'utf8')).toBe(configBefore);
    expect(readdirSync(rig.persistDir).sort()).toEqual(filesBefore);
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });
});

describe('/preview-save — diff semantics', () => {
  it('a legacy pure migration previews as change-free (migration equivalence)', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, ['tempf', 'windspeedmph']);
    const result = await handlePreviewSave(rig.deps, { base: LEGACY_BLOCK });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([]);
      expect(result.structuralChangeCount).toBe(0);
      expect(result.canonicalSensorMap.length).toBeGreaterThan(0);
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.rows.length).toBeGreaterThan(0);
    }
  });

  it('a rename previews as modified, NOT structural', async () => {
    const rig = makeRig(V2_BLOCK);
    discoveryStore(rig, ['tempf']);
    const result = await handlePreviewSave(rig.deps, {
      base: V2_BLOCK,
      proposal: [CUSTOM_ROW, { dataPoint: 'tempf', name: 'Patio Temp' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const change = result.changes.find(c => c.dataPoint === 'tempf');
      expect(change).toMatchObject({ change: 'modified', structural: false });
      expect(change?.before?.name).not.toBe('Patio Temp');
      expect(change?.after?.name).toBe('Patio Temp');
      expect(result.structuralChangeCount).toBe(0);
    }
  });

  it('adding a battery field previews as modified AND structural', async () => {
    const rig = makeRig(V2_BLOCK);
    discoveryStore(rig, ['tempf', 'customtemp1']);
    const result = await handlePreviewSave(rig.deps, {
      base: V2_BLOCK,
      proposal: [{ ...CUSTOM_ROW, batteryField: 'barn_batt' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const change = result.changes.find(c => c.dataPoint === 'customtemp1');
      expect(change).toMatchObject({ change: 'modified', structural: true });
      expect(result.structuralChangeCount).toBe(1);
    }
  });

  it('new and removed custom rows preview as structural added/removed', async () => {
    const rig = makeRig(V2_BLOCK);
    discoveryStore(rig, ['tempf']);
    const added = await handlePreviewSave(rig.deps, {
      base: V2_BLOCK,
      proposal: [CUSTOM_ROW, { dataPoint: 'customhum1', kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent' }],
    });
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.changes.find(c => c.dataPoint === 'customhum1'))
        .toMatchObject({ change: 'added', structural: true });
      expect(added.changes.find(c => c.dataPoint === 'customhum1')?.before).toBeUndefined();
    }
    const removed = await handlePreviewSave(rig.deps, { base: V2_BLOCK, proposal: [] });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.changes.find(c => c.dataPoint === 'customtemp1'))
        .toMatchObject({ change: 'removed', structural: true });
    }
  });

  it('disabling a row previews as REMOVED, structural: its accessory deregisters (review #43 P1-1)', async () => {
    // The runtime registers only configured AND enabled rows, so
    // disabling is a deregistration, never an in-place update — for
    // battery hosts and plain rows alike.
    const rig = makeRig(V2_BLOCK);
    discoveryStore(rig, ['tempf', 'humidity']);
    for (const dp of ['tempf', 'humidity']) {
      const result = await handlePreviewSave(rig.deps, {
        base: V2_BLOCK,
        proposal: [CUSTOM_ROW, { dataPoint: dp, enabled: false }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const change = result.changes.find(c => c.dataPoint === dp);
        expect(change).toMatchObject({ change: 'removed', structural: true });
        expect(change?.after).toBeUndefined();
        expect(result.structuralChangeCount).toBe(1);
      }
    }
  });

  it('enabling a disabled row previews as ADDED, structural: its accessory registers', async () => {
    const disabledBlock = {
      ...V2_BLOCK,
      sensorMap: [CUSTOM_ROW, { dataPoint: 'humidity', enabled: false }],
    };
    const rig = makeRig(disabledBlock);
    discoveryStore(rig, ['tempf', 'humidity']);
    const result = await handlePreviewSave(rig.deps, {
      base: disabledBlock,
      proposal: [CUSTOM_ROW, { dataPoint: 'humidity', enabled: true }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const change = result.changes.find(c => c.dataPoint === 'humidity');
      expect(change).toMatchObject({ change: 'added', structural: true });
      expect(change?.before).toBeUndefined();
    }
  });

  it('an edit to a row that stays disabled has no accessory consequences', async () => {
    const disabledBlock = {
      ...V2_BLOCK,
      sensorMap: [CUSTOM_ROW, { dataPoint: 'humidity', enabled: false }],
    };
    const rig = makeRig(disabledBlock);
    discoveryStore(rig, ['tempf', 'humidity']);
    const result = await handlePreviewSave(rig.deps, {
      base: disabledBlock,
      proposal: [CUSTOM_ROW, { dataPoint: 'humidity', enabled: false, name: 'Renamed While Off' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([]);
    }
  });
});

describe('/preview-save — digest', () => {
  it('is deterministic for identical input and sensitive to the proposal', async () => {
    const rig = makeRig(V2_BLOCK);
    discoveryStore(rig, ['tempf']);
    const a = await handlePreviewSave(rig.deps, { base: V2_BLOCK, proposal: [CUSTOM_ROW] });
    const b = await handlePreviewSave(rig.deps, { base: V2_BLOCK, proposal: [CUSTOM_ROW] });
    const c = await handlePreviewSave(rig.deps, {
      base: V2_BLOCK,
      proposal: [{ ...CUSTOM_ROW, name: 'Different' }],
    });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.digest).toBe(b.digest);
      expect(c.digest).not.toBe(a.digest);
    }
  });
});

describe('/preview-save — digest binds the CONSEQUENCES (review #43 P1-2)', () => {
  it('the digest changes when discovery gains a station, even with identical base and proposal', async () => {
    const rig = makeRig(V2_BLOCK);
    discoveryStore(rig, ['tempf']);
    const first = await handlePreviewSave(rig.deps, { base: V2_BLOCK, proposal: [CUSTOM_ROW] });
    expect(first.ok).toBe(true);

    // Station B appears in discovery after the preview: the same
    // global proposal now affects MORE accessories, so the confirm
    // token from the first preview must be invalid.
    const OTHER = 'AA:BB:CC:DD:EE:99';
    writeFileSync(path.join(rig.persistDir, 'discovery.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [
        { stationMac: MAC, stationName: 'Home', dataPoint: 'tempf', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
        { stationMac: OTHER, stationName: 'Cabin', dataPoint: 'tempf', firstSeen: '2026-01-03T00:00:00Z', lastSeen: '2026-01-03T00:00:00Z' },
      ],
    }));
    const second = await handlePreviewSave(rig.deps, { base: V2_BLOCK, proposal: [CUSTOM_ROW] });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.digest).not.toBe(first.digest);
    }
  });
});

describe('/preview-save and /editor-state — corrupt stores are never quarantined by the bridge (review #43 P2-6)', () => {
  it('a malformed discovery.json is read as empty and LEFT IN PLACE', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    writeFileSync(path.join(rig.persistDir, 'discovery.json'), '{not json');
    writeFileSync(path.join(rig.persistDir, 'ui-state.json'), '{"schemaVersion": 99}');
    const before = readdirSync(rig.persistDir).sort();
    const bytesBefore = readFileSync(path.join(rig.persistDir, 'discovery.json'), 'utf8');

    const result = await handlePreviewSave(rig.deps, {
      base: LEGACY_BLOCK,
      cachedAccessoryUniqueIds: [`${MAC}-tempf`],
    });
    expect(result.ok).toBe(true); // inventory degrades to cached accessories

    // The bridge is a read-only consumer (§8 single-writer): no
    // quarantine rename, no new files, bytes untouched.
    expect(readdirSync(rig.persistDir).sort()).toEqual(before);
    expect(readFileSync(path.join(rig.persistDir, 'discovery.json'), 'utf8')).toBe(bytesBefore);
  });
});

describe('/preview-save — pipeline parity with /compose-save', () => {
  it('same input produces the same canonical sensorMap the save composes', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, ['tempf', 'windspeedmph']);
    const preview = await handlePreviewSave(rig.deps, { base: LEGACY_BLOCK });
    const save = await handleComposeSave(rig.deps, { base: LEGACY_BLOCK });
    expect(preview.ok && save.ok).toBe(true);
    if (preview.ok && save.ok) {
      expect(preview.canonicalSensorMap).toEqual(save.canonicalSensorMap);
    }
  });

  it('refuses with the same codes the save uses', async () => {
    const rig = makeRig(LEGACY_BLOCK);
    discoveryStore(rig, ['tempf']);
    const stale = await handlePreviewSave(rig.deps, { base: { ...LEGACY_BLOCK, windSensors: false } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('stale-base');
    }

    const safeBlock = { ...LEGACY_BLOCK, configVersion: 99 };
    const rig2 = makeRig(safeBlock);
    discoveryStore(rig2, ['tempf']);
    const safe = await handlePreviewSave(rig2.deps, { base: safeBlock });
    expect(safe.ok).toBe(false);
    if (!safe.ok) {
      expect(safe.error.code).toBe('safe-mode');
    }

    const rig3 = makeRig(V2_BLOCK);
    discoveryStore(rig3, ['tempf']);
    const invalid = await handlePreviewSave(rig3.deps, {
      base: V2_BLOCK,
      proposal: [{ dataPoint: 'broken', measurement: 'temperature', sourceUnit: 'celsius' }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('invalid-rows');
    }
  });

  it('the malformed-sensorMap hard stop refuses BOTH preview and save', async () => {
    const shapeBlock = { ...V2_BLOCK, sensorMap: 'oops' };
    const rig = makeRig(shapeBlock);
    discoveryStore(rig, ['tempf']);
    const preview = await handlePreviewSave(rig.deps, { base: shapeBlock, proposal: [] });
    const save = await handleComposeSave(rig.deps, { base: shapeBlock, proposal: [] });
    expect(preview.ok).toBe(false);
    expect(save.ok).toBe(false);
    if (!preview.ok && !save.ok) {
      expect(preview.error.code).toBe('sensor-map-shape');
      expect(save.error.code).toBe('sensor-map-shape');
    }
    expect(existsSync(path.join(rig.persistDir, LEGACY_SNAPSHOT_FILE))).toBe(false);
  });
});

describe('config-only changes: disabled rows whose settings change (beta.15 RC feedback)', () => {
  it('a unit change on a disabled row lists under configOnly, not changes', async () => {
    const BLOCK = {
      platform: 'AmbientWeatherSensors',
      name: 'Test Station',
      apiKey: 'k', applicationKey: 'a',
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'weeklyrainin', enabled: false, displayUnit: 'in' }],
    };
    const rig = makeRig(BLOCK);
    discoveryStore(rig, ['weeklyrainin', 'windspeedmph']);
    const result = await handlePreviewSave(rig.deps, {
      base: BLOCK,
      proposal: [{ dataPoint: 'weeklyrainin', enabled: false, displayUnit: 'mm' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // No accessory registers or updates...
    expect(result.changes).toEqual([]);
    expect(result.structuralChangeCount).toBe(0);
    // ...but the saved-configuration change is visible, disabled on
    // both sides, with the unit diff carried in before/after.
    expect(result.configOnly).toHaveLength(1);
    const entry = result.configOnly[0];
    expect(entry.dataPoint).toBe('weeklyrainin');
    expect(entry.before.enabled).toBe(false);
    expect(entry.after.enabled).toBe(false);
    expect(entry.before.displayUnit).toBe('in');
    expect(entry.after.displayUnit).toBe('mm');
  });

  it('an unchanged disabled row and an enabled-row change produce no configOnly entries', async () => {
    const BLOCK = {
      platform: 'AmbientWeatherSensors',
      name: 'Test Station',
      apiKey: 'k', applicationKey: 'a',
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'weeklyrainin', enabled: false, displayUnit: 'in' }],
    };
    const rig = makeRig(BLOCK);
    discoveryStore(rig, ['weeklyrainin', 'windspeedmph']);
    const result = await handlePreviewSave(rig.deps, {
      base: BLOCK,
      proposal: [
        { dataPoint: 'weeklyrainin', enabled: false, displayUnit: 'in' },
        { dataPoint: 'windspeedmph', displayUnit: 'kph' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.configOnly).toEqual([]);
    expect(result.changes.map(c => c.dataPoint)).toEqual(['windspeedmph']);
  });
});

describe('unsaved-settings gate vs the dynamic schema (beta.15 conversion smoke)', () => {
  const V2_MIRRORED_BLOCK = {
    platform: 'AmbientWeatherSensors',
    name: 'Test Station',
    apiKey: 'k', applicationKey: 'a',
    _sensorMapV2: true,
    configVersion: 2,
    sensorMap: [{ dataPoint: 'windspeedmph', displayUnit: 'kph' }],
    // Mirror-maintained legacy field the dynamic schema HIDES from
    // the form: the form's copy will not carry it.
    temperatureSensors: true,
  };

  /** The orchestrator's two-phase flow: validate, then commit (the
   *  formBlock gate runs at commit). */
  async function commitWithForm(rig: Rig, formBlock: Record<string, unknown>) {
    const payload = {
      base: V2_MIRRORED_BLOCK,
      formBlock,
      proposal: [{ dataPoint: 'windspeedmph', displayUnit: 'mph' }],
    };
    const validated = await handleComposeSave(rig.deps, payload);
    if (!validated.ok) {
      return validated;
    }
    return handleCommitSave(rig.deps, { ...payload, validationToken: validated.validationToken });
  }

  async function writeDynamicSchema(rig: Rig): Promise<void> {
    await syncDynamicSchema({
      storagePath: rig.root, pluginName: PLUGIN_NAME,
      packagedSchemaPath: path.join(__dirname, '..', '..', '..', 'config.schema.json'),
      configPath: rig.configPath,
      log: silentLog,
    });
  }

  it('a form copy missing a dynamic-schema-hidden field is NOT an unsaved edit', async () => {
    const rig = makeRig(V2_MIRRORED_BLOCK);
    rig.deps.storagePath = rig.root;
    discoveryStore(rig, ['windspeedmph']);
    await writeDynamicSchema(rig);
    const { temperatureSensors, ...formBlock } = V2_MIRRORED_BLOCK;
    void temperatureSensors;
    const result = await commitWithForm(rig, formBlock);
    expect(result.ok).toBe(true);
  });

  it('without the dynamic schema the same absence still refuses (a form that RENDERS the control may hold a real edit)', async () => {
    const rig = makeRig(V2_MIRRORED_BLOCK);
    rig.deps.storagePath = rig.root; // no dynamic schema file written
    discoveryStore(rig, ['windspeedmph']);
    const { temperatureSensors, ...formBlock } = V2_MIRRORED_BLOCK;
    void temperatureSensors;
    const result = await commitWithForm(rig, formBlock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
      expect(result.error.message).toContain('temperatureSensors');
    }
  });

  it('a REAL edit to a control the dynamic schema still renders is refused', async () => {
    const rig = makeRig(V2_MIRRORED_BLOCK);
    rig.deps.storagePath = rig.root;
    discoveryStore(rig, ['windspeedmph']);
    await writeDynamicSchema(rig);
    const result = await commitWithForm(rig, { ...V2_MIRRORED_BLOCK, apiKey: 'edited-in-the-form' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsaved-settings-changes');
      expect(result.error.message).toContain('apiKey');
    }
  });
});

describe('configOnly additions and removals (review round 6 F4)', () => {
  const BLOCK_WITH_DISABLED_CUSTOM = {
    platform: 'AmbientWeatherSensors',
    name: 'Test Station',
    apiKey: 'k', applicationKey: 'a',
    _sensorMapV2: true,
    configVersion: 2,
    sensorMap: [{
      dataPoint: 'barn_wind', stationMac: MAC, kind: 'motion', measurement: 'wind-speed',
      sourceUnit: 'mph', enabled: false, name: 'Barn Wind',
    }],
  };

  it('removing a disabled custom override lists as a config-only removal', async () => {
    const rig = makeRig(BLOCK_WITH_DISABLED_CUSTOM);
    discoveryStore(rig, ['windspeedmph', 'barn_wind']);
    const result = await handlePreviewSave(rig.deps, {
      base: BLOCK_WITH_DISABLED_CUSTOM,
      proposal: [], // Use defaults on the disabled custom row: fragment gone
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.changes).toEqual([]); // never enabled: no accessory change
    const removed = result.configOnly.find(c => c.dataPoint === 'barn_wind');
    expect(removed?.change).toBe('removed');
    expect(removed?.before?.enabled).toBe(false);
    expect(removed?.after).toBeUndefined();
  });

  it('adding a disabled custom row lists as a config-only addition', async () => {
    const BASE = { ...BLOCK_WITH_DISABLED_CUSTOM, sensorMap: [] };
    const rig = makeRig(BASE);
    discoveryStore(rig, ['windspeedmph', 'barn_wind']);
    const result = await handlePreviewSave(rig.deps, {
      base: BASE,
      proposal: [BLOCK_WITH_DISABLED_CUSTOM.sensorMap[0]],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.changes).toEqual([]);
    const added = result.configOnly.find(c => c.dataPoint === 'barn_wind');
    expect(added?.change).toBe('added');
    expect(added?.after?.enabled).toBe(false);
    expect(added?.before).toBeUndefined();
  });

  it('an enabled-to-disabled transition stays an accessory change, not a config-only entry', async () => {
    const ENABLED = {
      ...BLOCK_WITH_DISABLED_CUSTOM,
      sensorMap: [{ ...BLOCK_WITH_DISABLED_CUSTOM.sensorMap[0], enabled: true }],
    };
    const rig = makeRig(ENABLED);
    discoveryStore(rig, ['windspeedmph', 'barn_wind']);
    const result = await handlePreviewSave(rig.deps, {
      base: ENABLED,
      proposal: [BLOCK_WITH_DISABLED_CUSTOM.sensorMap[0]], // enabled: false
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.changes.map(c => [c.dataPoint, c.change])).toEqual([['barn_wind', 'removed']]);
    expect(result.configOnly).toEqual([]);
  });
});

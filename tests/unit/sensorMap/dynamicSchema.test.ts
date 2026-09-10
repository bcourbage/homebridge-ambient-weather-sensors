/**
 * Dynamic config schema (beta.15 RC feedback): in v2-live mode the
 * settings form must stop offering the legacy controls the runtime
 * ignores. Schema conditions cannot do it (the form library's
 * condition model is schema-shaped and drops condition-hidden
 * fields), so the platform writes HB UI X's dynamic schema file and
 * removes it in every other mode.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DYNAMIC_SCHEMA_VERSION,
  V2_DEAD_LEGACY_CONTROLS,
  buildV2LiveSchema,
  dynamicSchemaPath,
  syncDynamicSchema,
  v2LiveVerdict,
} from '../../../src/sensorMap/dynamicSchema';
import { PLUGIN_NAME } from '../../../src/settings';

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const r = mkdtempSync(path.join(tmpdir(), 'dyn-schema-'));
  roots.push(r);
  return r;
}

const PACKAGED_PATH = path.join(__dirname, '..', '..', '..', 'config.schema.json');

const V2_LIVE_BLOCK = {
  platform: 'AmbientWeatherSensors', name: 'A', apiKey: 'k', applicationKey: 'a',
  _sensorMapV2: true, configVersion: 2, sensorMap: [],
};
const LEGACY_BLOCK = {
  platform: 'AmbientWeatherSensors', name: 'B', apiKey: 'k', applicationKey: 'a',
  _sensorMapV2: true, temperatureSensors: true,
};

/** Write a config.json with the given platform blocks; returns its path. */
function writeConfig(root: string, blocks: unknown[]): string {
  const p = path.join(root, 'config.json');
  writeFileSync(p, JSON.stringify({ platforms: blocks }, null, 2));
  return p;
}

function syncOpts(root: string, blocks: unknown[]) {
  return {
    storagePath: root, pluginName: PLUGIN_NAME,
    packagedSchemaPath: PACKAGED_PATH,
    configPath: writeConfig(root, blocks),
    env: {} as NodeJS.ProcessEnv,
    log: silentLog,
  };
}

describe('dynamic config schema', () => {
  it('the packaged schema declares the version this module writes', () => {
    const packaged = JSON.parse(readFileSync(PACKAGED_PATH, 'utf8')) as { dynamicSchemaVersion?: number };
    expect(packaged.dynamicSchemaVersion).toBe(DYNAMIC_SCHEMA_VERSION);
  });

  it('every dead control exists in the packaged schema (no silent drift)', () => {
    const packaged = JSON.parse(readFileSync(PACKAGED_PATH, 'utf8')) as { schema: { properties: Record<string, unknown> } };
    for (const key of V2_DEAD_LEGACY_CONTROLS) {
      expect(packaged.schema.properties[key], key).toBeDefined();
    }
  });

  it('buildV2LiveSchema removes exactly the dead controls and keeps everything else', () => {
    const packaged = JSON.parse(readFileSync(PACKAGED_PATH, 'utf8')) as { schema: { properties: Record<string, unknown> } };
    const out = buildV2LiveSchema(packaged) as typeof packaged;
    for (const key of V2_DEAD_LEGACY_CONTROLS) {
      expect(out.schema.properties[key], key).toBeUndefined();
    }
    // Controls that stay live in v2 mode survive.
    for (const key of ['name', 'apiKey', 'applicationKey', 'extendedDisplayMode', 'embedNameUpdateMinIntervalMinutes', 'dataSource']) {
      expect(out.schema.properties[key], key).toBeDefined();
    }
    // The input is not mutated.
    expect(packaged.schema.properties.units).toBeDefined();
  });

  it('the pruned form layout carries ZERO references to removed properties, at any depth (round 7)', () => {
    const packaged = JSON.parse(readFileSync(PACKAGED_PATH, 'utf8')) as { form?: unknown[] };
    const out = buildV2LiveSchema(packaged) as { form?: unknown[] };
    const dead = new Set(V2_DEAD_LEGACY_CONTROLS);
    const root = (key: string): string => key.split(/[.[]/, 1)[0];

    // The reviewer's own measure: walk EVERYTHING (plain-string
    // entries, keyed objects, nested items) and count dead references.
    const deadRefs = (node: unknown, refs: string[]): string[] => {
      if (typeof node === 'string' && dead.has(root(node))) {
        refs.push(node);
      } else if (Array.isArray(node)) {
        for (const n of node) {
          deadRefs(n, refs);
        }
      } else if (node && typeof node === 'object') {
        const o = node as { key?: unknown; items?: unknown };
        if (typeof o.key === 'string' && dead.has(root(o.key))) {
          refs.push(o.key);
        }
        deadRefs(o.items, refs);
      }
      return refs;
    };
    // The packaged layout is full of them (else this test proves
    // nothing); the pruned layout has none.
    expect(deadRefs(packaged.form, []).length).toBeGreaterThan(20);
    expect(deadRefs(out.form, [])).toEqual([]);

    const flat = JSON.stringify(out.form);
    // Containers whose keyed content all died are gone entirely...
    expect(flat).not.toContain('Motion thresholds for extended sensors');
    expect(flat).not.toContain('Display units for extended sensors');
    // ...as are help blocks describing removed controls (they would
    // float as orphaned text).
    expect(flat).not.toContain('co2_in_aqin');
    // Live controls, their helps, and their containers survive.
    expect(flat).toContain('stationFilter');
    expect(flat).toContain('_sensorMapV2');
    expect(flat).toContain('extendedDisplayMode');
  });

  it('a single v2-live block writes the file; a legacy block removes it', async () => {
    const storage = makeRoot();
    const target = dynamicSchemaPath(storage, PLUGIN_NAME);

    await syncDynamicSchema(syncOpts(storage, [V2_LIVE_BLOCK]));
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, 'utf8')) as { schema: { properties: Record<string, unknown> } };
    expect(written.schema.properties.units).toBeUndefined();
    expect(written.schema.properties.excludeSensors).toBeUndefined();
    expect(written.schema.properties.apiKey).toBeDefined();

    await syncDynamicSchema(syncOpts(storage, [LEGACY_BLOCK]));
    expect(existsSync(target)).toBe(false);
  });

  it('multiple plugin blocks conservatively keep the packaged form, in BOTH instance orders (multi-Home)', async () => {
    // Startup order must not decide which form users get: the verdict
    // is a pure function of the whole config, so every instance's sync
    // converges on the same (packaged) outcome.
    for (const blocks of [[V2_LIVE_BLOCK, LEGACY_BLOCK], [LEGACY_BLOCK, V2_LIVE_BLOCK], [V2_LIVE_BLOCK, { ...V2_LIVE_BLOCK, name: 'C' }]]) {
      const storage = makeRoot();
      const target = dynamicSchemaPath(storage, PLUGIN_NAME);
      // Seed a stale reduced schema, as if a v2-live instance had won
      // a race before the second block existed.
      await syncDynamicSchema(syncOpts(storage, [V2_LIVE_BLOCK]));
      expect(existsSync(target)).toBe(true);
      // Each instance runs the same sync against the full config;
      // simulate both processes.
      const opts = syncOpts(storage, blocks);
      await syncDynamicSchema(opts);
      expect(existsSync(target), JSON.stringify(blocks.map(b => (b as { name: string }).name))).toBe(false);
      await syncDynamicSchema(opts);
      expect(existsSync(target)).toBe(false);
    }
  });

  it('concurrent syncs converge without throwing', async () => {
    const storage = makeRoot();
    const target = dynamicSchemaPath(storage, PLUGIN_NAME);
    const opts = syncOpts(storage, [V2_LIVE_BLOCK]);
    await Promise.all([syncDynamicSchema(opts), syncDynamicSchema(opts), syncDynamicSchema(opts)]);
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, 'utf8')) as { schema: { properties: Record<string, unknown> } };
    expect(written.schema.properties.units).toBeUndefined();
  });

  it('the verdict is per-config, not per-block', () => {
    expect(v2LiveVerdict({ platforms: [V2_LIVE_BLOCK] })).toBe(true);
    expect(v2LiveVerdict({ platforms: [LEGACY_BLOCK] })).toBe(false);
    expect(v2LiveVerdict({ platforms: [{ ...V2_LIVE_BLOCK, _sensorMapV2: false }] })).toBe(false);
    expect(v2LiveVerdict({ platforms: [V2_LIVE_BLOCK, LEGACY_BLOCK] })).toBe(false);
    expect(v2LiveVerdict({ platforms: [V2_LIVE_BLOCK, { ...V2_LIVE_BLOCK, name: 'C' }] })).toBe(false);
    expect(v2LiveVerdict({ platforms: [] })).toBe(false);
    expect(v2LiveVerdict(null)).toBe(false);
  });

  it('sync failures never throw, and leave the packaged form governing (startup safety)', async () => {
    const storage = makeRoot();
    const target = dynamicSchemaPath(storage, PLUGIN_NAME);
    // Seed a reduced schema, then fail the sync (unreadable config):
    // the stale file is removed so the packaged form governs.
    await syncDynamicSchema(syncOpts(storage, [V2_LIVE_BLOCK]));
    expect(existsSync(target)).toBe(true);
    await expect(syncDynamicSchema({
      storagePath: storage, pluginName: PLUGIN_NAME,
      packagedSchemaPath: PACKAGED_PATH,
      configPath: path.join(storage, 'missing-config.json'),
      log: silentLog,
    })).resolves.toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });

  it('the dynamic path stays inside the storage directory (HB UI X boundary check)', () => {
    const storage = makeRoot();
    const target = dynamicSchemaPath(storage, PLUGIN_NAME);
    expect(path.resolve(target).startsWith(storage + path.sep)).toBe(true);
    // The scoped package name creates a dot-prefixed subdirectory.
    expect(target).toContain(`.${PLUGIN_NAME}-v${DYNAMIC_SCHEMA_VERSION}.schema.json`);
  });
});

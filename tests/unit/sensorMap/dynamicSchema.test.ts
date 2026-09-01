/**
 * Dynamic config schema (beta.15 RC feedback): in v2-live mode the
 * settings form must stop offering the legacy controls the runtime
 * ignores. Schema conditions cannot do it (the form library's
 * condition model is schema-shaped and drops condition-hidden
 * fields), so the platform writes HB UI X's dynamic schema file and
 * removes it in every other mode.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DYNAMIC_SCHEMA_VERSION,
  V2_DEAD_LEGACY_CONTROLS,
  buildV2LiveSchema,
  dynamicSchemaPath,
  syncDynamicSchema,
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

  it('v2-live sync writes the file; any other mode removes it', async () => {
    const storage = makeRoot();
    const target = dynamicSchemaPath(storage, PLUGIN_NAME);

    await syncDynamicSchema({
      storagePath: storage, pluginName: PLUGIN_NAME,
      packagedSchemaPath: PACKAGED_PATH, v2Live: true, log: silentLog,
    });
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, 'utf8')) as { schema: { properties: Record<string, unknown> } };
    expect(written.schema.properties.units).toBeUndefined();
    expect(written.schema.properties.apiKey).toBeDefined();

    await syncDynamicSchema({
      storagePath: storage, pluginName: PLUGIN_NAME,
      packagedSchemaPath: PACKAGED_PATH, v2Live: false, log: silentLog,
    });
    expect(existsSync(target)).toBe(false);
  });

  it('sync failures never throw (startup safety)', async () => {
    const storage = makeRoot();
    await expect(syncDynamicSchema({
      storagePath: storage, pluginName: PLUGIN_NAME,
      packagedSchemaPath: path.join(storage, 'missing.json'), v2Live: true, log: silentLog,
    })).resolves.toBeUndefined();
    expect(existsSync(dynamicSchemaPath(storage, PLUGIN_NAME))).toBe(false);
  });

  it('the dynamic path stays inside the storage directory (HB UI X boundary check)', () => {
    const storage = makeRoot();
    const target = dynamicSchemaPath(storage, PLUGIN_NAME);
    expect(path.resolve(target).startsWith(storage + path.sep)).toBe(true);
    // The scoped package name creates a dot-prefixed subdirectory.
    expect(target).toContain(`.${PLUGIN_NAME}-v${DYNAMIC_SCHEMA_VERSION}.schema.json`);
  });
});

/**
 * Dynamic config schema (HB UI X `dynamicSchemaVersion`).
 *
 * With `configVersion: 2` AND the sensor-map v2 flag on, the runtime
 * ignores the legacy sensor-category toggles, the extended-sensor
 * thresholds fieldset, and the display-units fieldset: the resolver
 * reads only the sensor map (the compat layer runs in legacy config
 * mode alone), and the rollback mirror maintains those legacy fields
 * as OUTPUT for 1.7.x downgrades. Showing their controls invites
 * edits that do nothing.
 *
 * Schema `condition` expressions cannot see `configVersion` (the form
 * library's condition model is schema-shaped, and declaring the field
 * hides-and-drops it from the model — both verified against a live
 * HB UI X 5.x). HB UI X's supported answer is the dynamic schema:
 * when `config.schema.json` carries `dynamicSchemaVersion: N`, the UI
 * loads `.<pluginName>-vN.schema.json` from the Homebridge storage
 * directory INSTEAD of the packaged schema, falling back to the
 * packaged one when the file is absent.
 *
 * Every platform instance syncs the file on launch, but the verdict
 * is a pure function of the COMPLETE config.json (v2LiveVerdict), so
 * concurrent instances converge on the same content regardless of
 * startup order — and with multiple blocks (multi-Home) the packaged
 * full form conservatively governs. In v2-live mode the file carries
 * the packaged schema minus the dead controls; in every other mode it
 * is deleted. A mode change takes effect on the restart that makes it
 * real (structural config changes already require one).
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { detectConfigMode } from './configMode.js';
import { writeJsonStore, type Logger } from './persistence/atomicWrite.js';
import { shadowModeEnabled } from './shadowMode.js';

/** Must match `dynamicSchemaVersion` in the packaged config.schema.json. */
export const DYNAMIC_SCHEMA_VERSION = 1;

/**
 * The legacy controls the v2-live runtime ignores. Deliberately NOT
 * including extendedDisplayMode / embedNameUpdateMinIntervalMinutes
 * (the embed×realtime battery guard reads them in both modes), nor
 * dataSource / stationFilter / credentials.
 */
export const V2_DEAD_LEGACY_CONTROLS: ReadonlyArray<string> = [
  'temperatureSensors', 'humiditySensors', 'solarRadiationSensors',
  'co2Sensors', 'airQualitySensors', 'extendedSensors',
  'windSensors', 'rainSensors', 'pressureSensors', 'uvSensors', 'lightningSensors',
  'thresholds', 'units',
  // The accessory filters are consumed only by the v1.6 pipeline
  // (parseDevices); the v2 path applies stationFilter alone, so
  // editing these in v2 mode changes no accessories and goes stale
  // against the rollback mirror.
  'excludeSensors', 'includeOnly',
];

interface PackagedSchema {
  schema?: { properties?: Record<string, unknown> };
  form?: unknown[];
  [k: string]: unknown;
}

/** The property a form key path roots at ('thresholds.uv' → 'thresholds'). */
function rootKey(key: string): string {
  return key.split(/[.[]/, 1)[0];
}

/** Does any entry (recursively) reference a property key? */
function containsKeyReference(entries: unknown[]): boolean {
  return entries.some(e => typeof e === 'string'
    || (!!e && typeof e === 'object' && !Array.isArray(e)
      && (typeof (e as { key?: unknown }).key === 'string'
        || (Array.isArray((e as { items?: unknown[] }).items)
          && containsKeyReference((e as { items: unknown[] }).items)))));
}

/**
 * Prune a form-layout entry list of everything rooted at a dead
 * property. The packaged layout uses every shape the form library
 * accepts: plain-string key references, keyed objects, containers
 * with nested `items` (dropped entirely when nothing keyed survives
 * inside), and `help` blocks that describe the control BEFORE them
 * (dropped with it, or they would float as orphaned text).
 */
function pruneFormEntries(entries: unknown[], dead: ReadonlySet<string>): unknown[] {
  const out: unknown[] = [];
  let dropFollowingHelp = false;
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (dead.has(rootKey(entry))) {
        dropFollowingHelp = true;
        continue;
      }
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as { key?: unknown; type?: unknown; items?: unknown };
      if (obj.type === 'help' && dropFollowingHelp) {
        continue;
      }
      if (typeof obj.key === 'string' && dead.has(rootKey(obj.key))) {
        dropFollowingHelp = true;
        continue;
      }
      if (Array.isArray(obj.items)) {
        const items = pruneFormEntries(obj.items, dead);
        if (!containsKeyReference(items)) {
          dropFollowingHelp = true;
          continue;
        }
        out.push({ ...obj, items });
        dropFollowingHelp = false;
        continue;
      }
    }
    out.push(entry);
    dropFollowingHelp = false;
  }
  return out;
}

/**
 * The packaged schema minus the controls dead in v2-live mode, with
 * every form-layout reference to them pruned as well (a layout entry
 * for a property that no longer exists is at best ignored by the
 * form library and at worst an error).
 */
export function buildV2LiveSchema(packaged: PackagedSchema): PackagedSchema {
  const out = structuredClone(packaged) as PackagedSchema;
  const dead = new Set(V2_DEAD_LEGACY_CONTROLS);
  const props = out.schema?.properties;
  if (props) {
    for (const key of V2_DEAD_LEGACY_CONTROLS) {
      delete props[key];
    }
  }
  if (Array.isArray(out.form)) {
    out.form = pruneFormEntries(out.form, dead);
  }
  return out;
}

/**
 * Is the settings form governed by the v2-live reduced schema? The
 * verdict is derived from the COMPLETE config, never a single
 * platform instance's block: with multiple AmbientWeatherSensors
 * blocks (multi-Home), instances would otherwise fight over the one
 * plugin-global schema file with startup order deciding the winner —
 * so multi-block (and no-block, and unreadable) configurations
 * conservatively keep the packaged full form.
 */
export function v2LiveVerdict(configJson: unknown, env?: NodeJS.ProcessEnv): boolean {
  const platforms = (configJson as { platforms?: unknown } | null)?.platforms;
  const blocks = (Array.isArray(platforms) ? platforms : [])
    .filter((b): b is Record<string, unknown> =>
      !!b && typeof b === 'object' && (b as { platform?: unknown }).platform === 'AmbientWeatherSensors');
  if (blocks.length !== 1) {
    return false;
  }
  return detectConfigMode(blocks[0] as never).mode === 'v2'
    && shadowModeEnabled({ env, config: blocks[0] });
}

/** The dynamic schema file for this plugin under the storage path. */
export function dynamicSchemaPath(storagePath: string, pluginName: string): string {
  return path.join(storagePath, `.${pluginName}-v${DYNAMIC_SCHEMA_VERSION}.schema.json`);
}

/**
 * Bring the dynamic schema file in line with the current mode.
 * Never throws: a failed sync must not affect plugin startup — the
 * UI then falls back to the packaged schema (every control visible),
 * which is safe in every mode.
 */
export async function syncDynamicSchema(opts: {
  storagePath: string;
  pluginName: string;
  /** Absolute path of the packaged config.schema.json. */
  packagedSchemaPath: string;
  /** Absolute path of Homebridge's config.json (the verdict source). */
  configPath: string;
  env?: NodeJS.ProcessEnv;
  log: Logger;
}): Promise<void> {
  const target = dynamicSchemaPath(opts.storagePath, opts.pluginName);
  try {
    const configJson = JSON.parse(await fs.readFile(opts.configPath, 'utf8')) as unknown;
    const v2Live = v2LiveVerdict(configJson, opts.env);
    if (!v2Live) {
      if (fsSync.existsSync(target)) {
        await fs.rm(target);
        opts.log.info('[sensor-map v2] dynamic config schema removed; the packaged (full legacy) form governs.');
      }
      return;
    }
    const packaged = JSON.parse(await fs.readFile(opts.packagedSchemaPath, 'utf8')) as PackagedSchema;
    await writeJsonStore(target, buildV2LiveSchema(packaged), opts.log);
    opts.log.info('[sensor-map v2] dynamic config schema written: legacy controls the v2 runtime ignores are hidden.');
  } catch (e) {
    opts.log.warn(`[sensor-map v2] dynamic config schema sync failed (settings form falls back to the packaged schema): ${(e as Error).message}`);
    // Conservative on any failure (unreadable config included): the
    // packaged full form governs rather than a possibly stale
    // reduced one.
    try {
      await fs.rm(target, { force: true });
    } catch {
      // the startup-safety contract holds: never throw from here
    }
  }
}

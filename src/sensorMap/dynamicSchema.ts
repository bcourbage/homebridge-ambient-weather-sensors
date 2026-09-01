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
 * The platform (the file's single writer) syncs it on every launch:
 * in v2-live mode it writes the packaged schema minus the dead
 * controls; in every other mode it deletes the file so the packaged
 * full legacy form governs. A mode change takes effect on the restart
 * that makes it real (structural config changes already require one).
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { writeJsonStore, type Logger } from './persistence/atomicWrite.js';

/** Must match `dynamicSchemaVersion` in the packaged config.schema.json. */
export const DYNAMIC_SCHEMA_VERSION = 1;

/**
 * The legacy controls the v2-live runtime ignores. Deliberately NOT
 * including extendedDisplayMode / embedNameUpdateMinIntervalMinutes
 * (the embed×realtime battery guard reads them in both modes), nor
 * dataSource / stationFilter / credentials / exclude filters.
 */
export const V2_DEAD_LEGACY_CONTROLS: ReadonlyArray<string> = [
  'temperatureSensors', 'humiditySensors', 'solarRadiationSensors',
  'co2Sensors', 'airQualitySensors', 'extendedSensors',
  'windSensors', 'rainSensors', 'pressureSensors', 'uvSensors', 'lightningSensors',
  'thresholds', 'units',
];

interface PackagedSchema {
  schema?: { properties?: Record<string, unknown> };
  [k: string]: unknown;
}

/** The packaged schema minus the controls dead in v2-live mode. */
export function buildV2LiveSchema(packaged: PackagedSchema): PackagedSchema {
  const out = structuredClone(packaged) as PackagedSchema;
  const props = out.schema?.properties;
  if (props) {
    for (const key of V2_DEAD_LEGACY_CONTROLS) {
      delete props[key];
    }
  }
  return out;
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
  v2Live: boolean;
  log: Logger;
}): Promise<void> {
  const target = dynamicSchemaPath(opts.storagePath, opts.pluginName);
  try {
    if (!opts.v2Live) {
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
  }
}

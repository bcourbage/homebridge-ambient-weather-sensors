import { type Logger } from './persistence/atomicWrite.js';
/** Must match `dynamicSchemaVersion` in the packaged config.schema.json. */
export declare const DYNAMIC_SCHEMA_VERSION = 1;
/**
 * The legacy controls the v2-live runtime ignores. Deliberately NOT
 * including extendedDisplayMode / embedNameUpdateMinIntervalMinutes
 * (the embed×realtime battery guard reads them in both modes), nor
 * dataSource / stationFilter / credentials.
 */
export declare const V2_DEAD_LEGACY_CONTROLS: ReadonlyArray<string>;
interface PackagedSchema {
    schema?: {
        properties?: Record<string, unknown>;
    };
    form?: unknown[];
    [k: string]: unknown;
}
/**
 * The packaged schema minus the controls dead in v2-live mode. `form`
 * layout entries whose key roots at a removed property are pruned
 * with it (a layout entry for a property that no longer exists is at
 * best ignored by the form library and at worst an error).
 */
export declare function buildV2LiveSchema(packaged: PackagedSchema): PackagedSchema;
/**
 * Is the settings form governed by the v2-live reduced schema? The
 * verdict is derived from the COMPLETE config, never a single
 * platform instance's block: with multiple AmbientWeatherSensors
 * blocks (multi-Home), instances would otherwise fight over the one
 * plugin-global schema file with startup order deciding the winner —
 * so multi-block (and no-block, and unreadable) configurations
 * conservatively keep the packaged full form.
 */
export declare function v2LiveVerdict(configJson: unknown, env?: NodeJS.ProcessEnv): boolean;
/** The dynamic schema file for this plugin under the storage path. */
export declare function dynamicSchemaPath(storagePath: string, pluginName: string): string;
/**
 * Bring the dynamic schema file in line with the current mode.
 * Never throws: a failed sync must not affect plugin startup — the
 * UI then falls back to the packaged schema (every control visible),
 * which is safe in every mode.
 */
export declare function syncDynamicSchema(opts: {
    storagePath: string;
    pluginName: string;
    /** Absolute path of the packaged config.schema.json. */
    packagedSchemaPath: string;
    /** Absolute path of Homebridge's config.json (the verdict source). */
    configPath: string;
    env?: NodeJS.ProcessEnv;
    log: Logger;
}): Promise<void>;
export {};
//# sourceMappingURL=dynamicSchema.d.ts.map
import { type Logger } from './persistence/atomicWrite.js';
/** Must match `dynamicSchemaVersion` in the packaged config.schema.json. */
export declare const DYNAMIC_SCHEMA_VERSION = 1;
/**
 * The legacy controls the v2-live runtime ignores. Deliberately NOT
 * including extendedDisplayMode / embedNameUpdateMinIntervalMinutes
 * (the embed×realtime battery guard reads them in both modes), nor
 * dataSource / stationFilter / credentials / exclude filters.
 */
export declare const V2_DEAD_LEGACY_CONTROLS: ReadonlyArray<string>;
interface PackagedSchema {
    schema?: {
        properties?: Record<string, unknown>;
    };
    [k: string]: unknown;
}
/** The packaged schema minus the controls dead in v2-live mode. */
export declare function buildV2LiveSchema(packaged: PackagedSchema): PackagedSchema;
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
    v2Live: boolean;
    log: Logger;
}): Promise<void>;
export {};
//# sourceMappingURL=dynamicSchema.d.ts.map
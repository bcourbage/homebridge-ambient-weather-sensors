/**
 * Sensor-map v2.0 shadow-mode wire-in — the safety net for Stage 7.
 *
 * When enabled (via `process.env.SENSOR_MAP_V2=1` or the hidden
 * `_sensorMapV2: true` config field), this runs the new sensor-map
 * pipeline IN PARALLEL to the existing v1.6.0 code path.
 *
 *   - v1.6.0 code still drives every accessory registration decision.
 *   - The sensor-map layer observes each AWN poll and reports what IT
 *     would have decided. Discrepancies log at info level.
 *   - DiscoveryTracker writes discovery.json so the UI (Stage 8) has
 *     real production data to inspect.
 *   - inferForCachedAccessory runs against every cached accessory on
 *     startup, logging its result — no context mutation yet.
 *
 * When the flag is off (default), createShadowMode() returns undefined
 * and platform.ts sees no behavior change at all.
 *
 * The flag flips to on-by-default in Stage 9 once migration-equivalence
 * tests are green. The whole module is deleted in a subsequent stage
 * (call it 7b) once the v1.6.0 code path is retired.
 */
import { type LegacyConfig } from './compat.js';
import { type ConfigInputShape } from './configMode.js';
import { type CachedAccessoryShape } from './bootstrap.js';
import type { StationInventory } from './types.js';
/**
 * Duck-typed subset of Homebridge's Logger — matches what platform.ts
 * already carries as `this.log`.
 */
export interface HomebridgeLogger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/**
 * Duck-typed subset of Homebridge's API — only what we need. Real
 * Homebridge API conforms.
 */
export interface HomebridgeApi {
    user: {
        persistPath(): string;
    };
}
export interface ShadowModeOpts {
    log: HomebridgeLogger;
    config: ConfigInputShape & LegacyConfig;
    api: HomebridgeApi;
}
/**
 * Return true if either the env flag or the hidden config field is
 * set. Config field is a string coercion because HB UI X sometimes
 * yields booleans as JSON strings.
 */
export declare function shadowModeEnabled(opts: {
    env?: NodeJS.ProcessEnv;
    config?: Record<string, unknown>;
}): boolean;
export declare class ShadowMode {
    private readonly log;
    private readonly config;
    private readonly persistDir;
    private readonly discoveryPath;
    private tracker;
    private readonly loggedCacheInference;
    private readonly loggedDivergences;
    private modeLogged;
    constructor(opts: ShadowModeOpts);
    /**
     * Called once from platform.ts's didFinishLaunching handler. Loads
     * the discovery store, cleans stale temp files, logs the detected
     * config mode.
     */
    initialize(): Promise<void>;
    /**
     * Called from platform.configureAccessory. Runs inference against
     * the cached accessory and logs the outcome. Never writes to context;
     * the v1.6.0 code path continues to own registration.
     */
    onConfigureAccessory(accessory: CachedAccessoryShape): void;
    /**
     * Called from platform.parseDevices AFTER Devices[] is built. Feeds
     * the discovery tracker + runs the sensor-map path in parallel and
     * logs any divergence vs. the v1.6.0 code's decisions.
     *
     * The comparison is conservative: it flags a divergence only when
     * both paths return DIFFERENT non-empty answers. If one path
     * declined to register a field the other one did, we log an
     * "extra"/"missing" line so we can hunt why.
     */
    onParseTick(input: {
        stations: StationInventory;
        /** All AWN-observed (stationMac, dataPoint) pairs this tick. */
        observed: Array<{
            stationMac: string;
            stationName: string;
            dataPoint: string;
        }>;
        /**
         * What the v1.6.0 code decided to register for this tick — the
         * subset of `observed` that survived determineSensorType +
         * include/exclude/stationFilter.
         */
        v1Decisions: Array<{
            stationMac: string;
            dataPoint: string;
            type: string;
        }>;
    }): void;
    private logDivergenceOnce;
    /**
     * Called from platform.ts's shutdown handler. Force-flushes the
     * discovery tracker so unwritten lastSeen updates aren't lost.
     */
    shutdown(): Promise<void>;
}
/**
 * Factory. Returns undefined when the flag is off — platform.ts uses
 * `?.` optional-call everywhere.
 */
export declare function createShadowMode(opts: ShadowModeOpts): ShadowMode | undefined;
//# sourceMappingURL=shadowMode.d.ts.map
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
 *
 * `storagePath()` returns Homebridge's storage root (e.g.
 * `~/.homebridge/`). We deliberately do NOT use `persistPath()`
 * (which returns `<storagePath>/persist/`) because HAP-NodeJS scans
 * that directory via node-persist's readFileSync-per-entry loop —
 * dropping a subdirectory inside it crashes HAP with EISDIR on the
 * next child-bridge start. Learned the hard way in v2.0.0-beta.1.
 */
export interface HomebridgeApi {
    user: {
        storagePath(): string;
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
    /**
     * Where v2.0.0-beta.0/beta.1 (accidentally) wrote plugin data.
     * Inside HAP's persist scan — see EISDIR crash notes on HomebridgeApi
     * above. Populated only if we can derive it; used by
     * warnOnStaleBetaDir() to nudge users to clean up.
     */
    private readonly legacyPersistCandidate;
    private readonly discoveryPath;
    private tracker;
    private readonly loggedCacheInference;
    private readonly loggedDivergences;
    private modeLogged;
    /**
     * Detected config mode. Populated in `initialize()` and then used
     * by every `onParseTick` to select the right override source
     * (compat vs. real v2 sensorMap) and to short-circuit in safe mode.
     * Defaults to 'legacy' before initialize runs so a stray tick
     * before the first didFinishLaunching callback still gets a
     * deterministic answer.
     */
    private configMode;
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
    /**
     * Detect the beta.1 EISDIR-crash directory. If we find it, log a
     * loud warning telling the user to remove it manually. We don't
     * auto-delete because:
     *   - The path is under HAP's persist tree; automated deletes there
     *     scare people (rightly).
     *   - The data is auto-regenerating (just observed field records).
     *   - A one-line rm command is easier to review than opaque code.
     */
    private warnOnStaleBetaDir;
}
/**
 * Factory. Returns undefined when the flag is off — platform.ts uses
 * `?.` optional-call everywhere.
 */
export declare function createShadowMode(opts: ShadowModeOpts): ShadowMode | undefined;
//# sourceMappingURL=shadowMode.d.ts.map
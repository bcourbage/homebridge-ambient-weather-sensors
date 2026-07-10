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
import * as path from 'path';
import { buildEffectiveSensorMap } from './buildEffectiveMap.js';
import { compatToOverrides } from './compat.js';
import { detectConfigMode } from './configMode.js';
import { inferForCachedAccessory } from './bootstrap.js';
import { cleanupStaleTempFiles, } from './persistence/atomicWrite.js';
import { DiscoveryTracker, DISCOVERY_FILE, loadDiscoveryStore, } from './persistence/discoveryStore.js';
/**
 * Return true if either the env flag or the hidden config field is
 * set. Config field is a string coercion because HB UI X sometimes
 * yields booleans as JSON strings.
 */
export function shadowModeEnabled(opts) {
    const env = opts.env ?? process.env;
    if (env.SENSOR_MAP_V2 === '1' || env.SENSOR_MAP_V2 === 'true') {
        return true;
    }
    const cfgVal = opts.config?._sensorMapV2;
    if (cfgVal === true || cfgVal === 'true' || cfgVal === 1) {
        return true;
    }
    return false;
}
/**
 * Adapt HomebridgeLogger to the persistence-store logger surface
 * (which is a stricter subset without the `error` method).
 */
function persistLogger(log) {
    return {
        info: (m) => log.info(m),
        warn: (m) => log.warn(m),
        debug: (m) => log.debug(m),
    };
}
export class ShadowMode {
    constructor(opts) {
        // Dedup log throttling — one line per unique event per boot.
        this.loggedCacheInference = new Set();
        this.loggedDivergences = new Set();
        // Snapshot of config-mode detection at startup. Logged once.
        this.modeLogged = false;
        this.log = opts.log;
        this.config = opts.config;
        this.persistDir = path.join(opts.api.user.persistPath(), 'plugin-data', 'ambient-weather');
        this.discoveryPath = path.join(this.persistDir, DISCOVERY_FILE);
    }
    /**
     * Called once from platform.ts's didFinishLaunching handler. Loads
     * the discovery store, cleans stale temp files, logs the detected
     * config mode.
     */
    async initialize() {
        const persistLog = persistLogger(this.log);
        await cleanupStaleTempFiles(this.persistDir, persistLog);
        const initial = await loadDiscoveryStore(this.discoveryPath, persistLog);
        this.tracker = new DiscoveryTracker({
            filePath: this.discoveryPath,
            log: persistLog,
            initial,
        });
        if (!this.modeLogged) {
            const result = detectConfigMode(this.config);
            this.log.info(`[sensor-map v2 shadow] config mode: ${result.mode}`);
            for (const w of result.warnings) {
                this.log.warn(`[sensor-map v2 shadow] ${w}`);
            }
            if (result.safeModeBanner) {
                this.log.warn(`[sensor-map v2 shadow] SAFE MODE: ${result.safeModeBanner}`);
            }
            this.modeLogged = true;
        }
    }
    /**
     * Called from platform.configureAccessory. Runs inference against
     * the cached accessory and logs the outcome. Never writes to context;
     * the v1.6.0 code path continues to own registration.
     */
    onConfigureAccessory(accessory) {
        const dp = accessory.context?.device?.uniqueId ?? '<no-uniqueId>';
        if (this.loggedCacheInference.has(dp)) {
            return;
        }
        this.loggedCacheInference.add(dp);
        const result = inferForCachedAccessory(accessory);
        if (result.status === 'inferred') {
            this.log.debug(`[sensor-map v2 shadow] cache-restore ${dp}: kind=${result.kind} measurement=${result.measurement}`);
        }
        else {
            this.log.debug(`[sensor-map v2 shadow] cache-restore ${dp}: preserve-cached (kind/measurement not inferable yet)`);
        }
    }
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
    onParseTick(input) {
        // Feed the tracker regardless of shadow comparison — this lets
        // discovery.json accumulate real data while the flag is on.
        if (this.tracker) {
            for (const o of input.observed) {
                this.tracker.observe(o.stationMac, o.stationName, o.dataPoint);
            }
            // Fire-and-forget; the tracker handles its own throttling.
            this.tracker.flush().catch(() => { });
        }
        // Build the sensor-map view.
        const overrides = compatToOverrides(this.config);
        const result = buildEffectiveSensorMap({
            userOverrides: overrides,
            discovery: { schemaVersion: 1, entries: input.observed.map(o => ({
                    stationMac: o.stationMac,
                    stationName: o.stationName,
                    dataPoint: o.dataPoint,
                    firstSeen: 'shadow-mode',
                    lastSeen: 'shadow-mode',
                })) },
            uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
            stations: input.stations,
            configMode: 'legacy',
        });
        // Scope the comparison to (station, dataPoint) pairs AWN ACTUALLY
        // reported this tick. The effective-map layer emits a row for
        // every default × station pair whether AWN reported it or not
        // (it's a template map). Rows for un-reported pairs would be
        // false-positive divergences.
        const observedSet = new Set(input.observed.map(o => `${o.stationMac.toUpperCase()}|${o.dataPoint}`));
        const v2ByKey = new Map();
        for (const row of result.rows) {
            const key = `${row.stationMac.toUpperCase()}|${row.dataPoint}`;
            if (observedSet.has(key)) {
                v2ByKey.set(key, row);
            }
        }
        const v1Set = new Set(input.v1Decisions.map(d => `${d.stationMac.toUpperCase()}|${d.dataPoint}`));
        // v1-registered but v2 would drop.
        for (const d of input.v1Decisions) {
            const key = `${d.stationMac.toUpperCase()}|${d.dataPoint}`;
            const v2 = v2ByKey.get(key);
            const v2Enabled = v2 && v2.kind !== 'unrecognized' && v2.enabled;
            if (!v2Enabled) {
                this.logDivergenceOnce(key, `v1.6.0 registered ${d.dataPoint} on ${d.stationMac} as ${d.type}; v2 would DROP.`);
            }
        }
        // v2 would register but v1 dropped.
        for (const [key, row] of v2ByKey) {
            if (row.kind === 'unrecognized' || !row.enabled) {
                continue;
            }
            if (!v1Set.has(key)) {
                this.logDivergenceOnce(key, `v2 would register ${row.dataPoint} on ${row.stationMac} (${row.kind}); v1.6.0 dropped.`);
            }
        }
        if (result.errors.length > 0) {
            for (const err of result.errors) {
                const key = `err|${err.overrideIndex}|${err.dataPoint ?? ''}`;
                this.logDivergenceOnce(key, `v2 override validation: ${err.message}`);
            }
        }
    }
    logDivergenceOnce(key, message) {
        if (this.loggedDivergences.has(key)) {
            return;
        }
        this.loggedDivergences.add(key);
        this.log.info(`[sensor-map v2 shadow] ${message}`);
    }
    /**
     * Called from platform.ts's shutdown handler. Force-flushes the
     * discovery tracker so unwritten lastSeen updates aren't lost.
     */
    async shutdown() {
        if (this.tracker) {
            await this.tracker.flush(true);
        }
    }
}
/**
 * Factory. Returns undefined when the flag is off — platform.ts uses
 * `?.` optional-call everywhere.
 */
export function createShadowMode(opts) {
    if (!shadowModeEnabled({ config: opts.config })) {
        return undefined;
    }
    opts.log.info('[sensor-map v2 shadow] enabled (env or _sensorMapV2 flag). Running in parallel to v1.6.0 code path.');
    return new ShadowMode(opts);
}
//# sourceMappingURL=shadowMode.js.map
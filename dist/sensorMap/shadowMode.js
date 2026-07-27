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
        // Preserve-cached recovery bookkeeping (review finding #11 / §17.3).
        // Cached accessories whose kind+measurement couldn't be inferred at
        // bootstrap time stay in HomeKit with last-known values, and every
        // subsequent parse tick re-attempts inference against them. Once
        // one resolves — because AWN started reporting its dataPoint, or a
        // future default-map update covered it — it drops out of this map.
        //
        // The plugin-side "populate context via updatePlatformAccessories"
        // (§17.3, final paragraph) is a Path-A concern — shadow mode is
        // Path B and does not mutate context. We surface the recovery at
        // info level so users see the accessory has re-entered the normal
        // reconciliation lifecycle, and the actual writeback lands with
        // task #65's flag flip.
        this.preservedAccessories = new Map();
        // Snapshot of config-mode detection at startup. Logged once.
        this.modeLogged = false;
        /**
         * Detected config mode. Populated in `initialize()` and then used
         * by every `onParseTick` to select the right override source
         * (compat vs. real v2 sensorMap) and to short-circuit in safe mode.
         * Defaults to 'legacy' before initialize runs so a stray tick
         * before the first didFinishLaunching callback still gets a
         * deterministic answer.
         */
        this.configMode = 'legacy';
        this.log = opts.log;
        this.config = opts.config;
        const storageRoot = opts.api.user.storagePath();
        this.persistDir = path.join(storageRoot, 'plugin-data', 'ambient-weather');
        this.discoveryPath = path.join(this.persistDir, DISCOVERY_FILE);
        this.legacyPersistCandidate = path.join(storageRoot, 'persist', 'plugin-data', 'ambient-weather');
    }
    /**
     * Called once from platform.ts's didFinishLaunching handler. Loads
     * the discovery store, cleans stale temp files, logs the detected
     * config mode.
     */
    async initialize() {
        const persistLog = persistLogger(this.log);
        // Detect config mode FIRST, before touching any plugin
        // persistence. Safe mode is contractually read-only per §5 — it
        // must NOT create the persist directory, scan / quarantine /
        // clean anything under it, or open the discovery tracker. Doing
        // so would let a downgraded plugin still mutate discovery.json
        // (review finding: safe mode still writes discovery state).
        if (!this.modeLogged) {
            const result = detectConfigMode(this.config);
            this.configMode = result.mode;
            this.log.info(`[sensor-map v2 shadow] config mode: ${result.mode}`);
            for (const w of result.warnings) {
                this.log.warn(`[sensor-map v2 shadow] ${w}`);
            }
            if (result.safeModeBanner) {
                this.log.warn(`[sensor-map v2 shadow] SAFE MODE: ${result.safeModeBanner}`);
            }
            this.modeLogged = true;
        }
        if (this.configMode === 'safe-mode') {
            // Tracker stays undefined; onParseTick sees this and no-ops.
            return;
        }
        // v2.0.0-beta.1 wrote plugin data under <storagePath>/persist/plugin-data/
        // which crashed HAP-NodeJS's node-persist scan with EISDIR. Detect
        // and warn if that leftover directory is still present — the user
        // must remove it manually because we deliberately don't touch
        // HAP's storage root.
        await this.warnOnStaleBetaDir(persistLog);
        await cleanupStaleTempFiles(this.persistDir, persistLog);
        const initial = await loadDiscoveryStore(this.discoveryPath, persistLog);
        this.tracker = new DiscoveryTracker({
            filePath: this.discoveryPath,
            log: persistLog,
            initial,
        });
    }
    /**
     * Called from platform.configureAccessory. Runs inference against
     * the cached accessory and logs the outcome. Never writes to context;
     * the v1.6.0 code path continues to own registration.
     */
    onConfigureAccessory(accessory) {
        const dp = accessory.context?.device?.uniqueId ?? '<no-uniqueId>';
        const result = inferForCachedAccessory(accessory);
        if (result.status === 'inferred') {
            if (!this.loggedCacheInference.has(dp)) {
                this.loggedCacheInference.add(dp);
                this.log.debug(`[sensor-map v2 shadow] cache-restore ${dp}: kind=${result.kind} measurement=${result.measurement}`);
            }
            return;
        }
        // preserve-cached: log once at bootstrap and register the
        // accessory for retry. Every subsequent onParseTick will re-run
        // inference against it (see recoverPreservedAccessories below).
        if (!this.loggedCacheInference.has(dp)) {
            this.loggedCacheInference.add(dp);
            this.log.debug(`[sensor-map v2 shadow] cache-restore ${dp}: preserve-cached (kind/measurement not inferable yet)`);
        }
        this.preservedAccessories.set(dp, accessory);
    }
    /**
     * Re-attempt bootstrap for every accessory in the preserve-cached
     * state. Called from `onParseTick` on every discovery cycle per
     * `docs/future/sensor-map.md` §17.3. Once inference resolves for a
     * given accessory, it's removed from the retry map and an info-
     * level "recovered" line surfaces so the user sees the accessory
     * has re-entered the normal reconciliation lifecycle.
     *
     * The plugin-side context writeback + `updatePlatformAccessories`
     * (final paragraph of §17.3) is a Path-A concern that lands with
     * task #65's flag flip. Shadow mode does not mutate context.
     */
    recoverPreservedAccessories() {
        if (this.preservedAccessories.size === 0) {
            return;
        }
        for (const [uid, accessory] of this.preservedAccessories) {
            const result = inferForCachedAccessory(accessory);
            if (result.status === 'inferred') {
                this.log.info(`[sensor-map v2 shadow] cache-restore ${uid}: recovered — kind=${result.kind} `
                    + `measurement=${result.measurement}. Context writeback pending task #65's flag flip.`);
                this.preservedAccessories.delete(uid);
            }
            // Otherwise stay in preserve-cached; try again next tick.
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
        // Safe mode is contractually read-only per §5. Short-circuit
        // BEFORE touching persistence so a downgraded plugin can't
        // create, update, or scan discovery.json. This runs first
        // because the tracker feed below writes to disk.
        if (this.configMode === 'safe-mode') {
            return;
        }
        // §17.3 recovery: re-attempt bootstrap for every cached
        // accessory that returned preserve-cached at startup. Any that
        // resolves now drops out of the retry map.
        this.recoverPreservedAccessories();
        // Feed the tracker regardless of shadow comparison — this lets
        // discovery.json accumulate real data while the flag is on.
        if (this.tracker) {
            for (const o of input.observed) {
                this.tracker.observe(o.stationMac, o.stationName, o.dataPoint);
            }
            // Fire-and-forget; the tracker handles its own throttling.
            this.tracker.flush().catch(() => { });
        }
        // Build the sensor-map view. Path B: the observer must exercise
        // whichever configuration path the plugin is actually running
        // (compat for legacy, hand-authored `sensorMap` for v2), so the
        // observed divergence lines match what would happen once the
        // flag flips on-by-default.
        let userOverrides;
        if (this.configMode === 'v2') {
            // v2: read `sensorMap` as raw unknown[]. Only real arrays are
            // accepted — a non-array value (string, object, number, null)
            // is a hand-edit mistake we surface loudly rather than
            // silently coercing to `[]` (which would validate the
            // default-exposure layout, not the config the user wrote).
            const raw = this.config.sensorMap;
            if (raw !== undefined && !Array.isArray(raw)) {
                this.logDivergenceOnce('sensormap-not-array', `v2 sensorMap must be an array; got ${describeType(raw)}. `
                    + 'The observer is treating it as empty; the plugin will do the same once the flag flips. '
                    + 'Fix or remove the sensorMap field.');
                userOverrides = [];
            }
            else {
                userOverrides = Array.isArray(raw) ? raw : [];
            }
        }
        else {
            // legacy: synthesize from v1.6.0 fields via the compat layer.
            // Pass the station inventory so exclude/include matchers get
            // their full seven-candidate v1 semantics (finding #2).
            userOverrides = compatToOverrides(this.config, input.stations);
        }
        const result = buildEffectiveSensorMap({
            userOverrides,
            discovery: { schemaVersion: 1, entries: input.observed.map(o => ({
                    stationMac: o.stationMac,
                    stationName: o.stationName,
                    dataPoint: o.dataPoint,
                    firstSeen: 'shadow-mode',
                    lastSeen: 'shadow-mode',
                })) },
            uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
            stations: input.stations,
            configMode: this.configMode,
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
                const key = `err|${err.code ?? 'unknown'}|${err.field ?? ''}|${err.dataPoint ?? ''}|${err.stationMac ?? ''}`;
                this.logDivergenceOnce(key, `v2 override validation error: ${err.message}`);
            }
        }
        // Warnings — ignored-with-warn cases from §3.7 (e.g. threshold on
        // a non-motion row). The row still loads but the field is dropped;
        // users should see these to know their config isn't doing what
        // they wrote. Dedup key includes code+field so different warnings
        // on the same override don't collapse.
        if (result.warnings.length > 0) {
            for (const w of result.warnings) {
                const key = `warn|${w.code}|${w.field ?? ''}|${w.dataPoint ?? ''}|${w.stationMac ?? ''}`;
                this.logDivergenceOnce(key, `v2 override validation warning: ${w.message}`);
            }
        }
        // Internal-invariant notes — attribution-free diagnostics with no
        // user config to blame (a default-map wrapper drift, an unreachable
        // both-sides-default battery collision). Surfaced so a plugin bug
        // doesn't hide behind an empty errors/warnings list.
        if (result.notes.length > 0) {
            for (const n of result.notes) {
                const key = `note|${n.code}|${n.source}|${n.dataPoint ?? ''}|${n.stationMac ?? ''}`;
                this.logDivergenceOnce(key, `v2 internal-invariant note (${n.source}): ${n.message}`);
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
    /**
     * Detect the beta.1 EISDIR-crash directory. If we find it, log a
     * loud warning telling the user to remove it manually. We don't
     * auto-delete because:
     *   - The path is under HAP's persist tree; automated deletes there
     *     scare people (rightly).
     *   - The data is auto-regenerating (just observed field records).
     *   - A one-line rm command is easier to review than opaque code.
     */
    async warnOnStaleBetaDir(log) {
        if (!this.legacyPersistCandidate) {
            return;
        }
        try {
            const { promises: fs } = await import('fs');
            await fs.access(this.legacyPersistCandidate);
            log.warn(`Found orphan directory from v2.0.0-beta.0/beta.1 at `
                + `${this.legacyPersistCandidate}. This path is inside HAP-NodeJS's `
                + `persist scan and will crash HAP with EISDIR. Delete it manually: `
                + `rm -rf "${this.legacyPersistCandidate}"`);
        }
        catch {
            // Doesn't exist. Fresh install or already cleaned up. All good.
        }
    }
}
function describeType(v) {
    if (v === null) {
        return 'null';
    }
    if (Array.isArray(v)) {
        return 'array';
    }
    return typeof v;
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
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
import { compatToOverrides, type LegacyConfig } from './compat.js';
import { detectConfigMode, type ConfigInputShape, type ConfigMode } from './configMode.js';
import { inferForCachedAccessory, type CachedAccessoryShape } from './bootstrap.js';
import {
  cleanupStaleTempFiles,
  type Logger as PersistLogger,
} from './persistence/atomicWrite.js';
import {
  DiscoveryTracker,
  DISCOVERY_FILE,
  loadDiscoveryStore,
} from './persistence/discoveryStore.js';
import type {
  EffectiveSensorRow,
  StationInventory,
} from './types.js';

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
  user: { storagePath(): string };
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
export function shadowModeEnabled(opts: { env?: NodeJS.ProcessEnv; config?: Record<string, unknown> }): boolean {
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
function persistLogger(log: HomebridgeLogger): PersistLogger {
  return {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    debug: (m) => log.debug(m),
  };
}

export class ShadowMode {
  private readonly log: HomebridgeLogger;
  private readonly config: ConfigInputShape & LegacyConfig;
  private readonly persistDir: string;
  /**
   * Where v2.0.0-beta.0/beta.1 (accidentally) wrote plugin data.
   * Inside HAP's persist scan — see EISDIR crash notes on HomebridgeApi
   * above. Populated only if we can derive it; used by
   * warnOnStaleBetaDir() to nudge users to clean up.
   */
  private readonly legacyPersistCandidate: string | undefined;
  private readonly discoveryPath: string;
  private tracker: DiscoveryTracker | undefined;

  // Dedup log throttling — one line per unique event per boot.
  private readonly loggedCacheInference = new Set<string>();
  private readonly loggedDivergences = new Set<string>();

  // Snapshot of config-mode detection at startup. Logged once.
  private modeLogged = false;

  /**
   * Detected config mode. Populated in `initialize()` and then used
   * by every `onParseTick` to select the right override source
   * (compat vs. real v2 sensorMap) and to short-circuit in safe mode.
   * Defaults to 'legacy' before initialize runs so a stray tick
   * before the first didFinishLaunching callback still gets a
   * deterministic answer.
   */
  private configMode: ConfigMode = 'legacy';

  constructor(opts: ShadowModeOpts) {
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
  async initialize(): Promise<void> {
    const persistLog = persistLogger(this.log);
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
  }

  /**
   * Called from platform.configureAccessory. Runs inference against
   * the cached accessory and logs the outcome. Never writes to context;
   * the v1.6.0 code path continues to own registration.
   */
  onConfigureAccessory(accessory: CachedAccessoryShape): void {
    const dp = accessory.context?.device?.uniqueId ?? '<no-uniqueId>';
    if (this.loggedCacheInference.has(dp)) {
      return;
    }
    this.loggedCacheInference.add(dp);
    const result = inferForCachedAccessory(accessory);
    if (result.status === 'inferred') {
      this.log.debug(
        `[sensor-map v2 shadow] cache-restore ${dp}: kind=${result.kind} measurement=${result.measurement}`,
      );
    } else {
      this.log.debug(
        `[sensor-map v2 shadow] cache-restore ${dp}: preserve-cached (kind/measurement not inferable yet)`,
      );
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
  onParseTick(input: {
    stations: StationInventory;
    /** All AWN-observed (stationMac, dataPoint) pairs this tick. */
    observed: Array<{ stationMac: string; stationName: string; dataPoint: string }>;
    /**
     * What the v1.6.0 code decided to register for this tick — the
     * subset of `observed` that survived determineSensorType +
     * include/exclude/stationFilter.
     */
    v1Decisions: Array<{ stationMac: string; dataPoint: string; type: string }>;
  }): void {
    // Feed the tracker regardless of shadow comparison — this lets
    // discovery.json accumulate real data while the flag is on.
    if (this.tracker) {
      for (const o of input.observed) {
        this.tracker.observe(o.stationMac, o.stationName, o.dataPoint);
      }
      // Fire-and-forget; the tracker handles its own throttling.
      this.tracker.flush().catch(() => { /* logged internally */ });
    }

    // Build the sensor-map view. Path B: the observer must exercise
    // whichever configuration path the plugin is actually running
    // (compat for legacy, hand-authored `sensorMap` for v2), so the
    // observed divergence lines match what would happen once the
    // flag flips on-by-default. Safe mode short-circuits entirely
    // per §5 — the map is empty and no divergences make sense.
    let userOverrides: ReadonlyArray<unknown>;
    if (this.configMode === 'safe-mode') {
      // Safe mode: skip the parallel pipeline. There's no meaningful
      // divergence to report and building an effective map would
      // just surface synthetic errors from the malformed config.
      return;
    } else if (this.configMode === 'v2') {
      // v2: read `sensorMap` as raw unknown[] and hand it to the
      // effective-map layer — which will Phase-1/Phase-2 validate
      // every entry (Group 1 finding #10). If the field is absent
      // or the wrong type, the layer emits identity errors that
      // shadow-mode surfaces below.
      const raw = (this.config as { sensorMap?: unknown }).sensorMap;
      userOverrides = Array.isArray(raw) ? (raw as unknown[]) : [];
    } else {
      // legacy: synthesize from v1.6.0 fields via the compat layer.
      // Pass the station inventory so exclude/include matchers get
      // their full seven-candidate v1 semantics (finding #2).
      userOverrides = compatToOverrides(this.config as LegacyConfig, input.stations);
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
    const observedSet = new Set(
      input.observed.map(o => `${o.stationMac.toUpperCase()}|${o.dataPoint}`),
    );

    const v2ByKey = new Map<string, EffectiveSensorRow>();
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
  }

  private logDivergenceOnce(key: string, message: string): void {
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
  async shutdown(): Promise<void> {
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
  private async warnOnStaleBetaDir(log: PersistLogger): Promise<void> {
    if (!this.legacyPersistCandidate) {
      return;
    }
    try {
      const { promises: fs } = await import('fs');
      await fs.access(this.legacyPersistCandidate);
      log.warn(
        `Found orphan directory from v2.0.0-beta.0/beta.1 at `
        + `${this.legacyPersistCandidate}. This path is inside HAP-NodeJS's `
        + `persist scan and will crash HAP with EISDIR. Delete it manually: `
        + `rm -rf "${this.legacyPersistCandidate}"`,
      );
    } catch {
      // Doesn't exist. Fresh install or already cleaned up. All good.
    }
  }
}

/**
 * Factory. Returns undefined when the flag is off — platform.ts uses
 * `?.` optional-call everywhere.
 */
export function createShadowMode(opts: ShadowModeOpts): ShadowMode | undefined {
  if (!shadowModeEnabled({ config: opts.config as unknown as Record<string, unknown> })) {
    return undefined;
  }
  opts.log.info('[sensor-map v2 shadow] enabled (env or _sensorMapV2 flag). Running in parallel to v1.6.0 code path.');
  return new ShadowMode(opts);
}

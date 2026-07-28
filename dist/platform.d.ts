import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { hapClean as sharedHapClean } from './sensorMap/displayName.js';
import { DEVICE } from './types.js';
/**
 * Re-export of the HAP Name sanitizer. Kept exported here for tests
 * that were written against `platform.hapClean` before the helper
 * moved to `sensorMap/displayName.ts`. The compat layer uses the
 * shared module directly.
 */
export declare const hapClean: typeof sharedHapClean;
/**
 * Normalize a string the user might have typed in their config for
 * matching against sensor identifiers. Trims whitespace and lowercases.
 * Empty / non-string values normalize to the empty string, which the
 * caller is expected to filter out.
 *
 * Exported for test coverage.
 */
export declare function normalizeMatchKey(s: unknown): string;
/**
 * Build a Set of normalized matchers from a config-supplied array. Used
 * for both `excludeSensors` and `includeOnly`; the same matching rules
 * apply to both (case-insensitive, whitespace-trimmed, non-string and
 * blank entries dropped).
 *
 * Exported for test coverage.
 */
export declare function toMatcherSet(raw: unknown): Set<string>;
/**
 * Common shape for the per-accessory wrapper instances the platform
 * tracks. Each wrapper exposes a single push-style `setValue` entry
 * point that the platform's poll tick uses to deliver the freshly
 * fetched value, performing whatever unit conversion is appropriate for
 * the underlying HomeKit characteristic.
 */
export interface SensorAccessory {
    setValue(rawValue: number): void;
    /**
     * Optional hook for per-probe battery state. Implementations that
     * advertise a Battery sub-service should override this to flip
     * `StatusLowBattery` based on the boolean. Called by the polling
     * and realtime fanout in addition to `setValue` on each tick.
     *
     * Default no-op for accessories that don't expose a battery — the
     * platform calls this blindly and lets the wrapper decide whether
     * to act.
     */
    setBatteryLow?(batteryLow: boolean): void;
}
export declare class AmbientWeatherSensorsPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    private readonly wrappers;
    private readonly loggedExcludeHits;
    private readonly loggedIncludeMisses;
    private readonly loggedStationFilterDrops;
    private warnedStationFilterEmpty;
    private loggedStationFilterSummary;
    private readonly loggedBatterySuppressions;
    private readonly loggedDiscoveredStations;
    private pollTimer;
    private realtimeSource;
    private readonly safeModeBindings;
    private readonly shadow;
    private readonly sensorMapV2;
    private v2Routing;
    private configMode;
    constructor(log: Logger, config: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    determineSensorType(sensor: string): "PM2.5" | "PM10" | "Solar Radiation" | "CO2" | "Temperature" | "Humidity" | "UV" | "WindSpeed" | "WindGust" | "WindMaxDailyGust" | "WindDirection" | "WindDirection10m" | "PressureRelative" | "PressureAbsolute" | "RainRate" | "RainEvent" | "RainDaily" | "RainWeekly" | "RainMonthly" | "RainYearly" | "LastRain" | "LightningDay" | "LightningHour" | "LightningDistance" | "LightningLastStrike" | "NOT_SUPPORTED";
    /**
     * Compose a HAP-clean accessory displayName from station + sensor
     * metadata.
     *
     * Single-station setups (the vast majority) get just the sensor
     * label — e.g. "Indoor Temperature" — so the Apple Home tile reads
     * cleanly without a station prefix. Multi-station setups get the
     * prefix to disambiguate — e.g. "Backyard Station Indoor
     * Temperature" — falling back to `${mac_no_colons} ${sensor_label}`
     * if the user hasn't set a station name on ambientweather.net.
     *
     * Why the split: Apple Home's tile only honors a custom Name field
     * after the user explicitly renames via the Home app (the rename
     * action flips an internal "user-confirmed" flag; programmatic
     * `setCharacteristic` from the accessory side doesn't). Until then,
     * the tile shows `accessory.displayName` verbatim. So for the
     * single-station case where the station prefix is redundant, we
     * have to drop it at the displayName level — not at the service
     * Name level — to get clean tiles by default.
     *
     * City/state are intentionally NOT included even though the API
     * supplies them: HomeKit's room/home hierarchy already gives users a
     * place to express location, and dragging the geocoded address into
     * every accessory name produces redundant noise on the device tile.
     *
     * Truncates from the right to HAP 2.x's 64-character `Name` limit.
     */
    composeDisplayName(obj: {
        macAddress: string;
        info?: {
            name?: string;
        };
    }, sensorKey: string, isMultiStation: boolean): string;
    /**
     * Parse `excludeSensors` entries that target battery sub-services
     * specifically, rather than entire accessories. Three forms are
     * accepted, all resolving to a set of AWN battery field names to
     * suppress:
     *
     *   - "<friendly name>-batt"  e.g. "Lightning Strikes Today-batt"
     *   - "<sensorKey>-batt"      e.g. "lightning_distance-batt"
     *   - "<battery field>"       e.g. "batt_lightning"
     *
     * Any sensor name (friendly or raw) sharing a probe with the target
     * battery resolves to the same field, so users don't need to know
     * which accessory is the canonical Battery-sub-service host. The
     * field-name form is direct and lets users skip the reverse lookup
     * entirely.
     *
     * The primary use case is working around upstream AWN API bugs that
     * report a battery as low even with known-good cells (e.g.
     * `batt_lightning` for the WH31L lightning sensor — see README).
     *
     * Note: entries that target whole accessories (no `-batt` suffix,
     * not a battery field name) continue to flow through the existing
     * per-accessory exclude path; they're not consumed here. So users
     * can mix battery-suppression entries with accessory-exclusion
     * entries in the same list freely.
     */
    private buildSuppressedBatteries;
    parseDevices(json: any): DEVICE[];
    sleep: (delay: any) => Promise<unknown>;
    fetchDevices(): any;
    /**
     * Unregister any cached accessories whose underlying sensor is no
     * longer present in the API response (or has been excluded via
     * `excludeSensors` / a per-type toggle being turned off). Matching is
     * by `context.device.uniqueId` — the stable `${mac}-${sensorKey}`
     * identifier — rather than by `displayName`. Matching by displayName
     * caused a regression where any change to the naming convention (e.g.
     * the colon-strip in HB2 compat, or the station-name rollout in this
     * branch) made every cached accessory look like an orphan and got
     * them all unregistered from HAP on the first restart after the
     * rename. uniqueId is stable across renames and is what the for-loop
     * downstream uses for UUID generation, so they're the same identity
     * notion.
     */
    deregisterAccessories(Devices: DEVICE[]): void;
    discoverDevices(): any;
    /**
     * Choose how to keep the registered wrappers updated. Two data-source
     * options:
     *
     *   "polling"  (default) — one platform-level setInterval, REST
     *                          fetch every 2 minutes.
     *   "realtime"           — opt-in; subscribe to AWN's socket.io
     *                          endpoint and push updates as they arrive
     *                          (~30s cadence indoors).
     *
     * CONSTRAINT (added in 1.6.0): embed display mode is incompatible with
     * the realtime data source. The combination produces a flood of HAP
     * Name-characteristic update notifications to every paired iOS
     * controller, which has been observed to drain phone battery ~5×-7×
     * faster than normal idle (solmssen, 2026-06-18, ~15 extended sensors
     * active). Polling caps the notification volume to roughly one batch
     * per 2 minutes, which keeps the drain negligible while still
     * delivering live-ish tile values. If the user has selected both, we
     * coerce to polling and warn — the user's intent ("live value in
     * tile") is preserved at a slightly slower cadence, which is the right
     * trade-off for an invisible side effect like battery drain.
     *
     * Shared by the v1.6.0 path and the v2 reconciler; the poll/realtime
     * fanout branches on `this.v2Routing` presence downstream.
     */
    private startDataSource;
    /**
     * Flag-gated v2 reconciler (finding-#4 Stage 4, first commit). Runs in
     * place of the v1.6.0 discoverDevices path when `sensorMapV2` is on
     * (default OFF, so shipping behaviour is unchanged).
     *
     * Pipeline:
     *   1. Fetch the raw AWN station payloads.
     *   2. Load the discovery + ui-state stores from
     *      `storagePath()/plugin-data/ambient-weather/` (NEVER
     *      `persistPath()` — HAP-scan / EISDIR hazard).
     *   3. Assemble the effective sensor map (pure) — compat overrides for
     *      legacy configs, `config.sensorMap` for v2.
     *   4. For every enabled, KNOWN, AWN-reported row: build a
     *      v1.7-compatible `context.device` (so a downgrade finds a
     *      recognisable cache), restore-or-create its accessory reusing the
     *      v1.7 UUID, instantiate the row-driven wrapper, and register it.
     *   5. Build the `(mac, dataPoint) → wrapper` routing map and seed each
     *      wrapper's current value.
     *   6. Start the poll / realtime data source; both fan out through
     *      `distributeViaRouting` (see distributeViaV2Routing).
     *
     * Custom (non-default) dataPoints never register: the resolution table
     * is empty, so they resolve `no-wrapper` and produce no row — the
     * ordering gate the reviewer requires before restoring the table.
     *
     * Safe mode never reaches here — `didFinishLaunching` routes to
     * `safeModeStart()` first, before any persistence read that could
     * quarantine or write a file.
     */
    private discoverDevicesV2;
    /**
     * v2 twin of parseDevices' station-level filtering. Announces each
     * discovered station once per restart (users learn the exact
     * `stationFilter` strings from these lines), then applies the filter
     * with v1's matching rules (info.name OR MAC, case-insensitive,
     * whitespace-trimmed). Log strings and the per-session log-once sets
     * are shared with the v1 path verbatim — only one path runs per boot,
     * so the sets never collide. `stationFilter` is applied uniformly in
     * legacy AND v2 config modes: it's a platform-instance concern (multi-
     * Home child bridges), not a sensor-map concern, and configMode
     * detection deliberately doesn't classify it as a legacy toggle.
     */
    private applyStationFilterV2;
    /**
     * Fetch the raw AWN station payloads for the v2 path. Same endpoint,
     * throttle handling, and content-type guard as `fetchDevices`, but
     * returns the un-parsed per-station shape (macAddress + info + lastData)
     * so the row-driven router can read every field — including the batt*
     * datapoints `parseDevices` drops. Returns `undefined` on fetch/parse
     * failure (caller retries), or `[]` for an empty/non-array response.
     */
    private fetchRawStations;
    /**
     * Load the discovery + ui-state stores for the v2 path. Reads only.
     * The persist dir is `storagePath()/plugin-data/ambient-weather/` — we
     * deliberately avoid `persistPath()` because HAP-NodeJS scans that tree
     * and a subdirectory there crashes it with EISDIR (v2.0.0-beta.1).
     */
    private loadV2Stores;
    /**
     * Surface effective-map diagnostics. Config-attributable errors (e.g.
     * a custom row's `no-wrapper` while the resolution table is empty) log
     * at info so the user learns their sensor was rejected; warnings and
     * attribution-free notes stay at debug.
     */
    private logEffectiveMapDiagnostics;
    /**
     * v2 value distribution. Sensor VALUES go through the Stage-3 routing
     * mechanism (`distributeViaRouting`); the BATTERY bridge handles the
     * standalone batt* datapoints the router deliberately ignores.
     *
     * Until the shared `resolveBatteryField` helper lands (a later Stage-4
     * commit), the bridge preserves the legacy known-field battery path:
     * for every row that owns a Battery sub-service it reads the row's
     * already-resolved `batteryField` off the same payload and pushes
     * HomeKit's `true = low` boolean, so battery updates don't regress.
     */
    private distributeViaV2Routing;
    /**
     * Reshape the realtime source's pre-digested `(uniqueId, value)`
     * updates back into raw per-station payloads so the v2 path routes them
     * through the SAME `distributeViaRouting` boundary the poll path uses.
     * The realtime source emits every numeric field — including the batt*
     * fields — as its own update, so the reconstructed `lastData` carries
     * the battery datapoints the bridge needs.
     */
    private updatesToStationPayloads;
    /**
     * Safe-mode entrypoint — the reduced pipeline for
     * `configMode === 'safe-mode'` per sensor-map.md §17.2. Reads
     * cached accessories that HAP already restored (via
     * `configureAccessory`), and for each KNOWN native default-map
     * accessory whose primary service + value characteristic(s) are
     * already attached, builds a `SafeModeBinding` (see
     * `src/safeModeBinding.ts`) that pushes fresh values through the
     * RETAINED `Characteristic` instance's `updateValue()`. It does
     * NOT construct v1.6.0 wrapper objects — those mutate the HAP
     * graph via `addService` / `removeService` in their constructors.
     * Bindings are keyed by normalized uniqueId (MAC uppercased) so
     * the value-distribution lookup matches regardless of cache
     * casing.
     *
     * What safe mode explicitly does NOT do:
     *   - construct wrapper objects or otherwise mutate the HAP graph
     *     (no `addService` / `removeService`; no attaching a missing
     *     characteristic via `updateCharacteristic`);
     *   - call `registerPlatformAccessories` / `unregisterPlatformAccessories`;
     *   - call `updatePlatformAccessories` (no displayName rewrites);
     *   - write to any plugin persistence file (the shadowMode observer
     *     has its own safe-mode short-circuit for its persist tree);
     *   - reconcile against `parseDevices`'s "orphan" set;
     *   - run realtime — transport is polling ONLY (realtime would
     *     require interpreting apiKey/applicationKey semantics from the
     *     unsupported config).
     *
     * Value distribution runs through `safeModePollAndDistribute()`
     * (NOT the normal `distribute()` / `parseDevices()` path — those
     * apply config-derived sensor toggles / include-exclude / station
     * filters we can't safely interpret in safe mode). It reads the
     * raw AWN JSON and pushes each bound sensor's value + battery by
     * uniqueId. Accessories that couldn't be bound — extended-sensor
     * types, unrecognized cached types, custom dataPoints, or missing
     * characteristics — stay frozen at their cached HAP values.
     */
    private safeModeStart;
    /**
     * Fetch the raw AWN payload and push each (station, dataPoint)
     * value directly to the matching safe-mode binding — bypassing
     * `parseDevices()` entirely so config filters (sensor toggles,
     * include/exclude lists, station filters) never touch the flow.
     *
     * Safe mode's contract: the config version is unsupported, so we
     * cannot interpret its filters safely. We CAN still identify
     * cached accessories by their uniqueId (`${mac}-${dataPoint}`),
     * so this path just looks each AWN field up in the binding map
     * and pushes if we recognize it. Anything else — including
     * fields that the config's filters would have dropped in normal
     * mode — is silently ignored.
     */
    private safeModePollAndDistribute;
    /**
     * Construct the right sensor-type wrapper for an accessory based on
     * the cached context.device.type. Returns the wrapper so the platform
     * can index it by uniqueId for the poll-and-distribute loop.
     */
    private createSensorWrapper;
    /**
     * Start the platform-level poll timer. One timer covers every
     * accessory: on each tick we fetch the full devices payload from AWN
     * once and fan the values out to wrappers via setValue(). Previously
     * every wrapper owned its own setInterval, which meant N accessories
     * triggered N parallel fetches per cycle — racing AWN's 1 req/s
     * rate limit and getting "saved" only by the disk cache.
     */
    private startPolling;
    /**
     * Open a long-lived websocket subscription to AWN's realtime endpoint.
     * Sensor updates arrive as they happen (typically ~30s cadence
     * indoors), feed through the same `distribute` fanout the poll path
     * uses, and end up calling setValue() on the matching wrapper.
     */
    private startRealtime;
    /**
     * Fetch fresh values once and push each one into the matching wrapper.
     * Wrappers not present in the response are simply left untouched on
     * this tick — HomeKit will keep showing the last known value.
     */
    private pollAndDistribute;
    /**
     * Common fanout used by both the polling and realtime data sources.
     * Looks up each update's wrapper by uniqueId; values for sensors we
     * never registered (unknown sensor types, excluded by config, etc.)
     * are silently ignored.
     */
    private distribute;
}
//# sourceMappingURL=platform.d.ts.map
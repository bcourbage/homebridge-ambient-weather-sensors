import * as path from 'path';

import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { AirQualityAccessory } from './airQualityAccessory.js';
import { batteryFieldForSensor, isCanonicalSensorForBattery, readBatteryLow } from './batteryFields.js';
// Battery field naming pattern, used to detect raw battery field
// names in user-supplied excludeSensors entries. Anchored to avoid
// matching unrelated sensor keys like `batteryStatus` if one ever
// appears.
const BATTERY_FIELD_REGEX = /^batt(?:out|in|_co2|_lightning|\d+)$/;
import { Co2Accessory } from './co2Accessory.js';
import {
  LightningDayAccessory,
  LightningDistanceAccessory,
  LightningHourAccessory,
  LightningLastStrikeAccessory,
} from './extendedSensors/lightningAccessory.js';
import {
  PressureAbsoluteAccessory,
  PressureRelativeAccessory,
} from './extendedSensors/pressureAccessory.js';
import {
  LastRainAccessory,
  RainDailyAccessory,
  RainEventAccessory,
  RainMonthlyAccessory,
  RainRateAccessory,
  RainWeeklyAccessory,
  RainYearlyAccessory,
} from './extendedSensors/rainAccessory.js';
import { UvAccessory } from './extendedSensors/uvAccessory.js';
import {
  WindDirection10mAccessory,
  WindDirectionAccessory,
  WindGustAccessory,
  WindMaxDailyGustAccessory,
  WindSpeedAccessory,
} from './extendedSensors/windAccessory.js';
import { HumidityAccessory } from './humidityAccessory.js';
import { RealtimeSource } from './realtimeSource.js';
import { bindSafeMode, type SafeModeBinding } from './safeModeBinding.js';
import { inferForCachedAccessory } from './sensorMap/bootstrap.js';
import { coerceValue } from './sensorMap/coerceValue.js';
import { detectConfigMode, type ConfigMode } from './sensorMap/configMode.js';
import {
  composeDisplayName as sharedComposeDisplayName,
  composeRowDisplayName,
  hapClean as sharedHapClean,
} from './sensorMap/displayName.js';
import { legacyTypeForWrapperId } from './sensorMap/legacyDeviceType.js';
import {
  DISCOVERY_FILE,
  DiscoveryTracker,
  cleanupStaleTempFiles,
  loadDiscoveryStore,
} from './sensorMap/persistence/discoveryStore.js';
import {
  NOTICES_FILE,
  appendNotice,
  loadNoticeStore,
} from './sensorMap/persistence/noticesStore.js';
import { UI_STATE_FILE, loadUiStateStore } from './sensorMap/persistence/uiStateStore.js';
import {
  buildPlatformEffectiveMap,
  sensorMapShapeError,
  type EffectiveMapConfig,
} from './sensorMap/platformEffectiveMap.js';
import {
  buildWrapperRouting,
  distributeViaRouting,
  routingKey,
  type RoutingEntry,
  type StationPayload,
} from './sensorMap/routing.js';
import { resolveBatteryField } from './sensorMap/resolveBatteryField.js';
import { createShadowMode, shadowModeEnabled, type ShadowMode } from './sensorMap/shadowMode.js';
import { computeStructuralSignature } from './sensorMap/structuralSignature.js';
import type {
  DiscoveryStore,
  EffectiveSensorMap,
  EffectiveSensorRow,
  StationRecord,
  UiStateStore,
  UnrecognizedRow,
} from './sensorMap/types.js';
import { wrapperById } from './sensorMap/wrappers.js';
import { friendlySensorName, sensorKeyByFriendlyName } from './sensorNames.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SolarRadiationAccessory } from './solarRadiationAccessory.js';
import { TemperatureAccessory } from './temperatureAccessory.js';
import { DEVICE } from './types.js';

/**
 * Re-export of the HAP Name sanitizer. Kept exported here for tests
 * that were written against `platform.hapClean` before the helper
 * moved to `sensorMap/displayName.ts`. The compat layer uses the
 * shared module directly.
 */
export const hapClean = sharedHapClean;

/**
 * Normalize a string the user might have typed in their config for
 * matching against sensor identifiers. Trims whitespace and lowercases.
 * Empty / non-string values normalize to the empty string, which the
 * caller is expected to filter out.
 *
 * Exported for test coverage.
 */
export function normalizeMatchKey(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Build a Set of normalized matchers from a config-supplied array. Used
 * for both `excludeSensors` and `includeOnly`; the same matching rules
 * apply to both (case-insensitive, whitespace-trimmed, non-string and
 * blank entries dropped).
 *
 * Exported for test coverage.
 */
export function toMatcherSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    const k = normalizeMatchKey(entry);
    if (k.length > 0) {
      out.add(k);
    }
  }
  return out;
}

// Polling cadence for the AWN REST API. AWN's documented rate limit is
// 1 req/sec per apiKey, so any cadence above that is safe; 2 minutes
// matches the previous behavior and avoids surprising users.
const POLL_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Normalize a `${mac}-${dataPoint}` uniqueId so its MAC prefix is
 * uppercase, leaving the dataPoint untouched. Cached uniqueIds
 * preserve whatever MAC casing the AWN API returned at registration
 * time; safe-mode value distribution uppercases the response MAC
 * before lookup, so the binding map must be keyed with a normalized
 * MAC to match. A MAC is `HH:HH:HH:HH:HH:HH` — 17 chars, hyphen at
 * index 17. Anything malformed is returned unchanged.
 */
function normalizeUniqueId(uniqueId: string): string {
  if (uniqueId.length <= 18 || uniqueId[17] !== '-') {
    return uniqueId;
  }
  return uniqueId.slice(0, 17).toUpperCase() + uniqueId.slice(17);
}

/**
 * An effective row that is neither unrecognized nor synthetic — the only
 * shape the v2 reconciler registers. Narrowing once here keeps the
 * reconcile loop free of repeated `kind === 'unrecognized'` guards.
 */
type ConfiguredEffectiveRow = Exclude<EffectiveSensorRow, UnrecognizedRow>;

/**
 * The v2 reconciler's context shape: v1.7's DEVICE with an OPTIONAL
 * `value` (review finding 7). An uncoercible reading with no cached
 * fallback leaves the initial value unset rather than fabricating a
 * real 0 observation; every seed path — the platform seed loop and the
 * wrapper constructors — already guards on `typeof value === 'number'`,
 * v1.7 included, so a downgrade tolerates the absent field.
 */
type V2Device = Omit<DEVICE, 'value'> & { value?: number };

/**
 * A single AWN station as returned by the REST `/v1/devices` endpoint,
 * narrowed to the fields the v2 reconciler + router touch. Mirrors the
 * per-station shape `parseDevices` consumes.
 */
interface RawStation {
  macAddress: string;
  info?: { name?: string };
  lastData: Record<string, unknown>;
}

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

export class AmbientWeatherSensorsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  // Per-uniqueId wrapper instances created in discoverDevices() and
  // looked up by the poll tick to fan out fresh API values without each
  // wrapper having to call fetchDevices() on its own timer.
  private readonly wrappers: Map<string, SensorAccessory> = new Map();

  // Tracks which sensors have already been logged as excluded this
  // session, so we surface one info-level log per excluded sensor
  // per Homebridge restart instead of one per poll tick. Subsequent
  // poll iterations still debug-log so the verbose path is intact
  // for users who run with HB_LOG_LEVEL=debug. SmartThings follows
  // the same pattern (see homebridge-smartthings-oauth's startup
  // "Ignoring X because..." lines) and it's the right shape — users
  // need confirmation their exclude/include filters are working,
  // but not on every fetch.
  private readonly loggedExcludeHits = new Set<string>();
  private readonly loggedIncludeMisses = new Set<string>();

  // Same per-session-once log policy for stationFilter drops. The key
  // is the station MAC address (stable, present on every AWN payload)
  // so we surface one info-level line per dropped station per
  // Homebridge restart and stay quiet thereafter.
  private readonly loggedStationFilterDrops = new Set<string>();

  // Tripped if stationFilter is set but matches zero stations in the
  // AWN response. Warn once per session — this is a config error the
  // user has to fix, not a transient situation.
  private warnedStationFilterEmpty = false;

  // Tripped once we've emitted the "stationFilter active" confirmation
  // line for this session. Without this, users who configure a filter
  // that matches all available stations have no visible signal the
  // filter is working — they see the same accessories they had
  // before and assume it's broken. One line at startup is enough.
  private loggedStationFilterSummary = false;

  // Tracks which battery-field suppressions we've already announced
  // at info level this session. Format follows the existing exclude/
  // include logging policy: one line per suppressed field per
  // Homebridge restart, debug-only thereafter.
  private readonly loggedBatterySuppressions = new Set<string>();

  // Tracks which stations we've already announced at startup. The
  // first time parseDevices sees a station MAC, we info-log its name
  // + MAC + sensor count so users can identify exactly which string
  // to put in their `stationFilter` config. Subsequent ticks stay
  // quiet. Logged BEFORE filtering so users running the plugin to
  // discover station names see every station their AWN account has,
  // not just the filtered subset.
  private readonly loggedDiscoveredStations = new Set<string>();

  // Handle for the platform-level poll timer so we never start two.
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  // Realtime websocket source — instantiated lazily only if the user
  // opted into `dataSource: "realtime"` via config.
  private realtimeSource: RealtimeSource | undefined;

  // Safe-mode bindings — populated by `safeModeStart()` only when
  // configMode === 'safe-mode'. Each binding pushes AWN values to
  // an EXISTING characteristic on a cached accessory via the
  // retained characteristic instance's `updateValue()` — never
  // `Service.updateCharacteristic` (which attaches a missing
  // characteristic on demand), never addService/removeService.
  // Distinct from `this.wrappers` because wrapper constructors
  // mutate the HAP graph, which safe mode forbids per
  // sensor-map.md §17.2. Keyed by normalized uniqueId (MAC
  // uppercased). See src/safeModeBinding.ts for the mapping.
  private readonly safeModeBindings = new Map<string, SafeModeBinding>();

  // Sensor-map v2.0 shadow-mode observer. Undefined unless the user
  // opts in via env `SENSOR_MAP_V2=1` or hidden config `_sensorMapV2`.
  // When present, runs the v2 pipeline in parallel and logs divergence
  // vs. the v1.6.0 code path. Never writes to Homebridge state.
  // See src/sensorMap/shadowMode.ts.
  //
  // Superseded by the LIVE v2 path: when `sensorMapV2` is on we run real
  // v2 reconciliation (`discoverDevicesV2`) instead of the compare-only
  // observer, so the two never run together (handoff: "do not run both
  // observer and live reconciliation"). With the flag off the observer
  // was never created either, so this is effectively always undefined
  // now — the module + its unit tests remain until GA task #65.
  private readonly shadow: ShadowMode | undefined;

  // Sensor-map v2.0 LIVE flag. Set once at construction from the same
  // `_sensorMapV2` / `SENSOR_MAP_V2` signal. When true, `discoverDevices`
  // routes to the flag-gated `discoverDevicesV2` reconciler (row-driven
  // construction + routing); when false, behaviour is byte-identical to
  // v1.7.0. Default OFF.
  private readonly sensorMapV2: boolean;

  // Row-driven value-routing map (`${MAC}|${dataPoint}` → wrapper+row),
  // populated by `discoverDevicesV2`. Its presence is the runtime switch
  // that makes `pollAndDistribute` / `distribute` fan values out through
  // `distributeViaRouting` instead of the v1.6.0 uniqueId lookup.
  private v2Routing: Map<string, RoutingEntry> | undefined;

  // The reconciled effective map the routing above was built from —
  // retained so runtime battery reads resolve their field through the
  // shared `resolveBatteryField(effectiveMap, mac, dp)` reader. Stays
  // undefined with the flag off, which makes that reader fall back to
  // the v1.6.0 static lookup on every legacy path.
  private v2EffectiveMap: EffectiveSensorMap | undefined;

  // Per-session log-once set for preserve-cached accessories (review
  // P1-2 / sensor-map §17.3): cached accessories whose kind/measurement
  // can't be inferred are kept, not unregistered, and announced once.
  private readonly loggedPreservedAccessories = new Set<string>();

  // Discovery tracker for the live v2 path (review P1-4): the platform
  // now OWNS the plugin's discovery registry — the shadow observer that
  // used to feed it is retired when the flag selects the live path.
  // Observes every post-filter (station, dataPoint) pair at discovery
  // and on each poll tick, throttles lastSeen-only writes internally,
  // and is force-flushed from the shutdown handler. Created lazily by
  // initV2Persistence(); never created in safe mode or flag-off.
  private v2Tracker: DiscoveryTracker | undefined;

  // Sensor-map v2.0 configVersion detection outcome, computed once at
  // startup and never re-evaluated. Drives which startup pipeline
  // runs:
  //
  //   'legacy' / 'v2' — normal operation via `discoverDevices()`.
  //                     With `_sensorMapV2` OFF (default) the v1.6.0
  //                     code path drives everything; with it ON the
  //                     flag-gated `discoverDevicesV2` reconciler runs
  //                     the row-driven construction + routing pipeline
  //                     instead (finding-#4 Stage 4).
  //   'safe-mode'    — safe mode is contractually reconciliation-free
  //                     per sensor-map.md §17.2. `discoverDevices()`
  //                     is NOT called; `safeModeStart()` runs the
  //                     reduced pipeline instead — it binds existing
  //                     services/characteristics on cached
  //                     accessories (no register/deregister/rename/
  //                     updatePlatformAccessories, no HAP graph
  //                     mutation) and starts POLLING (realtime
  //                     disabled) to push fresh values through
  //                     `safeModePollAndDistribute()`. Accessories
  //                     it can't bind (extended-sensor / unknown /
  //                     custom-dataPoint / missing-characteristic)
  //                     stay frozen at last-known values. This keeps
  //                     live values flowing to identifiable native
  //                     sensors while never destroying user-critical
  //                     HomeKit state under an uninterpretable config.
  private configMode: ConfigMode = 'legacy';

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {

    this.log.debug('Finished initializing platform:', this.config.platform);

    // Detect the sensor-map v2 opt-in once. When on, the live v2 path
    // (discoverDevicesV2) runs and the compare-only shadow observer is
    // NOT instantiated — the two must not run together. When off, the
    // shadow observer wouldn't be created anyway (createShadowMode
    // returns undefined), so the flag-off path stays byte-identical.
    this.sensorMapV2 = shadowModeEnabled({
      config: this.config as unknown as Record<string, unknown>,
    });

    // Instantiate the sensor-map shadow observer only when the live v2
    // path is NOT active. Returns undefined when the flag is off, and
    // platform.ts uses `?.` everywhere.
    this.shadow = this.sensorMapV2
      ? undefined
      : createShadowMode({
        log: this.log,
        config: this.config as unknown as Parameters<typeof createShadowMode>[0]['config'],
        api: this.api,
      });

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');

      // Detect config mode ONCE at startup. This is the authoritative
      // gate: in safe mode `discoverDevices()` is skipped and
      // `safeModeStart()` runs the reduced, reconciliation-free
      // pipeline instead. See the `configMode` field comment for the
      // full contract.
      const detected = detectConfigMode(this.config as never);
      this.configMode = detected.mode;
      for (const w of detected.warnings) {
        this.log.warn(w);
      }
      if (detected.safeModeBanner) {
        this.log.error(`SAFE MODE: ${detected.safeModeBanner}`);
      }

      // Load persisted discovery state + log detected config mode.
      // Non-blocking: swallow errors so a broken persistence store
      // never prevents the plugin from starting.
      this.shadow?.initialize().catch(e =>
        this.log.warn(`[sensor-map v2 shadow] initialize failed: ${(e as Error).message}`),
      );

      if (this.configMode === 'safe-mode') {
        // Per docs/future/sensor-map.md §17.2, safe mode is not a
        // hard freeze — it's "reconciliation skipped, updates
        // continue." Cached accessories keep running, polling /
        // realtime keeps pushing fresh values to their wrappers,
        // but there is NO register / deregister / rename /
        // updatePlatformAccessories / persistence write.
        // safeModeStart() runs that reduced pipeline; the full
        // register-and-reconcile discoverDevices() path is
        // deliberately not called.
        this.safeModeStart();
        return;
      }

      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });

    // Clean shutdown — stop the realtime websocket so its reconnect
    // backoff doesn't fire after Homebridge has begun tearing down.
    this.api.on('shutdown', () => {
      log.debug('Executed shutdown callback');
      this.realtimeSource?.stop();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      // Force-flush any pending discovery writes before Homebridge
      // finishes tearing down — the live v2 tracker and (legacy) the
      // shadow observer's tracker respectively.
      this.v2Tracker?.flush(true).catch(e =>
        this.log.warn(`[sensor-map v2] shutdown discovery flush failed: ${(e as Error).message}`),
      );
      this.shadow?.shutdown().catch(e =>
        this.log.warn(`[sensor-map v2 shadow] shutdown flush failed: ${(e as Error).message}`),
      );
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.push(accessory);
    // Shadow-mode: log what the v2 sensor-map layer would infer for
    // this cached accessory. No context mutation — v1.6.0 code still
    // owns registration.
    this.shadow?.onConfigureAccessory(accessory);
  }

  determineSensorType(sensor: string) {
    // The temp/humid/solar matchers use String.includes which is broad
    // enough to catch numbered variants (temp1f, humidity10, etc.) but
    // also indiscriminately. The newer matchers below use stricter
    // regexes to avoid catching battery-status keys like `batt_co2` or
    // AQIN's own internal temperature key `pm_in_temp_aqin`.
    //
    // NOTE on the `aqi_pm25*` family: AWN reports `999` as a "no
    // sensor present" sentinel on the base station's outdoor PM
    // fields when only the AQIN has working PM hardware. The `pm25`
    // regex below uses `^pm25($|_)` (anchored start), which
    // deliberately does NOT match `aqi_pm25_*` keys — those are
    // pre-computed AQI values, not raw PM concentrations, and they
    // can carry sentinel values that would mislead HomeKit users.
    // If a future change loosens the regex, re-check this guard.
    if (
      (sensor.includes('temp') || sensor.includes('feelsLike') || sensor.includes('dewPoint'))
      && this.config.temperatureSensors
    ) {
      return 'Temperature';
    } else if (sensor.includes('humid') && this.config.humiditySensors) {
      return 'Humidity';
    } else if (sensor.includes('solar') && this.config.solarRadiationSensors) {
      return 'Solar Radiation';
    } else if (/^co2($|_)/.test(sensor) && this.config.co2Sensors) {
      return 'CO2';
    } else if (/^pm25($|_)/.test(sensor) && this.config.airQualitySensors) {
      return 'PM2.5';
    } else if (/^pm10($|_)/.test(sensor) && this.config.airQualitySensors) {
      return 'PM10';
    }

    // Extended sensors (v1.5.0). Gated by the master toggle
    // `extendedSensors` AND a per-category sub-toggle. Both must be
    // truthy for the type to be returned — so a user who hasn't opted
    // in sees no behavior change vs. v1.4.x.
    //
    // Additionally, each user-configurable threshold has an explicit
    // per-threshold enable checkbox in the config form (default true).
    // When the checkbox is unchecked, the corresponding sensor
    // accessory is hidden from HomeKit. This replaces the beta.6
    // "blank threshold = hide" mechanic because homebridge-config-ui-x
    // re-injects schema defaults into blanked number fields, making
    // "blank" impossible to express through the form.
    //
    // Sensors without a user-configurable threshold (wind direction,
    // rain accumulation totals, last-event timestamps, lightning
    // counts) have no enable checkbox; they appear whenever their
    // category is on. Use Exclude Sensors to hide them individually.
    if (!this.config.extendedSensors) {
      return 'NOT_SUPPORTED';
    }
    const thresholds = this.config.thresholds ?? {};
    // Default-true semantics: only explicit `false` disables the
    // sensor. Undefined (first install, never touched the form) or
    // any non-false value means enabled.
    const enabled = (v: unknown): boolean => v !== false;

    if (this.config.windSensors) {
      if (sensor === 'windspeedmph') {
        return enabled(thresholds.windSpeedEnabled) ? 'WindSpeed' : 'NOT_SUPPORTED';
      }
      if (sensor === 'windgustmph') {
        return enabled(thresholds.windGustEnabled) ? 'WindGust' : 'NOT_SUPPORTED';
      }
      if (sensor === 'maxdailygust') {
        // Max Daily Gust shares the windGustEnabled toggle with Wind Gust.
        return enabled(thresholds.windGustEnabled) ? 'WindMaxDailyGust' : 'NOT_SUPPORTED';
      }
      if (sensor === 'winddir') {
        return 'WindDirection';
      }
      if (sensor === 'winddir_avg10m') {
        return 'WindDirection10m';
      }
    }
    if (this.config.rainSensors) {
      if (sensor === 'hourlyrainin') {
        return enabled(thresholds.rainRateEnabled) ? 'RainRate' : 'NOT_SUPPORTED';
      }
      // Accumulation totals and lastRain have no user-configurable
      // threshold — they trigger on any non-zero accumulation /
      // any reported timestamp, and stay visible while the category is on.
      if (sensor === 'eventrainin') {
        return 'RainEvent';
      }
      if (sensor === 'dailyrainin') {
        return 'RainDaily';
      }
      if (sensor === 'weeklyrainin') {
        return 'RainWeekly';
      }
      if (sensor === 'monthlyrainin') {
        return 'RainMonthly';
      }
      if (sensor === 'yearlyrainin') {
        return 'RainYearly';
      }
      if (sensor === 'lastRain') {
        return 'LastRain';
      }
    }
    if (this.config.pressureSensors) {
      // Both pressure accessories share the pressureEnabled toggle.
      if (sensor === 'baromrelin') {
        return enabled(thresholds.pressureEnabled) ? 'PressureRelative' : 'NOT_SUPPORTED';
      }
      if (sensor === 'baromabsin') {
        return enabled(thresholds.pressureEnabled) ? 'PressureAbsolute' : 'NOT_SUPPORTED';
      }
    }
    if (this.config.uvSensors) {
      if (sensor === 'uv') {
        return enabled(thresholds.uvEnabled) ? 'UV' : 'NOT_SUPPORTED';
      }
    }
    if (this.config.lightningSensors) {
      // Strike counts (day/hour) and last-strike timestamp have no
      // user-configurable threshold; they stay visible while the
      // category is on. Distance is the one configurable trigger.
      if (sensor === 'lightning_day') {
        return 'LightningDay';
      }
      if (sensor === 'lightning_hour') {
        return 'LightningHour';
      }
      if (sensor === 'lightning_distance') {
        return enabled(thresholds.lightningDistanceEnabled) ? 'LightningDistance' : 'NOT_SUPPORTED';
      }
      if (sensor === 'lightning_time') {
        return 'LightningLastStrike';
      }
    }

    return 'NOT_SUPPORTED';
  }

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
  composeDisplayName(
    obj: { macAddress: string; info?: { name?: string } },
    sensorKey: string,
    isMultiStation: boolean,
  ): string {
    return sharedComposeDisplayName(
      { macAddress: obj.macAddress, name: obj.info?.name ?? '' },
      sensorKey,
      isMultiStation,
    );
  }

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
  private buildSuppressedBatteries(excludeRaw: unknown): Set<string> {
    const suppressed = new Set<string>();
    if (!Array.isArray(excludeRaw)) {
      return suppressed;
    }
    for (const rawEntry of excludeRaw) {
      if (typeof rawEntry !== 'string') {
        continue;
      }
      const normalized = rawEntry.trim().toLowerCase();
      if (normalized.length === 0) {
        continue;
      }
      // Form 1: raw AWN battery field name (battout, battin, batt1..N, batt_co2, batt_lightning).
      if (BATTERY_FIELD_REGEX.test(normalized)) {
        suppressed.add(normalized);
        if (!this.loggedBatterySuppressions.has(normalized)) {
          this.log.info(`Battery sub-service suppressed: ${normalized} (matched excludeSensors entry "${rawEntry}")`);
          this.loggedBatterySuppressions.add(normalized);
        }
        continue;
      }
      // Forms 2 + 3: "<sensor>-batt" suffix. Stem can be either an AWN
      // sensorKey or its friendly name; we try each.
      if (normalized.endsWith('-batt')) {
        const stem = normalized.slice(0, -'-batt'.length).trim();
        // Try as a sensorKey directly first.
        let field = batteryFieldForSensor(stem);
        if (!field) {
          // Reverse-lookup via the friendly-name table.
          const sensorKey = sensorKeyByFriendlyName(stem);
          if (sensorKey) {
            field = batteryFieldForSensor(sensorKey);
          }
        }
        if (field) {
          suppressed.add(field);
          if (!this.loggedBatterySuppressions.has(field)) {
            this.log.info(`Battery sub-service suppressed: ${field} (matched excludeSensors entry "${rawEntry}")`);
            this.loggedBatterySuppressions.add(field);
          }
        } else {
          this.log.debug(`Battery suppression entry "${rawEntry}" did not resolve to a known sensor; skipping`);
        }
      }
    }
    return suppressed;
  }

  parseDevices(json) {
    const Devices:DEVICE[] = [];

    // Shadow-mode accumulators. Populated only when this.shadow is set.
    // `shadowObserved` collects EVERY (station, dataPoint) pair AWN
    // reported this tick — including battery fields and any keys
    // determineSensorType skipped. `shadowV1Decisions` accumulates
    // only the pairs the v1.6.0 code path actually registered. The
    // diff of the two, plus the sensor-map's own decisions, is what
    // ShadowMode.onParseTick compares.
    const shadowObserved: Array<{ stationMac: string; stationName: string; dataPoint: string }> = [];
    const shadowV1Decisions: Array<{ stationMac: string; dataPoint: string; type: string }> = [];

    // Build matcher sets once per call. Matching is intentionally
    // forgiving — case-insensitive and whitespace-trimmed — so that a
    // user typing "Indoor Temperature" or "indoor temperature " (with
    // a stray space from copy-paste) both work. Empty entries are
    // dropped so an accidentally-blank line in the config doesn't
    // accidentally match every sensor.
    const includeMatchers = toMatcherSet(this.config.includeOnly);
    const excludeMatchers = toMatcherSet(this.config.excludeSensors);
    const stationMatchers = toMatcherSet(this.config.stationFilter);

    // Battery-suppression set: entries in excludeSensors that target
    // a sub-service rather than a whole accessory. See
    // buildSuppressedBatteries() for the accepted forms.
    const suppressedBatteries = this.buildSuppressedBatteries(this.config.excludeSensors);

    // Apply stationFilter at the station level BEFORE any per-sensor
    // processing. The filter is the supported way to split stations
    // across multiple HomeKit Homes: each platform instance gets its
    // own filter, its own child bridge, and exposes only the stations
    // matching its filter. Match accepts either AWN's `info.name` or
    // the station's MAC address — MAC is more stable if the user
    // renames stations in the AWN app.
    //
    // When stationFilter is empty (the default), no filtering happens
    // and behavior is identical to v1.5.0-beta.17 and earlier.
    let stations: Array<{ macAddress: string; info?: { name?: string }; lastData: Record<string, unknown> }> =
      Array.isArray(json) ? json : [];

    // Announce each discovered station once per Homebridge restart.
    // This is the primary way users find out the exact `info.name`
    // and MAC strings to put in their `stationFilter` config — the
    // value isn't visible anywhere else in the Homebridge UI. Logged
    // BEFORE any filtering so users see every station available on
    // their AWN account, not just the filtered subset.
    for (const station of stations) {
      if (!this.loggedDiscoveredStations.has(station.macAddress)) {
        const sensorCount = Object.keys(station.lastData ?? {}).length;
        this.log.info(`Discovered station "${station.info?.name ?? '(unnamed)'}" `
          + `(MAC: ${station.macAddress}) — ${sensorCount} sensor fields reported`);
        this.loggedDiscoveredStations.add(station.macAddress);
      }
    }

    if (stationMatchers.size > 0) {
      const totalBeforeFilter = stations.length;
      const matched: typeof stations = [];
      for (const station of stations) {
        const nameKey = normalizeMatchKey(station.info?.name ?? '');
        const macKey = normalizeMatchKey(station.macAddress ?? '');
        const hit = (nameKey.length > 0 && stationMatchers.has(nameKey))
          || (macKey.length > 0 && stationMatchers.has(macKey));
        if (hit) {
          matched.push(station);
        } else if (!this.loggedStationFilterDrops.has(station.macAddress)) {
          this.log.info(`Station "${station.info?.name ?? '(unnamed)'}" (MAC: ${station.macAddress}) `
            + 'filtered out by stationFilter');
          this.loggedStationFilterDrops.add(station.macAddress);
        }
      }
      if (matched.length === 0 && !this.warnedStationFilterEmpty) {
        this.log.warn(`stationFilter is set but matched zero stations in the AWN response. `
          + `Filter values: [${[...stationMatchers].join(', ')}]. No accessories will be exposed by this platform instance.`);
        this.warnedStationFilterEmpty = true;
      } else if (matched.length > 0 && !this.loggedStationFilterSummary) {
        // Positive confirmation that the filter is active. Without
        // this, a user whose filter matches every available station
        // sees zero "filtered out" lines and assumes the filter
        // isn't doing anything. This line fires regardless of how
        // many stations matched — once per session, on the first
        // tick where at least one station passes.
        this.log.info(`stationFilter active: [${[...stationMatchers].join(', ')}] — `
          + `${matched.length} of ${totalBeforeFilter} station(s) passed`);
        this.loggedStationFilterSummary = true;
      }
      stations = matched;
    }

    // Detect whether the user has multiple AWN stations on this
    // account. The accessory displayName uses a station prefix only
    // when this is true — single-station users get clean
    // "Indoor Temperature" tiles, multi-station users get
    // "Backyard Station Indoor Temperature" / "Garage Station
    // Indoor Temperature" for disambiguation. See composeDisplayName.
    //
    // This is recomputed AFTER stationFilter has been applied. A
    // multi-Home setup with one station per platform instance gets
    // bare tile names in each Home (since each instance sees exactly
    // one station post-filter); a multi-station-single-home setup
    // sees multiple stations and gets prefixed names for clarity.
    const isMultiStation = stations.length > 1;

    if (stations.length > 0) {
      stations.forEach( (obj) => {
        Object.entries(obj.lastData).forEach( (device) => {
          const sensorKey = device[0];
          // Shadow-mode: record EVERY key AWN reported for this station,
          // even the ones determineSensorType skips (battery fields,
          // unknown extras). The tracker uses this to build discovery.json.
          if (this.shadow) {
            shadowObserved.push({
              stationMac: obj.macAddress,
              stationName: obj.info?.name ?? '',
              dataPoint: sensorKey,
            });
          }
          const type = this.determineSensorType(sensorKey);
          if (type === 'NOT_SUPPORTED') {
            return;
          }

          const uniqueId = `${obj.macAddress}-${sensorKey}`;
          const displayName = this.composeDisplayName(obj, sensorKey, isMultiStation);

          // Candidates a user might use to identify this sensor in
          // their config. Ordered from most-specific to least so the
          // log messages can pick whichever they hit first if we
          // wanted that — currently we just check any-match.
          //
          // Includes BOTH naming styles (with-prefix and without)
          // because: (a) on single-station setups the displayName is
          // unprefixed but a user may have an existing config entry
          // with the old prefixed name from a previous version, and
          // (b) on multi-station setups the user may match by either
          // the prefixed name or the bare sensor label. Generating
          // both forms here lets either work.
          //
          // `hapClean` is applied to the prefixedForm so that any
          // non-alphanumeric characters in AWN's `info.name` (hyphens,
          // periods, etc.) are stripped. The pre-beta.15 displayName
          // also passed through hapClean, so user excludeSensors
          // entries that match the old cleaned name (e.g.
          // "Fairhills WS 2000 Indoor Dew Point" from a station whose
          // raw AWN name is "Fairhills WS-2000") continue to match.
          const stationName = obj.info?.name ?? '';
          const prefixedForm = stationName ? hapClean(`${stationName} ${friendlySensorName(sensorKey)}`) : '';
          const matchCandidates: string[] = [
            uniqueId,                          // AA:BB:CC:DD:EE:FF-tempinf
            displayName,                       // current displayName (with or without prefix)
            prefixedForm,                      // always include the prefixed form for back-compat
            sensorKey,                         // tempinf
            friendlySensorName(sensorKey),     // Indoor Temperature
            obj.macAddress,                    // AA:BB:CC:DD:EE:FF
            stationName,                       // Backyard Station (as user typed in AWN, before hapClean)
          ].map(normalizeMatchKey).filter((s) => s.length > 0);

          if (includeMatchers.size > 0 && !matchCandidates.some((c) => includeMatchers.has(c))) {
            // First time we've seen this sensor get filtered out by the
            // include-only allowlist this session: surface at info so
            // the user sees in the log that their config is being
            // honored. Subsequent polls keep the noisier debug path.
            if (!this.loggedIncludeMisses.has(uniqueId)) {
              this.log.info(`Excluding ${displayName}: not in Include Only These Sensors allowlist`);
              this.loggedIncludeMisses.add(uniqueId);
            } else {
              this.log.debug(`Excluding ${uniqueId} (not in includeOnly allowlist)`);
            }
            return;
          }
          if (excludeMatchers.size > 0 && matchCandidates.some((c) => excludeMatchers.has(c))) {
            if (!this.loggedExcludeHits.has(uniqueId)) {
              this.log.info(`Excluding ${displayName}: matched Exclude Sensors list`);
              this.loggedExcludeHits.add(uniqueId);
            } else {
              this.log.debug(`Excluding ${uniqueId} (matched excludeSensors)`);
            }
            return;
          }

          // AWN reports `lastRain` as an ISO-8601 string (e.g.
          // "2026-04-21T22:19:00.000Z"); the LastRainAccessory expects
          // a Unix-ms number so its formatter can compute a relative
          // "time since" string. Convert here so the SensorAccessory
          // interface stays uniformly numeric.
          let value: number = device[1] as number;
          if (sensorKey === 'lastRain' && typeof device[1] === 'string') {
            const parsed = Date.parse(device[1] as string);
            value = Number.isFinite(parsed) ? parsed : 0;
          }

          // Look up the corresponding battery field for this sensor's
          // physical probe and capture the HomeKit-aligned
          // low/normal boolean. Only the canonical sensor for each
          // battery field gets the Battery sub-service — all other
          // sensors sharing the same physical probe get `undefined`
          // here so they skip the sub-service entirely. Without
          // this dedup, a typical WS-2000 produces 30+ battery
          // tiles in Apple Home (one per accessory); with dedup,
          // each physical probe shows ONE battery status on its
          // most representative sensor (canonical mapping in
          // batteryFields.ts). Resolution goes through the shared
          // reader: with the v2 flag off `v2EffectiveMap` is always
          // undefined, so this is exactly the v1.6.0 static lookup.
          const batteryField = resolveBatteryField(this.v2EffectiveMap, obj.macAddress, sensorKey) ?? undefined;
          const batteryLow = (batteryField
                              && isCanonicalSensorForBattery(sensorKey, batteryField)
                              && !suppressedBatteries.has(batteryField))
            ? readBatteryLow(obj.lastData as Record<string, unknown>, batteryField)
            : undefined;

          Devices.push({
            macAddress: obj.macAddress,
            uniqueId,
            displayName,
            type,
            value,
            batteryLow,
          });
          // Shadow-mode: record the v1.6.0 code path's decision for
          // this (station, dataPoint) pair. The shadow observer diffs
          // it against the sensor-map layer's own decision.
          if (this.shadow) {
            shadowV1Decisions.push({
              stationMac: obj.macAddress,
              dataPoint: sensorKey,
              type: String(type),
            });
          }
        });
      });
    }

    // Shadow-mode dispatch. Fire-and-forget compared to the return
    // path — the observer never blocks accessory registration.
    if (this.shadow) {
      this.shadow.onParseTick({
        stations: stations.map(s => ({
          macAddress: s.macAddress,
          name: s.info?.name ?? '',
        })),
        observed: shadowObserved,
        v1Decisions: shadowV1Decisions,
      });
    }

    return Devices;
  }

  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

  async fetchDevices() {
    this.log.debug('Fetching sensors from Ambient Weather API');

    try {
      const url = `https://rt.ambientweather.net/v1/devices?applicationKey=${this.config.applicationKey}&apiKey=${this.config.apiKey}`;
      const response = await fetch(url);

      // request is being throttled
      if (response.status === 429) {
        this.log.debug('429 throttle waiting 1000ms to retry');
        await this.sleep(1000);
        return this.fetchDevices();
      }

      // response is not JSON
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(`API response from AWN is not JSON.
          This happens ocasionally due to the fragility of the AWN API and is usually resolved by retrying the request in a few minutes.`);
      }

      const data: unknown = await response.json();
      return this.parseDevices(data);
    } catch(error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('ERROR:', message);
    }
  }

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
  deregisterAccessories(Devices: DEVICE[]) {
    const currentUniqueIds = new Set(Devices.map((d) => d.uniqueId));

    const orphans = this.accessories.filter((accessory) => {
      const uniqueId = accessory.context?.device?.uniqueId;
      return !uniqueId || !currentUniqueIds.has(uniqueId);
    });

    orphans.forEach((accessory) => {
      this.log.info(`De-registering accessory [${accessory.displayName}]. It was either not found in the API response, `
        + 'or the sensor type has been disabled in the plugin configuration');
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      // Keep this.accessories in sync with HAP so the for-loop downstream
      // doesn't try to "restore" something we just unregistered.
      const idx = this.accessories.indexOf(accessory);
      if (idx >= 0) {
        this.accessories.splice(idx, 1);
      }
    });
  }

  async discoverDevices() {
    // Flag-gated v2 reconciler. Row-driven construction + routing,
    // default OFF. See discoverDevicesV2 for the full contract.
    if (this.sensorMapV2) {
      await this.discoverDevicesV2();
      return;
    }
    try {

      const Devices = await this.fetchDevices();

      // if no devices were returned from the AWN API we can assume that either the user has no devices or the API is down
      if (!Devices) {
        this.log.debug('No devices returned from the AWN API. Retrying in 60 seconds');
        await this.sleep(60000);
        return this.discoverDevices();
      }

      this.log.debug(`TEMPERATURE SENSORS: ${this.config.temperatureSensors}`);
      this.log.debug(`HUMIDITY SENSORS: ${this.config.humiditySensors}`);
      this.log.debug(`BAROMETRIC SENSORS: ${this.config.barometricSensors}`);
      this.log.debug(`WIND SENSORS: ${this.config.windSensors}`);
      this.log.debug(`SOLAR RADIATION SENSORS: ${this.config.solarRadiationSensors}`);

      if (Devices) {
        // remove any existing accessories that arent returned by the API
        this.deregisterAccessories(Devices);

        // loop over the discovered devices and register each one if it has not already been registered
        for (const device of Devices) {

          const uuid = this.api.hap.uuid.generate(device.uniqueId);
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
          let accessory: PlatformAccessory;

          if (existingAccessory) {
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            // Update the HAP-level displayName (the AccessoryInformation
            // Name backing field) so the cache file picks up the new
            // station-derived name and the Home app shows it on the
            // accessory tile. context.device alone is just our private
            // bookkeeping; without this assignment, the underlying HAP
            // Accessory keeps the original displayName it had when it
            // was first registered.
            if (existingAccessory.displayName !== device.displayName) {
              this.log.info(`Renaming accessory: "${existingAccessory.displayName}" -> "${device.displayName}"`);
              existingAccessory.displayName = device.displayName;
            }
            // Unconditionally set the AccessoryInformation Name
            // characteristic to the current displayName on every
            // restore. This is what Apple Home reads for the tile when
            // the user hasn't explicitly renamed the accessory via
            // Home.app. We do this every restore (not just when the
            // displayName diverged) because earlier beta versions of
            // this plugin updated `accessory.displayName` without
            // updating the HAP-side Name characteristic — accessories
            // touched by those betas have a stale Name characteristic
            // even though `displayName` is already correct. This
            // unconditional update is idempotent and pushes the
            // correct value to HAP on every restart.
            existingAccessory.getService(this.Service.AccessoryInformation)
              ?.updateCharacteristic(this.Characteristic.Name, device.displayName);
            existingAccessory.context.device = device;
            this.api.updatePlatformAccessories([existingAccessory]);
            accessory = existingAccessory;
          } else {
            this.log.info('Adding new accessory:', device.displayName);
            accessory = new this.api.platformAccessory(device.displayName, uuid);
            accessory.context.device = device;
          }

          const wrapper = this.createSensorWrapper(accessory);
          if (wrapper) {
            this.wrappers.set(device.uniqueId, wrapper);
            // Seed the freshly-constructed wrapper with the current
            // value so HomeKit has something to display until the
            // first realtime/poll tick fills it in. This runs AFTER
            // the subclass constructor returns, so subclass-specific
            // formatter state (units, etc.) is fully initialized by
            // now — extended sensors' formatValue calls are safe.
            // Native wrappers also self-seed in their constructors,
            // so this is a harmless duplicate for them; for extended
            // sensors, this is the ONLY seed path. See the comment
            // in ExtendedSensorBase for why.
            if (typeof device.value === 'number') {
              try {
                wrapper.setValue(device.value);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log.warn(`Initial value seed failed for ${device.displayName}: ${message}`);
              }
            }
          }

          if (!existingAccessory) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        }
      }

      // Now that all wrappers are registered, choose how to keep them
      // updated (polling vs realtime). See startDataSource().
      this.startDataSource();
    } catch(error) {
      let message;
      if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      this.log.error('ERROR:', message);
    }
  }

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
  private startDataSource(): void {
    let dataSource = this.config.dataSource === 'realtime' ? 'realtime' : 'polling';
    if (dataSource === 'realtime' && this.config.extendedDisplayMode === 'embed') {
      this.log.warn(
        'Embed display mode is incompatible with the realtime data source — '
        + 'the combination causes elevated iOS battery drain from HAP name-update '
        + 'notifications. Forcing polling for this run. To silence this warning, '
        + 'either switch the display mode to "Show generic names" or set the data '
        + 'source explicitly to "polling".',
      );
      dataSource = 'polling';
    }
    this.log.info(`Data source: ${dataSource}`);
    if (dataSource === 'realtime') {
      this.startRealtime();
    } else {
      this.startPolling();
    }
  }

  /**
   * Flag-gated v2 reconciler (finding-#4 Stage 4, first commit). Runs in
   * place of the v1.6.0 discoverDevices path when `sensorMapV2` is on
   * (default OFF, so shipping behaviour is unchanged).
   *
   * Pipeline:
   *   1. Fetch the raw AWN station payloads; apply stationFilter.
   *   2. Initialize persistence under
   *      `storagePath()/plugin-data/ambient-weather/` (NEVER
   *      `persistPath()` — HAP-scan / EISDIR hazard): stale-temp
   *      cleanup, ui-state load, and the platform-owned
   *      DiscoveryTracker (review P1-4) fed with this snapshot's
   *      post-filter observations.
   *   3. Assemble the effective sensor map (pure) from the tracker's
   *      merged discovery view — compat overrides for legacy configs,
   *      `config.sensorMap` for v2.
   *   4. Reconcile the cache (review P1-2): orphans are unregistered
   *      EXCEPT preserve-cached accessories (kind/measurement not
   *      inferable — kept with last-known values per §17.3); restored
   *      accessories have their cached structural signature (stored, or
   *      derived via `inferForCachedAccessory` + Battery-service
   *      presence) compared against the row's frozen signature — a
   *      mismatch re-registers the accessory and records a
   *      structural-change notice (§8.4/§9) instead of mutating the HAP
   *      graph in place.
   *   5. For every enabled, KNOWN, AWN-reported row: build a
   *      v1.7-compatible `context.device` carrying `type` (downgrade
   *      cache recognition) plus `kind`/`measurement`/
   *      `structuralSignature`, restore-or-create its accessory reusing
   *      the v1.7 UUID, instantiate the row-driven wrapper, and register
   *      it. Build the `(mac, dataPoint) → wrapper` routing map and seed
   *      each wrapper's current value.
   *   6. Start the poll / realtime data source; both fan out through
   *      `distributeViaRouting` (see distributeViaV2Routing).
   *
   * Custom (non-default) dataPoints register through the RESTORED
   * resolution table (Stage 4's table-restoration commit): a custom row
   * declaring a `(kind, measurement)` with a concrete wrapper class
   * resolves, registers, and routes like any known row. Kinds without a
   * wrapper class (co, leak, contact, occupancy) still resolve
   * `no-wrapper` and never register.
   *
   * Safe mode never reaches here — `didFinishLaunching` routes to
   * `safeModeStart()` first, before any persistence read that could
   * quarantine or write a file.
   */
  private async discoverDevicesV2(): Promise<void> {
    try {
      // Malformed v2 sensorMap (review finding 6): a PRESENT non-array
      // value is a hand-edit mistake. Treating it as empty would
      // register the FULL default exposure off a config error —
      // instead, freeze: no fetch, no persistence, no reconciliation,
      // cached accessories preserved. Checked before any side effect.
      const shapeError = sensorMapShapeError(this.config as unknown as EffectiveMapConfig, this.configMode);
      if (shapeError) {
        this.log.error(shapeError);
        return;
      }

      const fetched = await this.fetchRawStations();
      if (!fetched) {
        this.log.debug('No devices returned from the AWN API. Retrying in 60 seconds');
        await this.sleep(60000);
        return this.discoverDevicesV2();
      }

      // Apply stationFilter at the station level BEFORE building the
      // inventory — v1 parity (parseDevices filters stations first, and
      // the shadow observer received the post-filter inventory). Without
      // this, a multi-Home child-bridge setup would register EVERY
      // station's accessories on each instance.
      const rawStations = this.applyStationFilterV2(fetched);

      // Station inventory (post-filter). isMultiStation drives the
      // displayName recipe exactly as the v1.6.0 path does — recomputed
      // AFTER stationFilter so a one-station-per-instance multi-Home
      // setup gets bare tile names.
      const stations: StationRecord[] = rawStations.map(s => ({
        macAddress: s.macAddress,
        name: s.info?.name ?? '',
      }));
      const isMultiStation = stations.length > 1;

      // Initialize persistence + feed the tracker with this snapshot's
      // post-filter observations, then take the merged (persisted +
      // live) discovery view. All I/O stays here, OUT of the pure
      // assembly helper below.
      const { uiState } = await this.initV2Persistence();
      this.observeV2Stations(rawStations);
      const discovery: DiscoveryStore = this.v2Tracker!.snapshot();

      // Assemble the effective map (pure).
      const effectiveMap = buildPlatformEffectiveMap({
        config: this.config as unknown as EffectiveMapConfig,
        configMode: this.configMode,
        stations,
        discovery,
        uiState,
      });
      this.logEffectiveMapDiagnostics(effectiveMap);

      // Index raw stations by uppercased MAC for value/battery reads and
      // reported-field gating.
      const rawByMac = new Map<string, RawStation>();
      for (const s of rawStations) {
        rawByMac.set(s.macAddress.toUpperCase(), s);
      }

      // Build v1.7-compatible DEVICE contexts for every enabled, known,
      // AWN-reported row.
      interface Reconciled { row: ConfiguredEffectiveRow; device: V2Device; routingUid: string }
      const reconciled: Reconciled[] = [];
      for (const row of effectiveMap.rows) {
        if (row.kind === 'unrecognized' || !row.enabled) {
          continue;
        }
        const raw = rawByMac.get(row.stationMac);
        if (!raw || !(row.dataPoint in raw.lastData)) {
          // The station didn't report this field this tick — don't
          // register it (v1.6.0 parity: it iterates reported fields only).
          continue;
        }
        const uniqueId = `${raw.macAddress}-${row.dataPoint}`;

        // Initial value (review finding 7 + round 6): an uncoercible
        // reading must never fabricate a REAL zero observation (false
        // temperature / air-quality / trigger state). Seed only from a
        // successful coercion; otherwise leave the value UNSET — no
        // seed fires (every seed path guards on `typeof === 'number'`),
        // so a restored accessory's RETAINED HAP characteristic — which
        // can be newer than any context snapshot, since poll/realtime
        // update the characteristic without rewriting context — is what
        // the user keeps seeing (R6-3: a cached-context fallback here
        // re-seeded stale values over newer retained readings).
        //
        // The single v1.7-parity exception (R6-2): an invalid lastRain
        // STRING parsed to 0 in v1.7 ("never"). Only that dataPoint and
        // only the string shape — other timestamp rows (lightning_time,
        // future customs) had no such special case and stay unset.
        const rawReading = raw.lastData[row.dataPoint];
        let value = coerceValue(row, rawReading);
        if (value === undefined && row.dataPoint === 'lastRain' && typeof rawReading === 'string') {
          value = 0;
        }

        // uniqueId keeps AWN's original MAC casing so the generated UUID
        // matches what v1.7 registered — cached accessories are reused,
        // not orphaned. The routing lookup key uses the row's uppercased
        // MAC (distributeViaRouting uppercases the payload MAC too).
        const device: V2Device = {
          macAddress: raw.macAddress,
          uniqueId,
          // Row-driven naming (review P1-1): the label comes from
          // `row.name` — default-map name, or the user's rename override
          // — composed with the same station-prefix/truncation recipe as
          // v1.7. Keeps the platform displayName consistent with the
          // extended wrappers' service labels, which also read row.name.
          displayName: composeRowDisplayName(
            { macAddress: raw.macAddress, name: raw.info?.name ?? '' },
            row.name,
            isMultiStation,
          ),
          type: legacyTypeForWrapperId(row.wrapperId),
          value,
          // Bootstrap battery seed resolves through the SAME shared
          // reader as polling/realtime (review R17-1) — the invariant
          // is every runtime battery read, including this first one,
          // so the initial context/HAP seed can never drift from what
          // later ticks resolve.
          batteryLow: readBatteryLow(
            raw.lastData,
            resolveBatteryField(effectiveMap, row.stationMac, row.dataPoint) ?? undefined,
          ),
        };
        reconciled.push({ row, device, routingUid: `${row.stationMac}-${row.dataPoint}` });
      }

      // Unregister cached accessories no longer backed by a reconciled
      // row (matches by uniqueId — stable across renames) — EXCEPT
      // preserve-cached accessories (review P1-2 / §17.3): a cached
      // accessory whose kind + measurement can't be inferred stays in
      // HomeKit with last-known values rather than being destroyed. It
      // re-enters normal reconciliation once it becomes inferable (e.g.
      // AWN starts reporting its dataPoint again) on a later reconcile.
      const currentUniqueIds = new Set(reconciled.map(r => r.device.uniqueId));
      const orphans = this.accessories.filter((accessory) => {
        const uniqueId = accessory.context?.device?.uniqueId;
        return !uniqueId || !currentUniqueIds.has(uniqueId);
      });
      for (const orphan of orphans) {
        if (inferForCachedAccessory(orphan).status === 'preserve-cached') {
          const uid = orphan.context?.device?.uniqueId ?? orphan.displayName;
          if (!this.loggedPreservedAccessories.has(uid)) {
            this.loggedPreservedAccessories.add(uid);
            this.log.info(`Preserving cached accessory [${orphan.displayName}]: its sensor kind/measurement `
              + 'cannot be inferred yet. It stays in HomeKit with last-known values (sensor-map §17.3).');
          }
          continue;
        }
        this.log.info(`De-registering accessory [${orphan.displayName}]. It was either not found in the API response, `
          + 'or the sensor type has been disabled in the plugin configuration');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [orphan]);
        const idx = this.accessories.indexOf(orphan);
        if (idx >= 0) {
          this.accessories.splice(idx, 1);
        }
      }

      // Restore-or-create each accessory. New accessories are registered
      // AFTER wrapper construction (below) so HAP sees the full service
      // graph, matching the v1.6.0 ordering.
      const accessoryByRoutingUid = new Map<string, PlatformAccessory>();
      const deviceByRoutingUid = new Map<string, V2Device>();
      const newAccessories: Array<{ accessory: PlatformAccessory; row: ConfiguredEffectiveRow }> = [];
      // Structural replacements are STAGED (review R6-1): the candidate
      // accessory is built and its wrapper constructed FIRST; only when
      // that succeeds is the old accessory unregistered, the notice
      // written, and the candidate registered. Unregistering eagerly
      // meant a throwing replacement wrapper cost the user the
      // accessory, its room placement, and its automations — plus a
      // misleading structural-change notice.
      interface StagedReplacement {
        old: PlatformAccessory;
        candidate: PlatformAccessory;
        row: ConfiguredEffectiveRow;
        cachedSignature: string;
        displayName: string;
      }
      const stagedReplacements: StagedReplacement[] = [];
      for (const { row, device, routingUid } of reconciled) {
        const uuid = this.api.hap.uuid.generate(device.uniqueId);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        // The v2 context retains the legacy `type` (downgrade cache
        // recognition) ALONGSIDE the row identity fields: `kind`,
        // `measurement`, and the frozen `structuralSignature` (review
        // P1-2), so subsequent boots compare signatures instead of
        // re-deriving from the HAP graph.
        const v2Context = {
          ...device,
          kind: row.kind,
          measurement: row.measurement,
          structuralSignature: row.structuralSignature,
        };
        let accessory: PlatformAccessory;
        if (existingAccessory) {
          const cachedSignature = this.cachedSignatureFor(existingAccessory, row);
          if (cachedSignature !== undefined && cachedSignature !== row.structuralSignature) {
            // Structural change (§9): the cached HAP graph no longer
            // matches the row's frozen signature (e.g. the user set
            // `batteryField: null`, detaching the Battery sub-service).
            // Mutating the graph in place leaves HomeKit clients with a
            // stale accessory shape — stage a replacement; the swap
            // happens after wrapper construction proves out (R6-1).
            const candidate = new this.api.platformAccessory(device.displayName, uuid);
            candidate.context.device = v2Context;
            stagedReplacements.push({
              old: existingAccessory,
              candidate,
              row,
              cachedSignature,
              displayName: device.displayName,
            });
            accessory = candidate;
          } else {
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            if (existingAccessory.displayName !== device.displayName) {
              this.log.info(`Renaming accessory: "${existingAccessory.displayName}" -> "${device.displayName}"`);
              existingAccessory.displayName = device.displayName;
            }
            existingAccessory.getService(this.Service.AccessoryInformation)
              ?.updateCharacteristic(this.Characteristic.Name, device.displayName);
            existingAccessory.context.device = v2Context;
            this.api.updatePlatformAccessories([existingAccessory]);
            accessory = existingAccessory;
          }
        } else {
          this.log.info('Adding new accessory:', device.displayName);
          accessory = new this.api.platformAccessory(device.displayName, uuid);
          accessory.context.device = v2Context;
          newAccessories.push({ accessory, row });
        }
        accessoryByRoutingUid.set(routingUid, accessory);
        deviceByRoutingUid.set(routingUid, device);
      }

      // Instantiate row-driven wrappers + build the routing map. A single
      // bad row is isolated inside buildWrapperRouting (logged + dropped).
      const reconciledMap: EffectiveSensorMap = {
        rows: reconciled.map(r => r.row),
        errors: [], warnings: [], notes: [],
      };
      this.v2Routing = buildWrapperRouting(
        this, reconciledMap, (uid) => accessoryByRoutingUid.get(uid),
      );
      // Retain the reconciled map for the shared battery-field reader —
      // every routing entry's row is in it, so runtime resolution always
      // finds the same adjudicated row the wrapper was built from.
      this.v2EffectiveMap = reconciledMap;

      // Seed each freshly-constructed wrapper with its current value so
      // HomeKit has something to display before the first poll/realtime
      // tick. This is the ONLY seed path for extended wrappers — their
      // constructors deliberately don't self-seed (subclass formatter
      // state isn't ready until after super() returns). Battery seeds from
      // context at construction time (batteryOptionsFor), so no
      // setBatteryLow here — matching the v1.6.0 discovery seed.
      for (const entry of this.v2Routing.values()) {
        const routingUid = `${entry.row.stationMac}-${entry.row.dataPoint}`;
        const device = deviceByRoutingUid.get(routingUid);
        if (!device || typeof device.value !== 'number') {
          continue;
        }
        try {
          entry.wrapper.setValue(device.value);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn(`Initial value seed failed for ${device.displayName}: ${message}`);
        }
      }

      // Register the new accessories now that their service graphs
      // exist — but ONLY those whose wrapper actually constructed
      // (review finding 8). buildWrapperRouting isolates a throwing
      // constructor by dropping that row from the routing map; the
      // matching new accessory must be dropped too, or it would be
      // registered with an incomplete HAP graph and no way to ever
      // receive a value. (RESTORED accessories with a failed wrapper
      // stay registered — they're already in HomeKit with a full cached
      // graph; v1.7 behaved the same when createSensorWrapper returned
      // undefined.)
      for (const { accessory, row } of newAccessories) {
        if (!this.v2Routing.has(routingKey(row.stationMac, row.dataPoint))) {
          this.log.warn(
            `Not registering new accessory [${accessory.displayName}]: its wrapper failed to `
            + 'construct (see the [routing] error above), so its HAP graph is incomplete.',
          );
          continue;
        }
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // Complete the STAGED structural replacements (review R6-1). The
      // candidate's wrapper has now either constructed (its routing
      // entry exists) or failed. Success: unregister the old accessory,
      // record the structural-change notice, register the candidate.
      // Failure: the OLD accessory stays registered with its full
      // cached graph (frozen at last-known values — no routing entry),
      // and NO notice is written; a throwing replacement wrapper never
      // costs the user the accessory.
      for (const staged of stagedReplacements) {
        const key = routingKey(staged.row.stationMac, staged.row.dataPoint);
        if (!this.v2Routing.has(key)) {
          this.log.warn(
            `Keeping cached accessory [${staged.old.displayName}]: its structural replacement's `
            + 'wrapper failed to construct (see the [routing] error above). The accessory stays '
            + 'registered with last-known values; no structural change was applied.',
          );
          continue;
        }
        this.log.warn(
          `Structural change for [${staged.displayName}]: `
          + `"${staged.cachedSignature}" -> "${staged.row.structuralSignature}". Re-registering the accessory.`,
        );
        // The destructive swap is BACK-TO-BACK (review R7): no awaited
        // filesystem I/O between unregister and register, so the
        // no-accessory window is as narrow as HAP allows — a process
        // exit mid-notice can no longer strand the user with neither
        // accessory registered.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [staged.old]);
        const idx = this.accessories.indexOf(staged.old);
        if (idx >= 0) {
          this.accessories.splice(idx, 1);
        }
        try {
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [staged.candidate]);
        } catch (error) {
          // Registration failed after the unregister: drop the
          // candidate's routing entry (its wrapper must not receive
          // values for an unregistered accessory) and try to put the
          // old accessory back so the user isn't left with nothing.
          // NO notice is written — a notice must only ever describe a
          // change that actually completed.
          const message = error instanceof Error ? error.message : String(error);
          this.log.error(
            `Failed to register the replacement for [${staged.displayName}]: ${message}. `
            + 'Attempting to restore the previous accessory.',
          );
          this.v2Routing.delete(key);
          // Best-effort candidate cleanup FIRST (review R8): a throwing
          // registerPlatformAccessories is not side-effect-free —
          // Homebridge adds the accessory to cachedPlatformAccessories
          // before bridging it, so the candidate can remain partially
          // cached/bridged under the SAME UUID and silently block the
          // old accessory's re-registration (which would then log a
          // false "Restored" success). Unregistering the candidate
          // clears any partial state; when nothing actually registered
          // it is a harmless no-op, and its own throw is swallowed.
          try {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [staged.candidate]);
          } catch (cleanupError) {
            const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            this.log.debug(`Candidate cleanup after the failed registration reported: ${cleanupMessage}`);
          }
          try {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [staged.old]);
            this.accessories.push(staged.old);
            this.log.warn(`Restored previous accessory [${staged.old.displayName}] after the replacement failed to register.`);
          } catch (restoreError) {
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            this.log.error(
              `Could not restore previous accessory [${staged.old.displayName}]: ${restoreMessage}. `
              + 'Restart Homebridge to re-run reconciliation.',
            );
          }
          continue;
        }
        // Auxiliary persistence strictly AFTER the swap completed: the
        // notice describes a change that actually happened.
        await this.appendStructuralNoticeV2(staged.row, staged.cachedSignature);
      }

      this.startDataSource();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('ERROR:', message);
    }
  }

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
  private applyStationFilterV2(stations: RawStation[]): RawStation[] {
    for (const station of stations) {
      if (!this.loggedDiscoveredStations.has(station.macAddress)) {
        const sensorCount = Object.keys(station.lastData ?? {}).length;
        this.log.info(`Discovered station "${station.info?.name ?? '(unnamed)'}" `
          + `(MAC: ${station.macAddress}) — ${sensorCount} sensor fields reported`);
        this.loggedDiscoveredStations.add(station.macAddress);
      }
    }

    const stationMatchers = toMatcherSet(this.config.stationFilter);
    if (stationMatchers.size === 0) {
      return stations;
    }
    const matched: RawStation[] = [];
    for (const station of stations) {
      const nameKey = normalizeMatchKey(station.info?.name ?? '');
      const macKey = normalizeMatchKey(station.macAddress ?? '');
      const hit = (nameKey.length > 0 && stationMatchers.has(nameKey))
        || (macKey.length > 0 && stationMatchers.has(macKey));
      if (hit) {
        matched.push(station);
      } else if (!this.loggedStationFilterDrops.has(station.macAddress)) {
        this.log.info(`Station "${station.info?.name ?? '(unnamed)'}" (MAC: ${station.macAddress}) `
          + 'filtered out by stationFilter');
        this.loggedStationFilterDrops.add(station.macAddress);
      }
    }
    if (matched.length === 0 && !this.warnedStationFilterEmpty) {
      this.log.warn(`stationFilter is set but matched zero stations in the AWN response. `
        + `Filter values: [${[...stationMatchers].join(', ')}]. No accessories will be exposed by this platform instance.`);
      this.warnedStationFilterEmpty = true;
    } else if (matched.length > 0 && !this.loggedStationFilterSummary) {
      this.log.info(`stationFilter active: [${[...stationMatchers].join(', ')}] — `
        + `${matched.length} of ${stations.length} station(s) passed`);
      this.loggedStationFilterSummary = true;
    }
    return matched;
  }

  /**
   * Fetch the raw AWN station payloads for the v2 path. Same endpoint,
   * throttle handling, and content-type guard as `fetchDevices`, but
   * returns the un-parsed per-station shape (macAddress + info + lastData)
   * so the row-driven router can read every field — including the batt*
   * datapoints `parseDevices` drops. Returns `undefined` on fetch/parse
   * failure (caller retries), or `[]` for an empty/non-array response.
   */
  private async fetchRawStations(): Promise<RawStation[] | undefined> {
    this.log.debug('Fetching sensors from Ambient Weather API');
    try {
      const url = `https://rt.ambientweather.net/v1/devices?applicationKey=${this.config.applicationKey}&apiKey=${this.config.apiKey}`;
      const response = await fetch(url);

      if (response.status === 429) {
        this.log.debug('429 throttle waiting 1000ms to retry');
        await this.sleep(1000);
        return this.fetchRawStations();
      }

      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(`API response from AWN is not JSON.
          This happens ocasionally due to the fragility of the AWN API and is usually resolved by retrying the request in a few minutes.`);
      }

      const data: unknown = await response.json();
      if (!Array.isArray(data)) {
        // Non-array body with a JSON content-type: a malformed snapshot,
        // not an empty inventory. v1.7's parseDevices treated non-array
        // input as zero stations, but v2's reconciler DEREGISTERS from
        // its inventory — so treat it as a failed fetch and retry rather
        // than wiping the cache off a transient API glitch.
        this.log.warn('AWN response is not a station array; treating as a failed snapshot (no reconciliation this attempt).');
        return undefined;
      }
      const stations: RawStation[] = [];
      for (const s of data) {
        // ANY invalid station entry in a non-empty response marks the
        // whole snapshot as failed. Silently skipping the bad entry
        // would let a transiently malformed payload (e.g. `[{}]` during
        // an AWN incident) masquerade as an authoritative inventory —
        // and the reconciler would unregister every cached accessory,
        // destroying HomeKit rooms/automations. v1.7's parseDevices
        // THREW on the same input (Object.entries(undefined)) and
        // preserved the cache via the retry path; match that outcome.
        // A genuinely empty array (`[]`) is still authoritative: AWN is
        // healthy and reports no devices — same as v1.7.
        if (!s || typeof s !== 'object') {
          this.log.warn('AWN response contains a non-object station entry; treating as a failed snapshot (no reconciliation this attempt).');
          return undefined;
        }
        const rec = s as { macAddress?: unknown; info?: unknown; lastData?: unknown };
        if (typeof rec.macAddress !== 'string' || rec.macAddress.length === 0) {
          this.log.warn('AWN response contains a station without a macAddress; treating as a failed snapshot (no reconciliation this attempt).');
          return undefined;
        }
        if (!rec.lastData || typeof rec.lastData !== 'object' || Array.isArray(rec.lastData)) {
          this.log.warn(`AWN response station ${rec.macAddress} has no lastData object; treating as a failed snapshot (no reconciliation this attempt).`);
          return undefined;
        }
        stations.push({
          macAddress: rec.macAddress,
          info: rec.info as RawStation['info'],
          lastData: rec.lastData as Record<string, unknown>,
        });
      }
      return stations;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('ERROR:', message);
      return undefined;
    }
  }

  /**
   * Initialize v2 persistence: clean stale temp files, load the
   * discovery store into a platform-owned DiscoveryTracker (review
   * P1-4 — the live pipeline is the producer of the plugin's discovery
   * registry, a role the retired shadow observer used to fill), and
   * load the ui-state store. Idempotent — the tracker is created once
   * and survives the discover-retry recursion.
   *
   * The persist dir is `storagePath()/plugin-data/ambient-weather/` — we
   * deliberately avoid `persistPath()` because HAP-NodeJS scans that tree
   * and a subdirectory there crashes it with EISDIR (v2.0.0-beta.1).
   * Never called in safe mode (didFinishLaunching routes to
   * safeModeStart first), so safe mode still performs zero persistence
   * reads or writes.
   */
  private v2PersistDir(): string {
    return path.join(this.api.user.storagePath(), 'plugin-data', 'ambient-weather');
  }

  private v2PersistLog(): { info(m: string): void; warn(m: string): void; debug(m: string): void } {
    return {
      info: (m: string) => this.log.info(m),
      warn: (m: string) => this.log.warn(m),
      debug: (m: string) => this.log.debug(m),
    };
  }

  private async initV2Persistence(): Promise<{ uiState: UiStateStore }> {
    const persistDir = this.v2PersistDir();
    const persistLog = this.v2PersistLog();
    if (!this.v2Tracker) {
      await cleanupStaleTempFiles(persistDir, persistLog);
      const initial = await loadDiscoveryStore(path.join(persistDir, DISCOVERY_FILE), persistLog);
      this.v2Tracker = new DiscoveryTracker({
        filePath: path.join(persistDir, DISCOVERY_FILE),
        log: persistLog,
        initial,
      });
    }
    // ui-state.json is UI-SERVER-owned (§8.5): the platform is a
    // read-only consumer here, so a corrupt file is read as empty and
    // left in place — quarantine-rename belongs to the owning writer,
    // never to this process (review #43 round 3).
    const uiState = await loadUiStateStore(
      path.join(persistDir, UI_STATE_FILE), persistLog, undefined, { quarantineCorrupt: false });
    return { uiState };
  }

  /**
   * Feed every post-filter (station, dataPoint) pair into the discovery
   * tracker and kick a throttled flush. Called at discovery and on each
   * v2 poll tick — the same cadence the shadow observer used, so
   * discovery.json keeps accumulating under the live path.
   */
  private observeV2Stations(stations: ReadonlyArray<RawStation>): void {
    if (!this.v2Tracker) {
      return;
    }
    for (const s of stations) {
      for (const dp of Object.keys(s.lastData)) {
        this.v2Tracker.observe(s.macAddress, s.info?.name ?? '', dp);
      }
    }
    // Fire-and-forget; the tracker throttles lastSeen-only writes and
    // logs its own failures.
    this.v2Tracker.flush().catch(() => { /* logged internally */ });
  }

  /**
   * Resolve the structural signature of a CACHED accessory for
   * comparison against its row's frozen signature (review P1-2 / §9).
   *
   * v2-written caches carry the signature verbatim in
   * `context.device.structuralSignature`. v1.7-written caches don't —
   * derive one from the same inputs the signature hashes: inferred
   * kind + measurement, Battery sub-service presence on the actual HAP
   * graph, and the row's wrapper descriptor. Derivation necessarily
   * uses the CURRENT wrapper schemaVersion (the old one is unknowable),
   * so a schemaVersion bump re-registers only v2-written caches —
   * v1.7 caches adopt the current version silently. Returns undefined
   * when nothing can be derived (uninferable cache) — the caller then
   * adopts the row's signature without re-registration.
   */
  private cachedSignatureFor(accessory: PlatformAccessory, row: ConfiguredEffectiveRow): string | undefined {
    const stored = (accessory.context?.device as { structuralSignature?: unknown } | undefined)?.structuralSignature;
    if (typeof stored === 'string' && stored.length > 0) {
      return stored;
    }
    const inference = inferForCachedAccessory(accessory);
    if (inference.status !== 'inferred') {
      return undefined;
    }
    const hasBattery = accessory.getService(this.Service.Battery) !== undefined;
    const derived = computeStructuralSignature(inference.kind, inference.measurement, hasBattery, wrapperById(row.wrapperId));

    // Legacy-normalization exception (review R3-4): v1.7 attached the
    // Battery sub-service only when telemetry happened to report the
    // batt* field on the discovery tick, so a perfectly valid canonical
    // cache can lack `battery:1` through no configuration change of the
    // user's. When a SIGNATURE-LESS cache differs from the row ONLY by
    // that missing battery, adopt the row's signature and let the
    // row-driven wrapper attach the Battery service in place — exactly
    // what v1.7 itself would have done on the next battery-reporting
    // tick. Applies strictly to the derived (v1.7-cache) path and the
    // missing→present direction: stored v2 signatures and battery
    // REMOVAL (`batteryField: null`) still re-register.
    if (!hasBattery
        && derived.replace('|battery:0|', '|battery:1|') === row.structuralSignature) {
      this.log.debug(
        `Adopting signature-less cache for [${accessory.displayName}]: differs only by the `
        + 'telemetry-conditioned Battery sub-service, which the wrapper attaches in place.',
      );
      return row.structuralSignature;
    }
    return derived;
  }

  /**
   * Record a structural-change notice (sensor-map §8.4) so the UI can
   * explain why an accessory was re-registered (and its HomeKit room /
   * automations detached). Best-effort: a persistence failure logs and
   * never blocks reconciliation.
   */
  private async appendStructuralNoticeV2(row: ConfiguredEffectiveRow, oldSignature: string): Promise<void> {
    try {
      const persistLog = this.v2PersistLog();
      const file = path.join(this.v2PersistDir(), NOTICES_FILE);
      const current = await loadNoticeStore(file, persistLog);
      await appendNotice(file, current, row.stationMac, row.dataPoint, oldSignature, row.structuralSignature, persistLog);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Failed to record structural-change notice for ${row.stationMac}|${row.dataPoint}: ${message}`);
    }
  }

  /**
   * Surface effective-map diagnostics. Config-attributable errors (e.g.
   * a custom row's `no-wrapper` for a kind without a concrete wrapper
   * class) log at info so the user learns their sensor was rejected;
   * warnings and attribution-free notes stay at debug.
   */
  private logEffectiveMapDiagnostics(map: EffectiveSensorMap): void {
    for (const e of map.errors) {
      this.log.info(
        `[sensor-map v2] override error (${e.code})${e.dataPoint ? ` for ${e.dataPoint}` : ''}: ${e.message}`,
      );
    }
    for (const w of map.warnings) {
      this.log.debug(`[sensor-map v2] override warning (${w.code}): ${w.message}`);
    }
    for (const n of map.notes) {
      // Config-attributable notes (source 'override' — e.g. the Stage-4
      // battery-ownership pass's duplicate-battery-owner and
      // orphan-battery-field) are user-actionable: surface at info per
      // the design doc. Internal-invariant default-map notes stay at
      // debug.
      if (n.source === 'override') {
        this.log.info(`[sensor-map v2] note (${n.code}): ${n.message}`);
      } else {
        this.log.debug(`[sensor-map v2] note (${n.code}/${n.source}): ${n.message}`);
      }
    }
  }

  /**
   * v2 value distribution — the single boundary BOTH transports
   * converge on: polling delivers raw station payloads here directly,
   * and realtime reconstructs its per-update stream back into the same
   * payload shape (`updatesToStationPayloads`) first.
   *
   * Sensor VALUES go through the Stage-3 routing mechanism
   * (`distributeViaRouting`); the standalone batt* datapoints the
   * router deliberately ignores are read per routing entry through the
   * shared `resolveBatteryField(effectiveMap, mac, dp)` reader — the
   * same ownership-adjudicated authority the wrapper's Battery
   * sub-service was built from — and pushed as HomeKit's `true = low`
   * boolean.
   */
  private distributeViaV2Routing(stations: ReadonlyArray<StationPayload>): void {
    const routing = this.v2Routing;
    if (!routing) {
      return;
    }
    distributeViaRouting(this, routing, stations);

    const lastDataByMac = new Map<string, Record<string, unknown>>();
    for (const s of stations) {
      lastDataByMac.set(s.macAddress.toUpperCase(), s.lastData);
    }
    for (const entry of routing.values()) {
      if (!entry.wrapper.setBatteryLow) {
        continue;
      }
      const row = entry.row;
      const field = resolveBatteryField(this.v2EffectiveMap, row.stationMac, row.dataPoint);
      if (!field) {
        continue;
      }
      const lastData = lastDataByMac.get(row.stationMac.toUpperCase());
      if (!lastData) {
        continue;
      }
      const low = readBatteryLow(lastData, field);
      if (low !== undefined) {
        entry.wrapper.setBatteryLow(low);
      }
    }
  }

  /**
   * Reshape the realtime source's pre-digested `(uniqueId, value)`
   * updates back into raw per-station payloads so the v2 path routes them
   * through the SAME `distributeViaRouting` boundary the poll path uses.
   * The realtime source emits every numeric field — including the batt*
   * fields — as its own update, so the reconstructed `lastData` carries
   * the battery datapoints the shared battery reader consumes.
   */
  private updatesToStationPayloads(
    updates: ReadonlyArray<{ uniqueId: string; value: number }>,
  ): StationPayload[] {
    const byMac = new Map<string, Record<string, unknown>>();
    for (const u of updates) {
      const norm = normalizeUniqueId(u.uniqueId);
      if (norm.length <= 18 || norm[17] !== '-') {
        continue;
      }
      const mac = norm.slice(0, 17);
      const dataPoint = norm.slice(18);
      let lastData = byMac.get(mac);
      if (!lastData) {
        lastData = {};
        byMac.set(mac, lastData);
      }
      lastData[dataPoint] = u.value;
    }
    return [...byMac.entries()].map(([macAddress, lastData]) => ({ macAddress, lastData }));
  }

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
  private safeModeStart(): void {
    this.log.error(
      `SAFE MODE ACTIVE: reconciliation disabled. ${this.accessories.length} cached `
      + `accessor${this.accessories.length === 1 ? 'y stays' : 'ies stay'} available; polling continues `
      + 'to push fresh values. Fix your config and restart Homebridge to resume normal operation.',
    );

    // Bind to existing services + characteristics on each cached
    // accessory. `bindSafeMode` NEVER calls addService or removeService
    // — accessories whose expected primary service is absent get
    // skipped, keeping their cached HAP values intact. That's the
    // key difference from `createSensorWrapper`, which the v1.6.0
    // ctor code path uses and which would mutate the HAP graph via
    // wrapper constructors that assume they can attach services.
    for (const accessory of this.accessories) {
      const uniqueId = accessory.context?.device?.uniqueId;
      if (typeof uniqueId !== 'string' || uniqueId.length === 0) {
        continue;
      }
      const binding = bindSafeMode(this, accessory);
      if (!binding) {
        // Extended-sensor types, unrecognized cached types, or
        // native types whose expected primary service is missing:
        // stay quiet, cached HAP values remain.
        continue;
      }
      // Key by normalized uniqueId (MAC prefix uppercased). Cached
      // uniqueIds preserve whatever MAC casing the AWN API returned
      // at registration time, but `safeModePollAndDistribute`
      // uppercases the response MAC before lookup — so a lower-case
      // cache would never match. Normalizing at both ends fixes it.
      this.safeModeBindings.set(normalizeUniqueId(uniqueId), binding);
      // Seed from cached numeric value so the first-tick reading
      // has something to display until AWN's next payload arrives.
      const value = accessory.context?.device?.value;
      if (typeof value === 'number') {
        try {
          binding.setValue(value);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.debug(`safe-mode seed failed for ${accessory.displayName}: ${message}`);
        }
      }
    }
    const bound = this.safeModeBindings.size;
    const frozen = this.accessories.length - bound;
    this.log.info(`Safe-mode bound ${bound} cached accessor${bound === 1 ? 'y' : 'ies'} for value updates.`);
    if (frozen > 0) {
      this.log.warn(
        `Safe-mode: ${frozen} cached accessor${frozen === 1 ? 'y' : 'ies'} will stay frozen at last-known values `
        + '(extended-sensor types, unrecognized cached types, or missing HAP characteristics — safe mode does not '
        + 'attempt value updates on these to avoid interpreting the unsupported config).',
      );
    }

    // Safe-mode transport is polling only. Realtime would require
    // us to trust the user's apiKey/applicationKey + interpret
    // realtime payload shapes, and complicates the "no config
    // interpretation" contract. Polling reads the same REST endpoint
    // v1.6.0 uses, hands the raw JSON to `safeModePollAndDistribute`,
    // and pushes values by uniqueId — no `parseDevices`, no config
    // filters, no toggle interpretation.
    this.log.info('Safe-mode data source: polling (realtime disabled in safe mode).');
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.safeModePollAndDistribute().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('Safe-mode poll tick failed:', message);
      });
    }, POLL_INTERVAL_MS);
  }

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
  private async safeModePollAndDistribute(): Promise<void> {
    if (!this.config.apiKey || !this.config.applicationKey) {
      this.log.debug('safe-mode: apiKey/applicationKey not set; skipping fetch.');
      return;
    }
    const url = `https://rt.ambientweather.net/v1/devices?applicationKey=${this.config.applicationKey}&apiKey=${this.config.apiKey}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug(`safe-mode fetch failed: ${message}`);
      return;
    }
    if (response.status === 429) {
      // Throttled — just skip this tick; safe mode has no urgency.
      return;
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      this.log.debug('safe-mode fetch: non-JSON response; skipping.');
      return;
    }
    let stations: unknown;
    try {
      stations = await response.json();
    } catch {
      return;
    }
    if (!Array.isArray(stations)) {
      return;
    }
    for (const station of stations) {
      if (!station || typeof station !== 'object') {continue;}
      const s = station as { macAddress?: unknown; lastData?: unknown };
      if (typeof s.macAddress !== 'string') {continue;}
      if (!s.lastData || typeof s.lastData !== 'object') {continue;}
      const mac = s.macAddress.toUpperCase();
      const lastData = s.lastData as Record<string, unknown>;
      // Iterate BOUND sensor uniqueIds only, not every raw field.
      // For each bound (mac, dataPoint) sensor: push its value AND
      // (if the sensor's probe reports battery) push battery-low
      // from the corresponding batt* field on the same payload.
      for (const [uniqueId, binding] of this.safeModeBindings) {
        if (!uniqueId.startsWith(`${mac}-`)) {continue;}
        const dp = uniqueId.slice(mac.length + 1);

        // Sensor value.
        const rawValue = lastData[dp];
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          try {
            binding.setValue(rawValue);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.debug(`safe-mode setValue failed for ${uniqueId}: ${message}`);
          }
        }

        // Battery. Look up the AWN battery field for this sensor's
        // probe via v1.6.0's `batteryFieldForSensor` (safe because
        // it's a static lookup by sensorKey, not a config-driven
        // decision). Read that field off the same payload and push
        // AWN's `0 = low` convention through as a boolean.
        const batteryField = batteryFieldForSensor(dp);
        if (batteryField !== undefined) {
          const battRaw = lastData[batteryField];
          if (typeof battRaw === 'number') {
            binding.setBatteryLow(battRaw === 0);
          }
        }
      }
    }
  }

  /**
   * Construct the right sensor-type wrapper for an accessory based on
   * the cached context.device.type. Returns the wrapper so the platform
   * can index it by uniqueId for the poll-and-distribute loop.
   */
  private createSensorWrapper(accessory: PlatformAccessory): SensorAccessory | undefined {
    switch (accessory.context.device.type) {
      // Native HomeKit services (v1.x baseline)
      case 'Temperature':
        return new TemperatureAccessory(this, accessory);
      case 'Humidity':
        return new HumidityAccessory(this, accessory);
      case 'Solar Radiation':
        return new SolarRadiationAccessory(this, accessory);
      case 'CO2':
        return new Co2Accessory(this, accessory);
      case 'PM2.5':
      case 'PM10':
        return new AirQualityAccessory(this, accessory);

      // Extended sensors (v1.5.0) — MotionSensor + custom characteristics.
      case 'WindSpeed':
        return new WindSpeedAccessory(this, accessory);
      case 'WindGust':
        return new WindGustAccessory(this, accessory);
      case 'WindMaxDailyGust':
        return new WindMaxDailyGustAccessory(this, accessory);
      case 'WindDirection':
        return new WindDirectionAccessory(this, accessory);
      case 'WindDirection10m':
        return new WindDirection10mAccessory(this, accessory);
      case 'RainRate':
        return new RainRateAccessory(this, accessory);
      case 'RainEvent':
        return new RainEventAccessory(this, accessory);
      case 'RainDaily':
        return new RainDailyAccessory(this, accessory);
      case 'RainWeekly':
        return new RainWeeklyAccessory(this, accessory);
      case 'RainMonthly':
        return new RainMonthlyAccessory(this, accessory);
      case 'RainYearly':
        return new RainYearlyAccessory(this, accessory);
      case 'LastRain':
        return new LastRainAccessory(this, accessory);
      case 'PressureRelative':
        return new PressureRelativeAccessory(this, accessory);
      case 'PressureAbsolute':
        return new PressureAbsoluteAccessory(this, accessory);
      case 'UV':
        return new UvAccessory(this, accessory);
      case 'LightningDay':
        return new LightningDayAccessory(this, accessory);
      case 'LightningHour':
        return new LightningHourAccessory(this, accessory);
      case 'LightningDistance':
        return new LightningDistanceAccessory(this, accessory);
      case 'LightningLastStrike':
        return new LightningLastStrikeAccessory(this, accessory);

      default:
        return undefined;
    }
  }

  /**
   * Start the platform-level poll timer. One timer covers every
   * accessory: on each tick we fetch the full devices payload from AWN
   * once and fan the values out to wrappers via setValue(). Previously
   * every wrapper owned its own setInterval, which meant N accessories
   * triggered N parallel fetches per cycle — racing AWN's 1 req/s
   * rate limit and getting "saved" only by the disk cache.
   */
  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.pollAndDistribute().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('Poll tick failed:', message);
      });
    }, POLL_INTERVAL_MS);
  }

  /**
   * Open a long-lived websocket subscription to AWN's realtime endpoint.
   * Sensor updates arrive as they happen (typically ~30s cadence
   * indoors), feed through the same `distribute` fanout the poll path
   * uses, and end up calling setValue() on the matching wrapper.
   */
  private startRealtime(): void {
    if (this.realtimeSource) {
      return;
    }
    if (!this.config.apiKey || !this.config.applicationKey) {
      this.log.error('Realtime data source requested but apiKey/applicationKey is not configured; falling back to polling.');
      this.startPolling();
      return;
    }
    this.realtimeSource = new RealtimeSource({
      apiKey: this.config.apiKey,
      applicationKey: this.config.applicationKey,
      log: this.log,
      onUpdates: (updates) => this.distribute(updates),
      // Shared battery-field reader (lazy: reads the member at each
      // resolution, so a reconcile that rebuilds the effective map is
      // picked up without reconstructing the socket). Flag off →
      // undefined map → the reader IS the legacy static lookup.
      resolveBatteryField: (mac, dp) => resolveBatteryField(this.v2EffectiveMap, mac, dp),
    });
    this.realtimeSource.start();
  }

  /**
   * Fetch fresh values once and push each one into the matching wrapper.
   * Wrappers not present in the response are simply left untouched on
   * this tick — HomeKit will keep showing the last known value.
   */
  private async pollAndDistribute(): Promise<void> {
    // v2 path: fetch raw stations and route them straight through
    // distributeViaRouting (which needs the un-parsed lastData — including
    // the batt* fields parseDevices drops — for the battery reads).
    if (this.v2Routing) {
      const stations = await this.fetchRawStations();
      if (stations) {
        // Filter every tick, like v1's parseDevices does: announces
        // stations that appear mid-session and keeps a filtered-out
        // station's payload from ever reaching the router (its rows
        // aren't in the routing map anyway — defense in depth).
        const filtered = this.applyStationFilterV2(stations);
        // Keep the discovery registry accumulating (review P1-4): a
        // field AWN starts reporting mid-session lands in
        // discovery.json so the UI can surface it.
        this.observeV2Stations(filtered);
        this.distributeViaV2Routing(
          filtered.map(s => ({ macAddress: s.macAddress, lastData: s.lastData })),
        );
      }
      return;
    }
    const Devices = await this.fetchDevices();
    if (!Devices) {
      return;
    }
    this.distribute(Devices);
  }

  /**
   * Common fanout used by both the polling and realtime data sources.
   * Looks up each update's wrapper by uniqueId; values for sensors we
   * never registered (unknown sensor types, excluded by config, etc.)
   * are silently ignored.
   */
  private distribute(updates: Array<{ uniqueId: string; value: number; batteryLow?: boolean }>): void {
    // v2 path (realtime): reshape the pre-digested updates into raw
    // station payloads and route them through the SAME distributeViaRouting
    // boundary the poll path uses.
    if (this.v2Routing) {
      this.distributeViaV2Routing(this.updatesToStationPayloads(updates));
      return;
    }
    for (const update of updates) {
      const wrapper = this.wrappers.get(update.uniqueId);
      if (wrapper) {
        wrapper.setValue(update.value);
        if (update.batteryLow !== undefined && wrapper.setBatteryLow) {
          wrapper.setBatteryLow(update.batteryLow);
        }
      }
    }
  }
}

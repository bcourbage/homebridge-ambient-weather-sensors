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
import { friendlySensorName, sensorKeyByFriendlyName } from './sensorNames.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SolarRadiationAccessory } from './solarRadiationAccessory.js';
import { TemperatureAccessory } from './temperatureAccessory.js';
import { DEVICE } from './types.js';

/**
 * Sanitize a string for use in a HAP `Name` characteristic, per Apple's
 * documented rule (alphanumeric, space, and apostrophe only; must start
 * and end with an alphanumeric). HAP 2.x emits warnings for any value
 * that doesn't comply.
 */
function hapClean(input: string): string {
  return input
    .replace(/[^A-Za-z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .trim();
}

// HAP 2.x enforces a 64-character limit on the `Name` characteristic.
const HAP_NAME_MAX = 64;

/**
 * Normalize a string the user might have typed in their config for
 * matching against sensor identifiers. Trims whitespace and lowercases.
 * Empty / non-string values normalize to the empty string, which the
 * caller is expected to filter out.
 */
function normalizeMatchKey(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Build a Set of normalized matchers from a config-supplied array. Used
 * for both `excludeSensors` and `includeOnly`; the same matching rules
 * apply to both (case-insensitive, whitespace-trimmed, non-string and
 * blank entries dropped).
 */
function toMatcherSet(raw: unknown): Set<string> {
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

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {

    this.log.debug('Finished initializing platform:', this.config.platform);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
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
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.push(accessory);
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
    const sensorLabel = friendlySensorName(sensorKey);

    if (!isMultiStation) {
      return hapClean(sensorLabel);
    }

    const stationName = hapClean(obj.info?.name ?? '');
    const macFallback = obj.macAddress.replaceAll(':', '');
    const baseName = stationName || macFallback;
    const composed = hapClean(`${baseName} ${sensorLabel}`);

    return composed.length <= HAP_NAME_MAX ? composed : composed.slice(0, HAP_NAME_MAX).trim();
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
          // batteryFields.ts).
          const batteryField = batteryFieldForSensor(sensorKey);
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
        });
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
      // updated. Two data-source options:
      //
      //   "polling"  (default) — one platform-level setInterval, REST
      //                          fetch every 2 minutes.
      //   "realtime"           — opt-in; subscribe to AWN's socket.io
      //                          endpoint and push updates as they
      //                          arrive (~30s cadence indoors).
      //
      // CONSTRAINT (added in 1.6.0): embed display mode is incompatible
      // with the realtime data source. The combination produces a flood
      // of HAP Name-characteristic update notifications to every paired
      // iOS controller, which has been observed to drain phone battery
      // ~5×-7× faster than normal idle (solmssen, 2026-06-18, ~15
      // extended sensors active). Polling caps the notification volume
      // to roughly one batch per 2 minutes, which keeps the drain
      // negligible while still delivering live-ish tile values. If the
      // user has selected both, we coerce to polling and warn — the
      // user's intent ("live value in tile") is preserved at a slightly
      // slower cadence, which is the right trade-off for an invisible
      // side effect like battery drain.
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
    });
    this.realtimeSource.start();
  }

  /**
   * Fetch fresh values once and push each one into the matching wrapper.
   * Wrappers not present in the response are simply left untouched on
   * this tick — HomeKit will keep showing the last known value.
   */
  private async pollAndDistribute(): Promise<void> {
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

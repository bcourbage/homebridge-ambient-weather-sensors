import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { AirQualityAccessory } from './airQualityAccessory.js';
import { Co2Accessory } from './co2Accessory.js';
import { HumidityAccessory } from './humidityAccessory.js';
import { RealtimeSource } from './realtimeSource.js';
import { friendlySensorName } from './sensorNames.js';
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
    if (sensor.includes('temp') && this.config.temperatureSensors) {
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
      // } else if (sensor.includes('baromabs') && this.config.barometricSensors) {
      //   return 'Barometric Pressure';
      // } else if (sensor.includes('windspeed') && this.config.windSensors) {
      //   return 'Wind Speed';
      // } else if (sensor === 'winddir' && this.config.windSensors) {
      //   return 'Wind Direction';
    } else {
      return 'NOT_SUPPORTED';
    }
  }

  /**
   * Compose a HAP-clean accessory displayName from station + sensor
   * metadata. Form: `${station_name} ${sensor_label}` when the user has
   * set a station name on ambientweather.net (e.g.
   * "Fairhills WS 2000 Indoor Temperature"), otherwise
   * `${mac_no_colons} ${sensor_label}` as a last-resort disambiguator.
   *
   * City/state are intentionally NOT included even though the API
   * supplies them: HomeKit's room/home hierarchy already gives users a
   * place to express location, and dragging the geocoded address into
   * every accessory name produces redundant noise on the device tile.
   *
   * Truncates from the right to HAP 2.x's 64-character `Name` limit.
   */
  composeDisplayName(obj: { macAddress: string; info?: { name?: string } }, sensorKey: string): string {
    const stationName = hapClean(obj.info?.name ?? '');
    const macFallback = obj.macAddress.replaceAll(':', '');
    const sensorLabel = friendlySensorName(sensorKey);

    const baseName = stationName || macFallback;
    const composed = hapClean(`${baseName} ${sensorLabel}`);

    return composed.length <= HAP_NAME_MAX ? composed : composed.slice(0, HAP_NAME_MAX).trim();
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

    if (Array.isArray(json)) {
      json.forEach( (obj) => {
        Object.entries(obj.lastData).forEach( (device) => {
          const sensorKey = device[0];
          const type = this.determineSensorType(sensorKey);
          if (type === 'NOT_SUPPORTED') {
            return;
          }

          const uniqueId = `${obj.macAddress}-${sensorKey}`;
          const displayName = this.composeDisplayName(obj, sensorKey);

          // Candidates a user might use to identify this sensor in
          // their config. Ordered from most-specific to least so the
          // log messages can pick whichever they hit first if we
          // wanted that — currently we just check any-match.
          const matchCandidates: string[] = [
            uniqueId,                          // 84:F3:EB:66:D2:67-tempinf
            displayName,                       // Fairhills WS 2000 Indoor Temperature
            sensorKey,                         // tempinf
            friendlySensorName(sensorKey),     // Indoor Temperature
            obj.macAddress,                    // 84:F3:EB:66:D2:67
            obj.info?.name ?? '',              // Fairhills WS-2000 (as user typed in AWN, before hapClean)
          ].map(normalizeMatchKey).filter((s) => s.length > 0);

          if (includeMatchers.size > 0 && !matchCandidates.some((c) => includeMatchers.has(c))) {
            this.log.debug(`Excluding ${uniqueId} (not in includeOnly allowlist)`);
            return;
          }
          if (excludeMatchers.size > 0 && matchCandidates.some((c) => excludeMatchers.has(c))) {
            this.log.debug(`Excluding ${uniqueId} (matched excludeSensors)`);
            return;
          }

          Devices.push({
            macAddress: obj.macAddress,
            uniqueId,
            displayName,
            type,
            value: device[1] as number,
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
      const dataSource = this.config.dataSource === 'realtime' ? 'realtime' : 'polling';
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
  private distribute(updates: Array<{ uniqueId: string; value: number }>): void {
    for (const update of updates) {
      const wrapper = this.wrappers.get(update.uniqueId);
      if (wrapper) {
        wrapper.setValue(update.value);
      }
    }
  }
}

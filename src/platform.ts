import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { HumidityAccessory } from './humidityAccessory.js';
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
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.push(accessory);
  }

  determineSensorType(sensor: string) {
    if (sensor.includes('temp') && this.config.temperatureSensors) {
      return 'Temperature';
    } else if (sensor.includes('humid') && this.config.humiditySensors) {
      return 'Humidity';
    } else if (sensor.includes('solar') && this.config.solarRadiationSensors) {
      return 'Solar Radiation';
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
   * Extract a city + state label from AWN's `info.coords.address_components`
   * block (Google-style geocoding output). Mirrors the locality + state
   * pair that ambientweather.net itself uses for station headers (e.g.
   * "San Rafael, CA"). Returns an empty string if either piece is
   * missing.
   *
   * Falls back to `info.location` (the user-set free-text label) only
   * when the coords block isn't present, since `info.location` often
   * carries something redundant with `info.name` (a building label).
   */
  extractCityState(info?: { location?: string; coords?: { address_components?: Array<{ short_name?: string; long_name?: string; types?: string[] }> } }): string {
    const components = info?.coords?.address_components;
    if (Array.isArray(components)) {
      const findByType = (type: string) =>
        components.find((c) => Array.isArray(c?.types) && c.types.includes(type));
      const city = findByType('locality')?.long_name ?? '';
      const state = findByType('administrative_area_level_1')?.short_name ?? '';
      const cityState = [city, state].filter(Boolean).join(' ');
      if (cityState) {
        return cityState;
      }
    }
    return info?.location ?? '';
  }

  /**
   * Compose a HAP-clean accessory displayName from station + sensor
   * metadata. Mirrors the way ambientweather.net renders station
   * headers (e.g. "Fairhills WS-2000, San Rafael, CA"), but with
   * commas/punctuation stripped to satisfy HAP 2.x's Name validator and
   * with a friendly sensor label appended.
   *
   * Falls back to the MAC address when `info.name` is missing, and drops
   * the location portion if the composed name would exceed HAP's 64-char
   * limit on the `Name` characteristic.
   */
  composeDisplayName(obj: { macAddress: string; info?: { name?: string; location?: string; coords?: { address_components?: Array<{ short_name?: string; long_name?: string; types?: string[] }> } } }, sensorKey: string): string {
    const stationName = hapClean(obj.info?.name ?? '');
    const stationLocation = hapClean(this.extractCityState(obj.info));
    const macFallback = obj.macAddress.replaceAll(':', '');
    const sensorLabel = friendlySensorName(sensorKey);

    const baseName = stationName || macFallback;
    const composed = hapClean(stationLocation ? `${baseName} ${stationLocation} ${sensorLabel}` : `${baseName} ${sensorLabel}`);

    if (composed.length <= HAP_NAME_MAX) {
      return composed;
    }

    // Composed name too long — drop the location portion, keep
    // station-name + sensor-label so accessories remain identifiable.
    const trimmed = hapClean(`${baseName} ${sensorLabel}`);
    return trimmed.length <= HAP_NAME_MAX ? trimmed : trimmed.slice(0, HAP_NAME_MAX).trim();
  }

  parseDevices(json) {
    const Devices:DEVICE[] = [];
    const excludeList: string[] = Array.isArray(this.config.excludeSensors) ? this.config.excludeSensors : [];
    const exclude = new Set(excludeList);

    if (Array.isArray(json)) {
      json.forEach( (obj) => {
        Object.entries(obj.lastData).forEach( (device) => {
          const sensorKey = device[0];
          const type = this.determineSensorType(sensorKey);
          if (type === 'NOT_SUPPORTED') {
            return;
          }
          const uniqueId = `${obj.macAddress}-${sensorKey}`;
          if (exclude.has(uniqueId)) {
            this.log.debug(`Excluding sensor ${uniqueId} (matched excludeSensors config)`);
            return;
          }
          Devices.push({
            macAddress: obj.macAddress,
            uniqueId,
            displayName: this.composeDisplayName(obj, sensorKey),
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

      // Now that all wrappers are registered, take over the polling that
      // each wrapper used to do for itself. One platform-level timer fans
      // out into wrapper.setValue() calls per poll tick.
      this.startPolling();
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
   * Fetch fresh values once and push each one into the matching wrapper.
   * Wrappers not present in the response are simply left untouched on
   * this tick — HomeKit will keep showing the last known value.
   */
  private async pollAndDistribute(): Promise<void> {
    const Devices = await this.fetchDevices();
    if (!Devices) {
      return;
    }
    for (const device of Devices) {
      const wrapper = this.wrappers.get(device.uniqueId);
      if (wrapper) {
        wrapper.setValue(device.value);
      }
    }
  }
}

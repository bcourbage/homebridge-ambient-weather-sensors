/**
 * Safe-mode value binding — no wrapper construction, no HAP graph changes.
 *
 * Sensor-map.md §17.2 says polling / realtime updates continue to
 * push values to identifiable cached wrappers in safe mode, but the
 * plugin MUST NOT reconcile the HAP graph. The v1.6.0 wrapper
 * constructors don't fit that constraint — `setupBatteryService()`
 * removes any existing BatteryService if `context.device.batteryLow`
 * is undefined, and every wrapper's ctor calls `addService()` if the
 * primary service isn't present. Either behavior is a structural
 * change safe mode forbids.
 *
 * The alternative is this module: given a cached PlatformAccessory,
 * `bindSafeMode(accessory)` looks at the services THAT ALREADY EXIST
 * on the accessory, resolves the appropriate HAP characteristic
 * bindings, and returns a small object that pushes values via
 * `updateCharacteristic` — never `addService` / `removeService`.
 * Accessories whose expected primary service is absent get skipped
 * (they keep their cached HAP values; polling simply doesn't touch
 * them).
 *
 * The mapping table matches what `platform.createSensorWrapper()`
 * does for each `context.device.type`, but without the mutation.
 * Only the FIVE native HomeKit sensor types are supported today
 * (Temperature, Humidity, Solar Radiation, CO2, PM2.5 / PM10);
 * extended-sensor accessories (Wind, Rain, Pressure, UV, Lightning)
 * skip value updates in safe mode and stay at their cached values.
 * That's an intentional Group 4 scope reduction: extended sensors
 * store their live values in custom characteristics whose semantics
 * (thresholds, intensity buckets, embed-mode name updates) depend
 * on config we can't safely interpret in safe mode. Native sensors
 * have a fixed HAP unit and a single characteristic, so binding is
 * unambiguous.
 */

import type { PlatformAccessory, Service, WithUUID, Characteristic } from 'homebridge';

/**
 * Minimal platform surface `bindSafeMode` needs — matches the real
 * `AmbientWeatherSensorsPlatform` shape. Homebridge's `Service` and
 * `Characteristic` are both extendable classes AND namespaces with
 * static named members (`Service.TemperatureSensor`,
 * `Characteristic.CurrentTemperature`, etc.); the interface is
 * intentionally loose so both the real platform and the test mocks
 * fit without wrestling with tight index signatures.
 */
 
export type SafeModeBindingPlatform = {
  Service: any;
  Characteristic: any;
  log: { debug(msg: string): void };
};

export interface SafeModeBinding {
  /** Push a raw AWN value into the accessory's HAP characteristic. */
  setValue(rawValue: number): void;
  /**
   * Push a battery-low reading, iff the accessory already has an
   * attached BatteryService. When absent, this is a no-op — safe
   * mode never creates a BatteryService.
   */
  setBatteryLow(low: boolean): void;
}

/**
 * Fahrenheit → Celsius, matching TemperatureAccessory. HAP's
 * `CurrentTemperature` is in Celsius; AWN reports Fahrenheit.
 */
function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/**
 * W/m² → lux, matching SolarRadiationAccessory. The 126 multiplier
 * is the same constant the wrapper class uses.
 */
function wm2ToLux(wm2: number): number {
  return Math.round(wm2 * 126);
}

/**
 * Air-quality index buckets, matching AirQualityAccessory (WHO
 * short-term guidelines). Values in μg/m³.
 */
function aqIndex(density: number, kind: 'PM2.5' | 'PM10'): number {
  // 1..5 (Excellent..Poor); matches the wrapper.
  if (kind === 'PM2.5') {
    if (density <= 12) {return 1;}
    if (density <= 35) {return 2;}
    if (density <= 55) {return 3;}
    if (density <= 150) {return 4;}
    return 5;
  }
  // PM10
  if (density <= 20) {return 1;}
  if (density <= 50) {return 2;}
  if (density <= 100) {return 3;}
  if (density <= 200) {return 4;}
  return 5;
}

/**
 * Optionally attach a battery-low updater IF the accessory already
 * has a BatteryService. Never creates one — that would be a
 * structural change safe mode forbids.
 */
function bindBattery(
  platform: SafeModeBindingPlatform,
  accessory: PlatformAccessory,
): (low: boolean) => void {
  const svcCtor = platform.Service.Battery as unknown as WithUUID<typeof Service>;
  const existing = accessory.getService(svcCtor);
  if (!existing) {
    return () => { /* no-op — no BatteryService on this accessory */ };
  }
  const charCtor = platform.Characteristic.StatusLowBattery as unknown as WithUUID<new () => Characteristic>;
  return (low: boolean) => {
    existing.updateCharacteristic(charCtor, low ? 1 : 0);
  };
}

/**
 * Look up an existing service on the accessory (never adds one).
 * Returns undefined if the expected primary service isn't present.
 */
function requireExistingService(
  accessory: PlatformAccessory,
  ctor: { UUID: string },
): Service | undefined {
  return accessory.getService(ctor as unknown as WithUUID<typeof Service>);
}

/**
 * Build a safe-mode binding for a cached accessory. Returns
 * undefined when the accessory's cached `context.device.type` isn't
 * a supported native type OR the expected primary service isn't
 * already attached. The caller (`platform.safeModeStart`) skips
 * unmatched accessories, leaving them at their cached HAP values.
 */
export function bindSafeMode(
  platform: SafeModeBindingPlatform,
  accessory: PlatformAccessory,
): SafeModeBinding | undefined {
  const type = accessory.context?.device?.type as string | undefined;
  if (typeof type !== 'string') {
    return undefined;
  }

  const P = platform.Characteristic;
  const S = platform.Service;

  switch (type) {
    case 'Temperature': {
      const svc = requireExistingService(accessory, S.TemperatureSensor);
      if (!svc) {return undefined;}
      const setBatteryLow = bindBattery(platform, accessory);
      return {
        setValue: (raw) => {
          const celsius = fToC(raw);
          svc.updateCharacteristic(P.CurrentTemperature as never, celsius);
          platform.log.debug(`safe-mode: CurrentTemperature ${raw}°F → ${celsius.toFixed(2)}°C`);
        },
        setBatteryLow,
      };
    }
    case 'Humidity': {
      const svc = requireExistingService(accessory, S.HumiditySensor);
      if (!svc) {return undefined;}
      const setBatteryLow = bindBattery(platform, accessory);
      return {
        setValue: (raw) => {
          svc.updateCharacteristic(P.CurrentRelativeHumidity as never, raw);
          platform.log.debug(`safe-mode: CurrentRelativeHumidity ${raw}%`);
        },
        setBatteryLow,
      };
    }
    case 'Solar Radiation': {
      const svc = requireExistingService(accessory, S.LightSensor);
      if (!svc) {return undefined;}
      const setBatteryLow = bindBattery(platform, accessory);
      return {
        setValue: (raw) => {
          const lux = Math.max(0.0001, wm2ToLux(raw));  // HAP LightSensor min is 0.0001
          svc.updateCharacteristic(P.CurrentAmbientLightLevel as never, lux);
          platform.log.debug(`safe-mode: CurrentAmbientLightLevel ${raw} W/m² → ${lux} lx`);
        },
        setBatteryLow,
      };
    }
    case 'CO2': {
      const svc = requireExistingService(accessory, S.CarbonDioxideSensor);
      if (!svc) {return undefined;}
      const setBatteryLow = bindBattery(platform, accessory);
      const CO2_DETECTED_PPM = 1000;   // matches Co2Accessory
      return {
        setValue: (raw) => {
          svc.updateCharacteristic(P.CarbonDioxideLevel as never, raw);
          svc.updateCharacteristic(
            P.CarbonDioxideDetected as never,
            raw >= CO2_DETECTED_PPM ? 1 : 0,
          );
          platform.log.debug(`safe-mode: CarbonDioxideLevel ${raw} ppm`);
        },
        setBatteryLow,
      };
    }
    case 'PM2.5':
    case 'PM10': {
      const svc = requireExistingService(accessory, S.AirQualitySensor);
      if (!svc) {return undefined;}
      const setBatteryLow = bindBattery(platform, accessory);
      const kind = type;
      return {
        setValue: (raw) => {
          if (kind === 'PM10') {
            svc.updateCharacteristic(P.PM10Density as never, raw);
          } else {
            svc.updateCharacteristic(P.PM2_5Density as never, raw);
          }
          svc.updateCharacteristic(P.AirQuality as never, aqIndex(raw, kind));
          platform.log.debug(`safe-mode: ${kind}Density ${raw} µg/m³`);
        },
        setBatteryLow,
      };
    }
    default:
      // Extended-sensor types (Wind Speed, Rain Rate, Pressure, UV,
      // Lightning*, etc.) fall through: their live-value semantics
      // depend on config-driven thresholds and display modes we can't
      // interpret in safe mode. Cached HAP values stay in place.
      return undefined;
  }
}

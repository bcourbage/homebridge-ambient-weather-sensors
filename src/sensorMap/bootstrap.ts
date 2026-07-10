/**
 * Bootstrap rule for cached accessories — see docs/future/sensor-map.md §11.2.
 *
 * Existing v1.5.0 / v1.6.0 cached accessories have no `kind`,
 * `measurement`, or `structuralSignature` fields in their
 * `context.device`. On the first v2.0 startup, the plugin infers all
 * three from what IS present:
 *   1. `context.device.type` — the legacy string (e.g. "Temperature",
 *      "WindSpeed", "LightningDistance")
 *   2. `context.device.uniqueId` — `${macAddress}-${sensorKey}`, which
 *      lets us look up the default map by dataPoint
 *   3. The HAP service graph itself — a TemperatureSensor service is
 *      unambiguous even without any context metadata
 *
 * Kind inference falls back through three levels; measurement is
 * inferred separately (never guessed from kind alone, because
 * `kind: motion` covers many measurements).
 *
 * If measurement can't be resolved, the function returns
 * `'preserve-cached'` — the caller keeps the accessory in HomeKit
 * with last-known values but does NOT write kind/measurement/signature
 * to context. Next boot has another chance (e.g., if AWN starts
 * reporting the field again the default map will resolve it).
 */

import { defaultRowFor } from './defaultMap.js';
import { LEGACY_TYPE_TO_KIND, LEGACY_TYPE_TO_MEASUREMENT } from './legacyTables.js';
import type { Measurement, SensorKind } from './types.js';

/**
 * Well-known HAP service UUIDs for sensor types the plugin registers.
 * These are the values HAP-NodeJS assigns to `Service.<Family>.UUID`.
 * They're stable across HAP-NodeJS versions.
 */
export const HAP_SERVICE_UUIDS = {
  TEMPERATURE_SENSOR:      '0000008A-0000-1000-8000-0026BB765291',
  HUMIDITY_SENSOR:         '00000082-0000-1000-8000-0026BB765291',
  LIGHT_SENSOR:            '00000084-0000-1000-8000-0026BB765291',
  CARBON_DIOXIDE_SENSOR:   '00000097-0000-1000-8000-0026BB765291',
  CARBON_MONOXIDE_SENSOR:  '0000007F-0000-1000-8000-0026BB765291',
  AIR_QUALITY_SENSOR:      '0000008D-0000-1000-8000-0026BB765291',
  MOTION_SENSOR:           '00000085-0000-1000-8000-0026BB765291',
  LEAK_SENSOR:             '00000083-0000-1000-8000-0026BB765291',
  CONTACT_SENSOR:          '00000080-0000-1000-8000-0026BB765291',
  OCCUPANCY_SENSOR:        '00000086-0000-1000-8000-0026BB765291',
} as const;

export const HAP_CHARACTERISTIC_UUIDS = {
  PM2_5_DENSITY: '000000C6-0000-1000-8000-0026BB765291',
  PM10_DENSITY:  '000000C7-0000-1000-8000-0026BB765291',
} as const;

/**
 * Duck-typed accessory shape. Real Homebridge PlatformAccessory
 * conforms; test doubles can be plain objects.
 */
export interface CachedAccessoryShape {
  /** Free-form context bag; we read `device.kind`, `.type`, `.uniqueId`. */
  context?: {
    device?: {
      uniqueId?: string;
      kind?: SensorKind;
      type?: string;
    };
  };
  services?: ReadonlyArray<ServiceShape>;
}

export interface ServiceShape {
  UUID: string;
  /** Case-insensitive UUID compare accepted; matches HAP-NodeJS semantics. */
  testCharacteristic?: (uuid: string) => boolean;
}

export type BootstrapResult =
  | { status: 'inferred'; kind: Exclude<SensorKind, 'unrecognized'>; measurement: Measurement }
  | { status: 'preserve-cached' };

/**
 * Infer kind + measurement for a cached accessory. Never mutates the
 * accessory. Caller is responsible for writing the result back to
 * context (or not, on 'preserve-cached').
 */
export function inferForCachedAccessory(accessory: CachedAccessoryShape): BootstrapResult {
  const device = accessory.context?.device;
  const uniqueId = device?.uniqueId ?? '';
  const legacyType = device?.type;
  const dataPoint = dataPointFromUniqueId(uniqueId);

  // ---- Kind: three-level fallback.
  const kind = inferKind(device?.kind, legacyType, accessory.services);
  if (!kind) {
    return { status: 'preserve-cached' };
  }

  // ---- Measurement: three-level fallback avoiding kind-alone guessing.
  const defaultRow = dataPoint ? defaultRowFor(dataPoint) : undefined;
  const measurement: Measurement | undefined =
    defaultRow?.measurement
    ?? (legacyType ? LEGACY_TYPE_TO_MEASUREMENT[legacyType] : undefined);

  if (!measurement) {
    return { status: 'preserve-cached' };
  }

  return { status: 'inferred', kind, measurement };
}

/**
 * `${macAddress}-${sensorKey}` → sensorKey. macAddress format is
 * `AA:BB:CC:DD:EE:FF` (contains colons but no hyphens), so the first
 * hyphen is the split point. Everything after is the sensorKey (which
 * may itself contain underscores).
 */
export function dataPointFromUniqueId(uniqueId: string): string | undefined {
  if (!uniqueId) {
    return undefined;
  }
  const dash = uniqueId.indexOf('-');
  if (dash < 0) {
    return undefined;
  }
  const tail = uniqueId.slice(dash + 1);
  return tail || undefined;
}

function inferKind(
  contextKind: SensorKind | undefined,
  legacyType: string | undefined,
  services: ReadonlyArray<ServiceShape> | undefined,
): Exclude<SensorKind, 'unrecognized'> | undefined {
  // Level 1: explicit v2 context field.
  if (contextKind && contextKind !== 'unrecognized') {
    return contextKind;
  }
  // Level 2: legacy type string.
  if (legacyType) {
    const k = LEGACY_TYPE_TO_KIND[legacyType];
    if (k) {
      return k;
    }
  }
  // Level 3: walk HAP services.
  return inferKindFromServices(services);
}

/**
 * Return the first recognized sensor kind on the accessory. AirQuality
 * disambiguates by inspecting for PM2.5 vs. PM10 density characteristics
 * (§11.2 says: PM2.5 density present → pm25; else PM10 density → pm10;
 * else undefined and the caller falls back to sensorKey pattern
 * matching, which for our default map already routed through the
 * default-map lookup above).
 */
function inferKindFromServices(
  services: ReadonlyArray<ServiceShape> | undefined,
): Exclude<SensorKind, 'unrecognized'> | undefined {
  if (!services || services.length === 0) {
    return undefined;
  }
  for (const svc of services) {
    const kind = kindForServiceUuid(svc);
    if (kind) {
      return kind;
    }
  }
  return undefined;
}

function kindForServiceUuid(service: ServiceShape): Exclude<SensorKind, 'unrecognized'> | undefined {
  const uuid = normUuid(service.UUID);
  switch (uuid) {
    case normUuid(HAP_SERVICE_UUIDS.TEMPERATURE_SENSOR):     return 'temperature';
    case normUuid(HAP_SERVICE_UUIDS.HUMIDITY_SENSOR):        return 'humidity';
    case normUuid(HAP_SERVICE_UUIDS.LIGHT_SENSOR):           return 'light';
    case normUuid(HAP_SERVICE_UUIDS.CARBON_DIOXIDE_SENSOR):  return 'co2';
    case normUuid(HAP_SERVICE_UUIDS.CARBON_MONOXIDE_SENSOR): return 'co';
    case normUuid(HAP_SERVICE_UUIDS.MOTION_SENSOR):          return 'motion';
    case normUuid(HAP_SERVICE_UUIDS.LEAK_SENSOR):            return 'leak';
    case normUuid(HAP_SERVICE_UUIDS.CONTACT_SENSOR):         return 'contact';
    case normUuid(HAP_SERVICE_UUIDS.OCCUPANCY_SENSOR):       return 'occupancy';
    case normUuid(HAP_SERVICE_UUIDS.AIR_QUALITY_SENSOR): {
      // Disambiguate via density characteristic. Prefer PM2.5 when both
      // are present (unlikely on our accessories — each is either/or).
      if (service.testCharacteristic?.(HAP_CHARACTERISTIC_UUIDS.PM2_5_DENSITY)) {
        return 'air-quality-pm25';
      }
      if (service.testCharacteristic?.(HAP_CHARACTERISTIC_UUIDS.PM10_DENSITY)) {
        return 'air-quality-pm10';
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function normUuid(u: string): string {
  return u.toLowerCase();
}

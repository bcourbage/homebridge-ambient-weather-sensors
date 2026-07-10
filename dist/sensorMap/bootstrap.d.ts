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
import type { Measurement, SensorKind } from './types.js';
/**
 * Well-known HAP service UUIDs for sensor types the plugin registers.
 * These are the values HAP-NodeJS assigns to `Service.<Family>.UUID`.
 * They're stable across HAP-NodeJS versions.
 */
export declare const HAP_SERVICE_UUIDS: {
    readonly TEMPERATURE_SENSOR: "0000008A-0000-1000-8000-0026BB765291";
    readonly HUMIDITY_SENSOR: "00000082-0000-1000-8000-0026BB765291";
    readonly LIGHT_SENSOR: "00000084-0000-1000-8000-0026BB765291";
    readonly CARBON_DIOXIDE_SENSOR: "00000097-0000-1000-8000-0026BB765291";
    readonly CARBON_MONOXIDE_SENSOR: "0000007F-0000-1000-8000-0026BB765291";
    readonly AIR_QUALITY_SENSOR: "0000008D-0000-1000-8000-0026BB765291";
    readonly MOTION_SENSOR: "00000085-0000-1000-8000-0026BB765291";
    readonly LEAK_SENSOR: "00000083-0000-1000-8000-0026BB765291";
    readonly CONTACT_SENSOR: "00000080-0000-1000-8000-0026BB765291";
    readonly OCCUPANCY_SENSOR: "00000086-0000-1000-8000-0026BB765291";
};
export declare const HAP_CHARACTERISTIC_UUIDS: {
    readonly PM2_5_DENSITY: "000000C6-0000-1000-8000-0026BB765291";
    readonly PM10_DENSITY: "000000C7-0000-1000-8000-0026BB765291";
};
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
export type BootstrapResult = {
    status: 'inferred';
    kind: Exclude<SensorKind, 'unrecognized'>;
    measurement: Measurement;
} | {
    status: 'preserve-cached';
};
/**
 * Infer kind + measurement for a cached accessory. Never mutates the
 * accessory. Caller is responsible for writing the result back to
 * context (or not, on 'preserve-cached').
 */
export declare function inferForCachedAccessory(accessory: CachedAccessoryShape): BootstrapResult;
/**
 * `${macAddress}-${sensorKey}` → sensorKey. macAddress format is
 * `AA:BB:CC:DD:EE:FF` (contains colons but no hyphens), so the first
 * hyphen is the split point. Everything after is the sensorKey (which
 * may itself contain underscores).
 */
export declare function dataPointFromUniqueId(uniqueId: string): string | undefined;
//# sourceMappingURL=bootstrap.d.ts.map
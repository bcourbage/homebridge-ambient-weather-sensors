import { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import type { BooleanSensorRow } from './sensorMap/types.js';
/**
 * Per-kind wiring for the boolean STATE family (sensor-map.md §19.1):
 * which HAP service renders the state, which characteristic carries
 * the alert, and the HAP values for active/clear. The DECODE contract
 * is shared and explicit:
 *
 *   raw 0                         → clear, fault cleared
 *   raw 1                         → active, fault cleared
 *   anything else (>= 2, negative,
 *   non-integer)                  → StatusFault GENERAL_FAULT and the
 *                                   alert FORCED CLEAR
 *
 * A value outside the declared 0/1 vocabulary must never read as an
 * alarm — the canonical case is the leak family's documented
 * `2 = offline`, which previously coerced to "leak detected" through
 * generic boolean truthiness.
 */
interface BooleanStateSpec {
    model: string;
    service: (platform: AmbientWeatherSensorsPlatform) => WithUUID<typeof Service>;
    characteristic: (platform: AmbientWeatherSensorsPlatform) => WithUUID<new () => Characteristic>;
    activeValue: (platform: AmbientWeatherSensorsPlatform) => CharacteristicValue;
    clearValue: (platform: AmbientWeatherSensorsPlatform) => CharacteristicValue;
}
/**
 * One row-parameterized implementation for every boolean state kind
 * (§16 genericity: dataPoint, name, and battery ownership all come
 * from the row; nothing is hardcoded to an AWN field).
 */
declare abstract class BooleanStateAccessory implements SensorAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly spec;
    private readonly row;
    private readonly service;
    private readonly batterySetter?;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, spec: BooleanStateSpec, row: BooleanSensorRow);
    setBatteryLow(batteryLow: boolean): void;
    /**
     * The shared explicit decode (§19.1). `coerceValue` passes the finite
     * raw through for boolean rows precisely so this decode sees an
     * out-of-contract value instead of a pre-collapsed truthy 1.
     */
    setValue(rawValue: number): void;
}
export declare class LeakAccessory extends BooleanStateAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow);
}
export declare class ContactAccessory extends BooleanStateAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow);
}
export declare class OccupancyAccessory extends BooleanStateAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow);
}
export declare class SmokeAccessory extends BooleanStateAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow);
}
/**
 * DIRECT boolean motion (the `motion|boolean` pair) — a state tile
 * driven by a 0/1 field, distinct from the extended threshold shell.
 * Threshold-family fields a motion row may legally carry are inert
 * here: a boolean has no numeric reading to compare.
 */
export declare class MotionBooleanAccessory extends BooleanStateAccessory {
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow);
}
export {};
//# sourceMappingURL=booleanStateAccessory.d.ts.map
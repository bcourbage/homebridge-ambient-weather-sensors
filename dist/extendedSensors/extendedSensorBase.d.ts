import { PlatformAccessory, Service } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from '../platform.js';
/**
 * Display mode for the extended-sensor tile in Apple's Home app.
 *
 * - `static`: tile name stays at the sensor label (e.g. "Wind Speed").
 *   Apple Home users see a Motion Sensor tile that toggles on/off
 *   based on the configured threshold. Live numeric values are only
 *   visible in Eve / Controller for HomeKit. Recommended default —
 *   no name churn, no log warnings, stable UX.
 *
 * - `embed`: tile name is rewritten on every update to include the
 *   reading (e.g. "Wind Speed 14 mph"). Apple Home users see the
 *   value directly on the tile. Trade-offs documented next to the
 *   config setting.
 */
export type ExtendedDisplayMode = 'static' | 'embed';
/**
 * Inputs threaded through the constructor — keeps the public surface
 * small even as subclasses grow. Each extended-sensor subclass passes
 * one of these into super().
 */
export interface ExtendedSensorOptions {
    /** Friendly base name, shown in Apple Home. Examples: "Wind Speed", "Rain Rate", "UV Index". */
    sensorLabel: string;
    /** AWN's machine name for this sensor (e.g. "windspeedmph"). Used for logging only. */
    awnKey: string;
    /**
     * Value at which MotionDetected flips to true. Interpretation
     * depends on `triggerDirection` below — by default a reading at or
     * above `threshold` trips the motion event; for "low values are
     * noteworthy" sensors (barometric pressure, lightning distance),
     * the subclass sets `triggerDirection: 'below'` so readings at or
     * below the threshold trip it instead. Pass `Infinity` (with the
     * default 'above') to disable motion triggering entirely (e.g.
     * wind direction, last-strike timestamp — informational only).
     */
    threshold: number;
    /**
     * Compare direction for the threshold. 'above' is the default and
     * matches the conventional "trigger on high values" sensors (wind
     * gust, UV, rain rate, lightning count). 'below' inverts the
     * comparison for sensors where low readings are the alarming
     * direction (barometric pressure = storm incoming, lightning
     * distance = nearby strike).
     */
    triggerDirection?: 'above' | 'below';
    /** Display mode chosen by the user in config. */
    displayMode: ExtendedDisplayMode;
}
/**
 * Base class for every extended (non-native) sensor type. Wraps a
 * `MotionSensor` service and bolts on three custom characteristics
 * (Value + Intensity + Last Updated) so Eve / Controller for HomeKit
 * can render the live reading and qualitative bucket while Apple
 * Home can still drive automations off MotionDetected.
 *
 * Subclasses implement:
 *   - `formatValue(raw)`  — returns the user-facing reading, e.g. "14 mph"
 *   - `formatIntensity(raw)` — qualitative bucket or undefined to omit
 *
 * The base class handles MotionDetected threshold logic, name updates
 * for the embed display mode (with user-rename detection), and ISO
 * timestamping on every update.
 */
export declare abstract class ExtendedSensorBase implements SensorAccessory {
    protected readonly platform: AmbientWeatherSensorsPlatform;
    protected readonly accessory: PlatformAccessory;
    protected readonly options: ExtendedSensorOptions;
    protected readonly service: Service;
    private readonly customCharacteristics;
    private lastSetName;
    private readonly batterySetter?;
    private readonly valueChar;
    private readonly lastUpdatedChar;
    private readonly intensityChar;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, options: ExtendedSensorOptions);
    setBatteryLow(batteryLow: boolean): void;
    /**
     * Polling/realtime loop entry point — same signature as every other
     * SensorAccessory in the plugin. Pushes the raw AWN value through
     * the subclass's formatters, updates the three custom
     * characteristics, flips MotionDetected based on the threshold,
     * and updates the tile name in embed mode (respecting user
     * renames).
     */
    setValue(rawValue: number): void;
    /**
     * Subclass hook: format the raw AWN value into a user-facing string
     * with the appropriate unit suffix.
     *   "14 mph"     "315° (NW)"     "0.12 in/hr"     "10.6 mi"
     *
     * Integer rounding is recommended for the numeric portion to keep
     * the tile name compatible with Apple Home's naming rules in embed
     * mode — but the subclass is free to use decimals if it prefers,
     * since the Value characteristic itself accepts any string. Only
     * the tile-name path runs the value through a sanitizer.
     */
    protected abstract formatValue(raw: number): string;
    /**
     * Subclass hook: format a qualitative bucket label for the
     * Intensity characteristic. Return `undefined` to omit the
     * characteristic entirely (e.g. wind direction, last-strike
     * timestamp — they don't have meaningful buckets).
     *
     * Default implementation returns undefined; subclasses with a
     * bucket scale override it.
     */
    protected formatIntensity(_raw: number): string | undefined;
    /**
     * Attach a custom characteristic to the service and return the
     * Characteristic instance so the caller can cache the ref for
     * future `.updateValue()` calls.
     *
     * If the characteristic was previously restored from cache, the
     * service already has an instance — `getCharacteristic(ctor)`
     * finds it (HAP matches by static UUID for constructor-form
     * input). Otherwise `addCharacteristic(ctor)` creates and attaches
     * a fresh one.
     *
     * The double cast through `unknown` reconciles the type-form
     * mismatch between HAP's `WithUUID<typeof Characteristic>` (the
     * shape testCharacteristic expects) and `WithUUID<new () =>
     * Characteristic>` (the shape getCharacteristic/addCharacteristic
     * expect). At runtime the underlying object is identical — a class
     * constructor with a static UUID — so the cast is safe.
     */
    private attachCustomCharacteristic;
    /**
     * In embed display mode, rewrite the tile name to include the live
     * value (e.g. "Wind Speed 14 mph"). Respects user-set custom names:
     * if the current ConfiguredName doesn't match what we last set,
     * the user has renamed the tile in Apple Home and we leave it
     * alone. In static display mode this is a no-op.
     */
    private maybeUpdateTileName;
}
//# sourceMappingURL=extendedSensorBase.d.ts.map
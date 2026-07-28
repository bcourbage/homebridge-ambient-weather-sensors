import { PlatformAccessory, Service } from 'homebridge';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from '../platform.js';
import type { EffectiveSensorRow, Measurement, NumericSensorRow, SensorUnit, TimestampSensorRow } from '../sensorMap/types.js';
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
 * The configured row shapes an extended wrapper can be handed. Both
 * carry the knobs (`name`, `threshold`, `triggerEnabled`, `embedName`,
 * `sourceUnit`, `triggerDirection`) the row-driven constructors read;
 * unrecognized rows never reach a wrapper.
 */
export type ConfiguredExtendedRow = NumericSensorRow | TimestampSensorRow;
/**
 * Display mode from the row (`embedName`) when present, else from the
 * legacy `platform.config.extendedDisplayMode`. Finding-#4 Stage 2.
 */
export declare function extendedDisplayModeFor(platform: AmbientWeatherSensorsPlatform, row: ConfiguredExtendedRow | undefined): ExtendedDisplayMode;
/**
 * Threshold (in the row's source unit) from the row when present, else
 * the legacy config-derived value. `triggerEnabled: false` and a blank
 * threshold both collapse to `Infinity`, which the base's
 * `Number.isFinite` gate reads as "motion trigger disabled".
 */
export declare function thresholdFor(row: ConfiguredExtendedRow | undefined, legacyThreshold: number): number;
/**
 * Inputs threaded through the constructor — keeps the public surface
 * small even as subclasses grow. Each extended-sensor subclass passes
 * one of these into super().
 *
 * Discriminated on `variant` (finding-#4 review): a `TimestampSensorRow`
 * has no `displayUnit` and `sourceUnit` is fixed at `'ms'` by contract,
 * so bundling everything into one interface would let an illegal
 * `(timestamp, non-ms)` combination be constructed. The union makes
 * that unrepresentable and the base dispatches on `variant`.
 */
interface CommonExtendedOptions {
    /** Friendly base name, shown in Apple Home. Examples: "Wind Speed", "Rain Rate", "UV Index". */
    sensorLabel: string;
    /** AWN's machine name for this sensor (e.g. "windspeedmph"). Used for logging only. */
    awnKey: string;
    /**
     * Value at which MotionDetected flips to true, IN `sourceUnit`.
     * Interpretation depends on `triggerDirection` — by default a reading
     * at or above `threshold` trips the event; sensors where low readings
     * are the alarming direction pass `triggerDirection: 'below'`. Pass
     * `Infinity` to disable motion triggering entirely (wind direction,
     * timestamps — informational only).
     */
    threshold: number;
    /**
     * Compare direction for the threshold. 'above' is the default;
     * 'below' inverts it (barometric pressure = storm incoming, lightning
     * distance = nearby strike).
     */
    triggerDirection?: 'above' | 'below';
    /** Display mode chosen by the user in config. */
    displayMode: ExtendedDisplayMode;
}
/**
 * Numeric extended sensor. `measurement` + `sourceUnit` let the base
 * convert the raw reading AND the threshold to the family's canonical
 * unit before comparing / bucketing, so a custom sensor reporting a
 * non-AWN unit (kph, mm, hPa, km) thresholds correctly. For every
 * AWN-native known dataPoint `sourceUnit` already equals the canonical
 * unit, so `toCanonical` is the identity and behavior is byte-identical
 * to v1.6.0.
 */
export interface NumericExtendedOptions extends CommonExtendedOptions {
    variant: 'numeric';
    measurement: Exclude<Measurement, 'timestamp' | 'boolean'>;
    sourceUnit: SensorUnit;
}
/**
 * Timestamp extended sensor (last-rain, last-lightning-strike). The
 * value is already Unix ms — `sourceUnit` is locked to `'ms'`, there is
 * no display unit, and `threshold` is always `Infinity` (a timestamp
 * cannot meaningfully cross a threshold).
 */
export interface TimestampExtendedOptions extends CommonExtendedOptions {
    variant: 'timestamp';
    measurement: 'timestamp';
    sourceUnit: 'ms';
}
export type ExtendedSensorOptions = NumericExtendedOptions | TimestampExtendedOptions;
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
    private lastNameUpdateAt;
    private readonly batterySetter?;
    private readonly valueChar;
    private readonly lastUpdatedChar;
    private readonly intensityChar;
    private readonly rowDriven;
    constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, options: ExtendedSensorOptions, row?: EffectiveSensorRow);
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
     *
     * DIAGNOSTIC INSTRUMENTATION: every embed-mode invocation logs a
     * single `[embed-diag] ...` line at debug level capturing the
     * decision state. Originally added at info-level in beta.24 to
     * characterize solmssen's "tile gets reassigned to default room"
     * report; downgraded to debug in 1.5.0 GA once the mechanism was
     * identified (it's the Homebridge UI Accessories page tracking
     * rooms by displayName — when the name updates, the UI puts the
     * tile in the default room until the name happens to revert to
     * its placed-state value). Apple Home and Eve aren't affected.
     * The instrument is kept available for any future investigation
     * — toggle HB_LOG_LEVEL=debug to capture.
     */
    private maybeUpdateTileName;
}
export {};
//# sourceMappingURL=extendedSensorBase.d.ts.map
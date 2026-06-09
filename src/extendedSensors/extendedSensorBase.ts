import { Characteristic, PlatformAccessory, Service } from 'homebridge';

import { AmbientWeatherSensorsPlatform, SensorAccessory } from '../platform.js';
import { register as registerCharacteristics } from './customCharacteristics.js';
import { composeStaticName, composeEmbeddedName, isUserRenamed } from './nameComposer.js';

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
export abstract class ExtendedSensorBase implements SensorAccessory {
  protected readonly service: Service;
  private readonly customCharacteristics: ReturnType<typeof registerCharacteristics>;
  private lastSetName: string | undefined;

  constructor(
    protected readonly platform: AmbientWeatherSensorsPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly options: ExtendedSensorOptions,
  ) {
    this.customCharacteristics = registerCharacteristics(this.platform.api);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, options.sensorLabel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    // MotionSensor is HAP-native and renders in Apple Home with an
    // on/off state — the most useful affordance Apple's Home app
    // offers for data it doesn't natively understand. Eve and
    // Controller for HomeKit additionally render the three custom
    // characteristics we add below.
    this.service = this.accessory.getService(this.platform.Service.MotionSensor)
                || this.accessory.addService(this.platform.Service.MotionSensor);

    // Name + ConfiguredName are HAP-mandatory on user-facing services.
    // ConfiguredName is the HAP 2.x replacement; setting both keeps us
    // compatible across HAP versions.
    const initialName = composeStaticName(options.sensorLabel);
    this.service.setCharacteristic(this.platform.Characteristic.Name, initialName);
    this.service.setCharacteristic(this.platform.Characteristic.ConfiguredName, initialName);
    this.lastSetName = initialName;

    // Register our three custom characteristics on this service.
    // Service#addOptionalCharacteristic + Service#getCharacteristic is
    // the recommended pattern for adding a non-stock characteristic to
    // a stock service — it lets HAP discover the characteristic via
    // its UUID without us having to track the Characteristic instance
    // separately.
    this.ensureCustomCharacteristic(this.customCharacteristics.Value);
    this.ensureCustomCharacteristic(this.customCharacteristics.LastUpdated);
    // Intensity is opt-in — sensors that don't have a meaningful
    // qualitative bucket (e.g. wind direction) just don't override
    // `formatIntensity()`, and we skip adding the characteristic.
    if (this.formatIntensity(0) !== undefined) {
      this.ensureCustomCharacteristic(this.customCharacteristics.Intensity);
    }

    // Replay any cached value so the tile isn't blank on the first
    // poll after a Homebridge restart. Same idiom the native
    // accessories use.
    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  /**
   * Polling/realtime loop entry point — same signature as every other
   * SensorAccessory in the plugin. Pushes the raw AWN value through
   * the subclass's formatters, updates the three custom
   * characteristics, flips MotionDetected based on the threshold,
   * and updates the tile name in embed mode (respecting user
   * renames).
   */
  setValue(rawValue: number): void {
    const valueStr = this.formatValue(rawValue);
    const intensityStr = this.formatIntensity(rawValue);
    const timestamp = new Date().toISOString();
    const direction = this.options.triggerDirection ?? 'above';
    const detected = Number.isFinite(this.options.threshold)
      && (direction === 'above'
        ? rawValue >= this.options.threshold
        : rawValue <= this.options.threshold);

    this.platform.log.debug(
      `EXTENDED ${this.options.awnKey}: value="${valueStr}" intensity="${intensityStr ?? '-'}" ` +
      `raw=${rawValue} threshold=${this.options.threshold} motion=${detected}`,
    );

    this.service
      .updateCharacteristic(this.customCharacteristics.Value, valueStr)
      .updateCharacteristic(this.customCharacteristics.LastUpdated, timestamp)
      .updateCharacteristic(this.platform.Characteristic.MotionDetected, detected);

    if (intensityStr !== undefined) {
      this.service.updateCharacteristic(this.customCharacteristics.Intensity, intensityStr);
    }

    this.maybeUpdateTileName(valueStr);
  }

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
  protected formatIntensity(_raw: number): string | undefined {
    return undefined;
  }

  /**
   * Add a custom characteristic to the service if it isn't already
   * present. `Service#testCharacteristic` accepts either a name, a
   * UUID string, or a constructor; passing the constructor lets HAP
   * do the UUID lookup for us. Calling `addCharacteristic` twice
   * with the same UUID throws, so the guard matters across
   * child-bridge restarts where the service may be restored from
   * cache with our characteristics already attached.
   */
  private ensureCustomCharacteristic(CharCtor: new () => Characteristic): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!this.service.testCharacteristic(CharCtor as any)) {
      this.service.addCharacteristic(CharCtor);
    }
  }

  /**
   * In embed display mode, rewrite the tile name to include the live
   * value (e.g. "Wind Speed 14 mph"). Respects user-set custom names:
   * if the current ConfiguredName doesn't match what we last set,
   * the user has renamed the tile in Apple Home and we leave it
   * alone. In static display mode this is a no-op.
   */
  private maybeUpdateTileName(valueStr: string): void {
    if (this.options.displayMode !== 'embed') {
      return;
    }

    const currentName = this.service.getCharacteristic(this.platform.Characteristic.ConfiguredName).value as string | undefined;
    if (isUserRenamed(currentName, this.lastSetName)) {
      this.platform.log.debug(
        `EXTENDED ${this.options.awnKey}: tile renamed by user ("${currentName}"), skipping embed-mode name update`,
      );
      return;
    }

    const newName = composeEmbeddedName(this.options.sensorLabel, valueStr);
    if (newName === this.lastSetName) {
      // No-op; value hasn't changed enough to alter the rounded label.
      return;
    }

    this.service
      .updateCharacteristic(this.platform.Characteristic.Name, newName)
      .updateCharacteristic(this.platform.Characteristic.ConfiguredName, newName);
    this.lastSetName = newName;
  }
}

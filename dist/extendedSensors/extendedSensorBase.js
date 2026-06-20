import { setupBatteryService } from '../batteryService.js';
import { register as registerCharacteristics } from './customCharacteristics.js';
import { composeStaticName, composeEmbeddedName, isUserRenamed } from './nameComposer.js';
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
export class ExtendedSensorBase {
    constructor(platform, accessory, options) {
        this.platform = platform;
        this.accessory = accessory;
        this.options = options;
        this.customCharacteristics = registerCharacteristics(this.platform.api);
        this.accessory.getService(this.platform.Service.AccessoryInformation)
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
        // Attach the three custom characteristics to the MotionSensor service
        // and hold instance refs for later updates. See note on the
        // class-level field declarations for why we cache instances rather
        // than letting setValue do UUID-string lookups on every tick.
        this.valueChar = this.attachCustomCharacteristic(this.customCharacteristics.Value);
        this.lastUpdatedChar = this.attachCustomCharacteristic(this.customCharacteristics.LastUpdated);
        // Intensity is opt-in — sensors that don't have a meaningful
        // qualitative bucket (e.g. wind direction, pressure) just don't
        // override `formatIntensity()`, and we skip adding the characteristic.
        this.intensityChar = this.formatIntensity(0) !== undefined
            ? this.attachCustomCharacteristic(this.customCharacteristics.Intensity)
            : undefined;
        // Attach the Battery sub-service driven by the same probe's batt*
        // field (battout, battin, batt_lightning, etc. — see
        // batteryFields.ts). Returns undefined and skips the sub-service
        // when AWN doesn't report a battery for this probe. Wind, rain,
        // pressure, UV and lightning sensors all live on physical probes
        // that AWN does report batteries for, so in practice this will
        // attach a Battery sub-service for every extended sensor on a
        // typical station.
        this.batterySetter = setupBatteryService(this.platform, this.accessory);
        // NOTE: Don't call setValue() from this constructor. Subclasses
        // assign their unit-conversion / formatter state AFTER super()
        // returns, so a setValue invoked from here would observe those
        // fields as undefined — silently producing "NaN" tiles for most
        // subclasses, and CRASHING with "Cannot read properties of
        // undefined (reading 'toFixed')" for LightningDistanceAccessory
        // because convertDistance() is a switch with no default case and
        // returns undefined when handed an undefined unit.
        //
        // The seed-from-cache call is done by the platform layer in
        // discoverDevices(), AFTER the subclass constructor has fully
        // completed — see platform.ts.
    }
    setBatteryLow(batteryLow) {
        this.batterySetter?.(batteryLow);
    }
    /**
     * Polling/realtime loop entry point — same signature as every other
     * SensorAccessory in the plugin. Pushes the raw AWN value through
     * the subclass's formatters, updates the three custom
     * characteristics, flips MotionDetected based on the threshold,
     * and updates the tile name in embed mode (respecting user
     * renames).
     */
    setValue(rawValue) {
        const valueStr = this.formatValue(rawValue);
        const intensityStr = this.formatIntensity(rawValue);
        const timestamp = new Date().toISOString();
        const direction = this.options.triggerDirection ?? 'above';
        const detected = Number.isFinite(this.options.threshold)
            && (direction === 'above'
                ? rawValue >= this.options.threshold
                : rawValue <= this.options.threshold);
        this.platform.log.debug(`EXTENDED ${this.options.awnKey}: value="${valueStr}" intensity="${intensityStr ?? '-'}" ` +
            `raw=${rawValue} threshold=${this.options.threshold} motion=${detected}`);
        // Update the three custom characteristics via the cached instance
        // refs. Calling `.updateValue()` directly avoids HAP's broken
        // string-based getCharacteristic path (which matches by displayName,
        // not UUID, and silently returns undefined).
        this.valueChar.updateValue(valueStr);
        this.lastUpdatedChar.updateValue(timestamp);
        if (intensityStr !== undefined && this.intensityChar) {
            this.intensityChar.updateValue(intensityStr);
        }
        // MotionDetected is HAP-native and can use the standard service
        // helper (constructor-form lookup works correctly for stock
        // characteristics).
        this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, detected);
        this.maybeUpdateTileName(valueStr);
    }
    /**
     * Subclass hook: format a qualitative bucket label for the
     * Intensity characteristic. Return `undefined` to omit the
     * characteristic entirely (e.g. wind direction, last-strike
     * timestamp — they don't have meaningful buckets).
     *
     * Default implementation returns undefined; subclasses with a
     * bucket scale override it.
     */
    formatIntensity(_raw) {
        return undefined;
    }
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
    attachCustomCharacteristic(CharCtor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctorForGet = CharCtor;
        if (this.service.testCharacteristic(CharCtor)) {
            return this.service.getCharacteristic(ctorForGet);
        }
        return this.service.addCharacteristic(ctorForGet);
    }
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
    maybeUpdateTileName(valueStr) {
        if (this.options.displayMode !== 'embed') {
            return;
        }
        const currentName = this.service.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
        const renamed = isUserRenamed(currentName, this.lastSetName);
        const newName = composeEmbeddedName(this.options.sensorLabel, valueStr);
        const nameChange = newName !== this.lastSetName;
        const willUpdate = !renamed && nameChange;
        this.platform.log.debug(`[embed-diag] ${this.options.awnKey}: ` +
            `currentConfigured="${currentName ?? '(unset)'}" ` +
            `lastSet="${this.lastSetName ?? '(none)'}" ` +
            `userRenamed=${renamed} ` +
            `newName="${newName}" ` +
            `willUpdate=${willUpdate}`);
        if (renamed || !nameChange) {
            return;
        }
        this.service
            .updateCharacteristic(this.platform.Characteristic.Name, newName)
            .updateCharacteristic(this.platform.Characteristic.ConfiguredName, newName);
        this.lastSetName = newName;
    }
}
//# sourceMappingURL=extendedSensorBase.js.map
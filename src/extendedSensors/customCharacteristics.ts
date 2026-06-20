/**
 * Custom HAP characteristics used by the v1.5.0 "extended sensors"
 * (wind, rain, barometric pressure, UV, lightning). Apple's HomeKit
 * Accessory Protocol does not define native services for these data
 * types, so each extended-sensor accessory is exposed as a
 * `MotionSensor` (which Apple Home recognizes and can drive automations
 * from) with these three additional characteristics bolted on.
 *
 * Apple's Home app silently ignores characteristics it doesn't
 * recognize. Eve for HomeKit and Controller for HomeKit render
 * arbitrary string characteristics by their `name` attribute, which is
 * why the live numeric reading shows up there but not in Home.app.
 * The README documents this trade-off and the user can opt to embed
 * the value in the tile's ConfiguredName for Home.app visibility (with
 * the trade-offs documented in the config form).
 *
 * Pattern intentionally mirrors rhockenbury/homebridge-ecowitt-weather-sensors,
 * which is in the homebridge `verified-plugins.json` list and uses the
 * same three-characteristic shape (Value + Intensity + Last Updated).
 * Following an established pattern reduces our re-verification risk
 * and gives users a consistent cross-plugin experience when they run
 * both side-by-side (a real use case — see issue #1).
 *
 * UUIDs below were generated via `uuidgen` and are *fresh* — they are
 * NOT shared with Eve, Ecowitt, or any other plugin. Reusing another
 * plugin's UUIDs would let third-party HomeKit apps render our values
 * with the *other* plugin's display logic, which sounds appealing but
 * breaks down quickly: their units, history scales, and labels won't
 * match ours. Better to be our own first-class extension.
 *
 * UUIDs are stable across versions. Changing one would invalidate
 * every user's accessory cache for that characteristic. Don't change.
 */
import { API, Characteristic, Formats, Perms, WithUUID } from 'homebridge';

/**
 * Stable UUIDs — DO NOT CHANGE without a major version bump and a
 * documented migration path. Generated 2026-06-09 via `uuidgen`.
 */
export const VALUE_CHARACTERISTIC_UUID = '0B1001CD-7070-430D-B7AB-C707B5130359';
export const INTENSITY_CHARACTERISTIC_UUID = '588E2FC3-8C18-454A-819E-5510195F5710';
export const LAST_UPDATED_CHARACTERISTIC_UUID = '88D5A140-DF20-4741-AF1B-780045076A8F';

/**
 * Container for the three custom-characteristic constructor classes,
 * lazily built on first call to `register()` so we can defer reading
 * `api.hap.Characteristic` (which isn't available at module load).
 *
 * `register()` is idempotent — Homebridge may instantiate the platform
 * multiple times during a child-bridge restart cycle, and calling
 * Characteristic subclass constructors twice for the same UUID would
 * throw. The internal `registered` flag prevents that.
 */
/**
 * Each entry is the class of a Characteristic subclass that also
 * carries a static `UUID` field — the shape HAP-NodeJS's
 * `WithUUID<T>` brand requires. We use `typeof Characteristic`
 * (the whole class type, including static members + the instance
 * prototype chain) rather than `new () => Characteristic` (just
 * the construct signature) because that's what HAP's overloads
 * accept — e.g. `Service#updateCharacteristic(ctor, value)`.
 */
export interface ExtendedCharacteristics {
  Value: WithUUID<typeof Characteristic>;
  Intensity: WithUUID<typeof Characteristic>;
  LastUpdated: WithUUID<typeof Characteristic>;
}

let cached: ExtendedCharacteristics | undefined;

export function register(api: API): ExtendedCharacteristics {
  if (cached) {
    return cached;
  }

  const HapCharacteristic = api.hap.Characteristic;

  /**
   * The live numeric reading, formatted as a short human-readable
   * string with the appropriate unit suffix. Examples:
   *   Wind speed:        "14 mph"
   *   Wind direction:    "315° (NW)"
   *   Rain rate:         "0.12 in/hr"
   *   Barometric:        "29.95 inHg"
   *   UV:                "7"
   *   Lightning count:   "3 strikes"
   *   Lightning dist:    "10.6 mi"
   *   Lightning time:    "2 minutes ago"
   *
   * String, not number, so each sensor can format with its own unit
   * label and the same characteristic UUID can carry every kind of
   * extended reading (avoids registering N per-metric UUIDs the way
   * Eve / homebridge-weather-plus do).
   */
  class Value extends HapCharacteristic {
    // Static UUID is required for HAP's `WithUUID<...>` type — without
    // it, Service#updateCharacteristic(ctor, value) and friends won't
    // accept this constructor as a characteristic identifier.
    public static readonly UUID = VALUE_CHARACTERISTIC_UUID;

    constructor() {
      super('Value', VALUE_CHARACTERISTIC_UUID, {
        format: Formats.STRING,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  /**
   * Qualitative bucket describing the reading. Same UUID is reused
   * across sensor types; the actual bucket vocabulary is per-sensor:
   *   Wind:      Beaufort scale ("Calm", "Light breeze", "Gale", …)
   *   Rain:      "None", "Light", "Moderate", "Heavy", "Violent"
   *   UV:        EPA scale ("Low", "Moderate", "High", "Very High", "Extreme")
   *   Pressure:  trend (deferred to v1.5.x — requires history)
   *
   * Direction-style sensors (wind direction, last-strike timestamp)
   * omit this characteristic by simply not adding it to the service —
   * there's no meaningful bucket for them.
   */
  class Intensity extends HapCharacteristic {
    public static readonly UUID = INTENSITY_CHARACTERISTIC_UUID;

    constructor() {
      super('Intensity', INTENSITY_CHARACTERISTIC_UUID, {
        format: Formats.STRING,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  /**
   * ISO-8601 timestamp of when the value was last refreshed. Useful
   * for spotting a frozen sensor (e.g., station offline) without
   * having to enable verbose logs. Eve / Controller for HomeKit show
   * this directly on the tile.
   *
   * Format: "2026-06-09T16:48:00.000Z" (matches what AWN itself emits
   * in `lastData.date`). Refreshed on every `update()` call from the
   * base class, not on every poll — i.e., if a value is unchanged,
   * the timestamp still advances so users can tell the data is live.
   */
  class LastUpdated extends HapCharacteristic {
    public static readonly UUID = LAST_UPDATED_CHARACTERISTIC_UUID;

    constructor() {
      super('Last Updated', LAST_UPDATED_CHARACTERISTIC_UUID, {
        format: Formats.STRING,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  cached = { Value, Intensity, LastUpdated };
  return cached;
}

/**
 * Stable UUIDs — DO NOT CHANGE without a major version bump and a
 * documented migration path. Generated 2026-06-09 via `uuidgen`.
 */
export const VALUE_CHARACTERISTIC_UUID = '0B1001CD-7070-430D-B7AB-C707B5130359';
export const INTENSITY_CHARACTERISTIC_UUID = '588E2FC3-8C18-454A-819E-5510195F5710';
export const LAST_UPDATED_CHARACTERISTIC_UUID = '88D5A140-DF20-4741-AF1B-780045076A8F';
let cached;
export function register(api) {
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
        static { this.UUID = VALUE_CHARACTERISTIC_UUID; }
        constructor() {
            super('Value', VALUE_CHARACTERISTIC_UUID, {
                format: "string" /* Formats.STRING */,
                perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */],
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
        static { this.UUID = INTENSITY_CHARACTERISTIC_UUID; }
        constructor() {
            super('Intensity', INTENSITY_CHARACTERISTIC_UUID, {
                format: "string" /* Formats.STRING */,
                perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */],
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
        static { this.UUID = LAST_UPDATED_CHARACTERISTIC_UUID; }
        constructor() {
            super('Last Updated', LAST_UPDATED_CHARACTERISTIC_UUID, {
                format: "string" /* Formats.STRING */,
                perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */],
            });
            this.value = this.getDefaultValue();
        }
    }
    cached = { Value, Intensity, LastUpdated };
    return cached;
}
//# sourceMappingURL=customCharacteristics.js.map
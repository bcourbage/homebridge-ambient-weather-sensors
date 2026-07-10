/**
 * Sensor map — public and internal type definitions.
 *
 * See docs/future/sensor-map.md §3 for the design reasoning behind
 * the shapes below. Summary:
 *
 * - `SensorKind` selects the HAP wrapper family (TemperatureSensor,
 *   MotionSensor, LeakSensor, etc.).
 * - `Measurement` names the physical dimension (temperature vs.
 *   wind-speed vs. pressure, etc.). Separated from `SensorKind`
 *   because `motion` is a HAP-service catch-all spanning many
 *   physically distinct measurements. Units and threshold semantics
 *   are keyed by measurement, not by kind.
 * - `SensorMapOverride` is what the user writes into `config.json`
 *   (sparse — only fields the user has set).
 * - `EffectiveSensorRow` is the fully-resolved runtime row after
 *   defaults + compat + overrides are merged. Discriminated by
 *   `kind` and by measurement shape (Numeric / Timestamp / Boolean).
 */
export {};
//# sourceMappingURL=types.js.map
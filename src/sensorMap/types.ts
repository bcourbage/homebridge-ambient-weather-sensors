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

/**
 * Twelve values corresponding to HAP-native sensor services the plugin
 * can render. `unrecognized` is a sentinel for auto-discovered
 * datapoints the plugin doesn't have a default for; those rows do NOT
 * produce a HomeKit accessory until the user assigns a real kind.
 *
 * Value tiles (Apple Home renders the reading directly):
 *   temperature, humidity, light, co2, co, air-quality-pm25, air-quality-pm10
 *
 * State tiles (Apple Home renders a boolean state):
 *   motion, leak, contact, occupancy
 */
export type SensorKind =
  | 'temperature'
  | 'humidity'
  | 'light'
  | 'co2'
  | 'co'
  | 'air-quality-pm25'
  | 'air-quality-pm10'
  | 'motion'
  | 'leak'
  | 'contact'
  | 'occupancy'
  | 'unrecognized';

/**
 * Physical measurement dimension. Determines allowed units, threshold
 * interpretation, conversion, AND wrapper subtype selection when `kind`
 * alone underspecifies the wrapper (all `motion` accessories share
 * `kind: motion` but span many measurements from wind-speed to pressure
 * to lightning count).
 */
export type Measurement =
  | 'temperature'
  | 'humidity'
  | 'illuminance'
  | 'co2'
  | 'co'
  | 'pm25'
  | 'pm10'
  | 'wind-speed'
  | 'rain-rate'
  | 'rain-accumulation'
  | 'pressure'
  | 'distance'
  | 'uv-index'
  | 'count'
  | 'direction'
  | 'timestamp'
  | 'boolean';

/**
 * All the concrete unit values referenced by any measurement's legal
 * set. Kept as a string union rather than an enum so JSON serialization
 * is transparent and no `enum.SOMETHING` lookup is needed.
 */
export type SensorUnit =
  // Temperature
  | 'fahrenheit'
  | 'celsius'
  // Humidity
  | 'percent'
  // Light
  | 'wm2'
  | 'lux'
  // Gas
  | 'ppm'
  // Particulate
  | 'ugm3'
  // Wind
  | 'mph'
  | 'kph'
  | 'mps'
  | 'kts'
  // Rain rate
  | 'in_per_hr'
  | 'mm_per_hr'
  // Rain accumulation
  | 'in'
  | 'mm'
  // Pressure
  | 'inHg'
  | 'hPa'
  // Distance
  | 'mi'
  | 'km'
  | 'nm'
  // Dimensionless
  | 'index'
  | 'count'
  | 'degrees'
  // Timestamp
  | 'ms';

/**
 * User-authored override entry in `config.json`. Sparse — only fields
 * the user has explicitly set appear.
 *
 * See §3.3 of the design doc for the full field-by-field contract,
 * including validation rules (§3.7) and known-datapoint remapping
 * constraints (§3.8).
 */
export interface SensorMapOverride {
  /** AWN field name. Required. Row identity. */
  dataPoint: string;

  /**
   * Restrict this override to one station. Absent = global template
   * applying to every station. Present = MUST be a MAC-formatted
   * string; name-shaped values fail row-level validation.
   */
  stationMac?: string;

  /**
   * Override the default kind. Required for custom (unrecognized)
   * dataPoints. For known dataPoints, only permitted within the
   * measurement's compatible-kinds set (§3.8).
   */
  kind?: SensorKind;

  /**
   * Measurement dimension. Required for custom dataPoints alongside
   * `kind`. Ignored for known dataPoints (measurement is fixed at the
   * default-map level).
   */
  measurement?: Measurement;

  /** Display name in HomeKit. Falls back to the plugin default. */
  name?: string;

  /** Motion-trigger threshold. Numeric, stored in sourceUnit. */
  threshold?: number;

  /**
   * Default true for `kind: motion`. Set false for informational
   * rows that should never fire (replaces the internal Infinity
   * sentinel from v1.6.0).
   */
  triggerEnabled?: boolean;

  /**
   * 'above' or 'below'. Default 'above'. Only meaningful for
   * `kind: motion`; ignored with warn on other kinds.
   */
  triggerDirection?: 'above' | 'below';

  /** Display unit override. Must be legal for the row's measurement. */
  displayUnit?: SensorUnit;

  /**
   * For CUSTOM dataPoints only. Declares the unit the AWN payload
   * reports in. Ignored for known defaults. Not applicable to boolean
   * measurements; fixed to 'ms' for timestamp.
   */
  sourceUnit?: SensorUnit;

  /**
   * AWN batt* field driving the Battery sub-service. `null` explicitly
   * suppresses a Battery sub-service that the plugin default would
   * attach.
   */
  batteryField?: string | null;

  /**
   * Show the live value in the tile name (embed mode). Default false.
   * Only affects `kind: motion`.
   */
  embedName?: boolean;

  /**
   * Absent or true = enabled. False = the entire accessory (and its
   * Battery sub-service) is NOT registered.
   */
  enabled?: boolean;
}

/**
 * Default sensor map row — the plugin's built-in knowledge about a
 * specific AWN datapoint. Lives in `defaultMap.ts` (code, not config).
 *
 * `canonicalForBattery` marks the ONE row per batteryField that gets
 * the Battery sub-service. Other rows sharing the same batteryField
 * (e.g., all sensors on the outdoor combo array sharing `battout`)
 * carry the field for identity purposes but don't attach a sub-service
 * — keeps Apple Home from showing 30+ battery tiles per station.
 */
export interface DefaultSensorRow {
  dataPoint: string;
  kind: Exclude<SensorKind, 'unrecognized'>;
  measurement: Measurement;
  wrapper: WrapperDescriptor;
  name: string;
  sourceUnit: SensorUnit;
  displayUnit: SensorUnit;
  batteryField: string | null;
  /** True iff this row is the canonical sensor for its batteryField. */
  canonicalForBattery: boolean;
  threshold?: number;
  triggerEnabled?: boolean;
  triggerDirection?: 'above' | 'below';
  embedName?: boolean;
}

/**
 * Stable identifier for the wrapper class implementing a specific
 * `(kind, measurement)` combination. Stable `id` lets the structural
 * signature survive TypeScript-level class renames (see §9 of design).
 * Per-wrapper `schemaVersion` allows bumping one wrapper's version to
 * trigger re-registration of only that wrapper's accessories.
 *
 * The `constructor` field references the actual accessory class at
 * runtime. Kept typed loosely because concrete wrapper classes span
 * multiple modules with divergent constructor signatures — the runtime
 * consumer (createSensorWrapper in the platform, added in a later
 * stage) uses the row's `wrapper` to pick the right ctor.
 */
/**
 * The 25 wrapper ids that ship in v2.0. Frozen at GA — renaming any
 * of these silently invalidates every user's HAP accessory cache
 * because the id is baked into `structuralSignature`. The registry
 * itself lives in `wrappers.ts`; the union here exists so
 * `WrapperDescriptor.id` is a specific literal rather than an open
 * `string` (which would let a well-meaning rename slip through
 * without a test failure — see review finding #14).
 *
 * Adding a wrapper id (v2.1+) is safe: extend this union in the same
 * commit as the descriptor. Removing or renaming one is a breaking
 * change and must bump the plugin major.
 */
export type WrapperId =
  | 'temperature'
  | 'humidity'
  | 'solar-radiation'
  | 'co2'
  | 'air-quality-pm25'
  | 'air-quality-pm10'
  | 'uv'
  | 'wind-speed'
  | 'wind-gust'
  | 'wind-max-daily-gust'
  | 'wind-direction'
  | 'wind-direction-10m'
  | 'pressure-relative'
  | 'pressure-absolute'
  | 'rain-rate'
  | 'rain-event'
  | 'rain-daily'
  | 'rain-weekly'
  | 'rain-monthly'
  | 'rain-yearly'
  | 'last-rain'
  | 'lightning-day'
  | 'lightning-hour'
  | 'lightning-distance'
  | 'lightning-last-strike';

export interface WrapperDescriptor {
  /**
   * Stable identifier. Refactor-safe (a class rename does NOT change
   * this). Kebab-case, drawn from the frozen `WrapperId` union.
   * Baked into `structuralSignature`. `readonly` prevents an
   * accidental in-place mutation from silently invalidating caches.
   */
  readonly id: WrapperId;

  /**
   * Version of the wrapper's HAP service graph. Bump when a wrapper's
   * characteristics change in a way that would invalidate an existing
   * cached accessory's service graph. Readonly for the same reason
   * `id` is.
   */
  readonly schemaVersion: number;

  /**
   * Reference to the accessory-wrapper class. Concrete classes have
   * divergent constructor signatures; the runtime consumer narrows.
   */
  readonly constructor: unknown;
}

/**
 * Fully-resolved runtime row after defaults + compat + overrides are
 * merged. Discriminated union: unrecognized rows carry only observational
 * metadata and don't have units; numeric configured rows require both
 * source and display units; timestamp rows have fixed `sourceUnit: 'ms'`
 * and no display unit; boolean rows have no units at all.
 *
 * The type system makes invalid combinations unrepresentable at compile
 * time (e.g., a boolean row cannot accidentally carry `displayUnit`).
 */
export type EffectiveSensorRow =
  | UnrecognizedRow
  | NumericSensorRow
  | TimestampSensorRow
  | BooleanSensorRow;

interface CommonMeta {
  dataPoint: string;
  stationMac: string;
  /** ISO-8601. Absent when configured before the station has reported the field. */
  firstSeen?: string;
  lastSeen?: string;
  lastValue?: unknown;
}

export interface UnrecognizedRow extends CommonMeta {
  kind: 'unrecognized';
  enabled: false;
  // Observational metadata is required — an unrecognized row exists
  // only because something reported it.
  firstSeen: string;
  lastSeen: string;
}

interface ConfiguredRowBase extends CommonMeta {
  kind: Exclude<SensorKind, 'unrecognized'>;
  name: string;
  threshold?: number;
  triggerEnabled: boolean;
  triggerDirection: 'above' | 'below';
  batteryField: string | null;
  /**
   * True iff a HAP Battery sub-service is attached to this accessory.
   * Bookkept separately from `batteryField` because a row can carry
   * a batteryField for row identity WITHOUT hosting the sub-service
   * (non-canonical rows sharing a probe's battery — see §9 of design).
   * Structural-signature input.
   */
  hasBatterySubService: boolean;
  embedName: boolean;
  enabled: boolean;
  /** See §9 of design; format is `${kind}|measurement:${m}|battery:${0|1}|wrapper:${id}:v${version}`. */
  structuralSignature: string;
  /**
   * Stable id of the wrapper descriptor this row resolves to.
   * Drawn from the frozen `WrapperId` union so TypeScript rejects
   * any assignment of an unregistered id — the same closure the
   * descriptor registry itself has. Redundant with
   * `structuralSignature` but explicit for consumers that need the
   * wrapper without re-parsing the signature.
   */
  wrapperId: WrapperId;
}

export interface NumericSensorRow extends ConfiguredRowBase {
  measurement: Exclude<Measurement, 'timestamp' | 'boolean'>;
  sourceUnit: SensorUnit;
  displayUnit: SensorUnit;
}

export interface TimestampSensorRow extends ConfiguredRowBase {
  measurement: 'timestamp';
  sourceUnit: 'ms';
  displayUnit?: never;
}

export interface BooleanSensorRow extends ConfiguredRowBase {
  measurement: 'boolean';
  sourceUnit?: never;
  displayUnit?: never;
}

/**
 * Runtime station identity. Populated from AWN's device list or
 * (per §8.7) from the accessory cache / discovery store when AWN is
 * unavailable at bootstrap.
 */
export interface StationRecord {
  macAddress: string;
  name: string;
}

export type StationInventory = ReadonlyArray<StationRecord>;

/**
 * Observational entry — one row per (stationMac, dataPoint) the plugin
 * has seen AWN report. See §8.3 of design.
 */
export interface DiscoveredFieldRecord {
  stationMac: string;
  stationName: string;
  dataPoint: string;
  firstSeen: string;
  lastSeen: string;
}

export interface DiscoveryStore {
  schemaVersion: 1;
  entries: DiscoveredFieldRecord[];
}

/**
 * "Forget this field" entries suppress auto-discovery of a specific
 * (stationMac, dataPoint) — the row won't show up as unrecognized
 * until the user removes the entry via the UI. See §9.4.
 */
export interface ForgottenField {
  stationMac: string;
  dataPoint: string;
  forgottenAt: string;
}

export interface UiStateStore {
  schemaVersion: 1;
  dismissedNoticeIds: string[];
  forgottenFields: ForgottenField[];
}

/**
 * Structural-change notice — appended when re-registration occurs.
 * See §8.4.
 */
export interface SensorMapNotice {
  id: string;
  type: 'structural-change';
  stationMac: string;
  dataPoint: string;
  oldSignature?: string;
  newSignature: string;
  occurredAt: string;
}

export interface NoticeStore {
  schemaVersion: 1;
  notices: SensorMapNotice[];
}

/**
 * Row-level validation failure. Attached to the effective-map result
 * so the UI can surface these in the "needs attention" group per
 * §3.7. Never fails the plugin as a whole.
 *
 * `code` is a stable machine-readable identifier — required, so UI
 * consumers can group / filter / dedup without parsing `message`.
 * The set of codes is defined by validation.ts's `err()` call sites;
 * kept as `string` here (not a union) to keep the type simple, but
 * every producing site is required to set one.
 *
 * `field` names the offending key when the failure is field-scoped —
 * usually a SensorMapOverride field, but for `unknown-key` /
 * `wrapper-id-forbidden` it's the offending input key even though
 * it's outside the vocabulary. Attribution flows through the same
 * per-field merge provenance used for warnings, so `overrideIndex`
 * points at the fragment that actually contained the bad key /
 * value, not just the last-merge-wins fragment.
 *
 * Truly row-scope failures — kind × measurement incompatibility, a
 * required field missing after merge — leave `field` unset and fall
 * back to the last fragment.
 */
export interface RowValidationError {
  /**
   * Which override entry failed. For field-scoped errors, this is
   * the fragment whose value for `field` was the offending one after
   * merge; for row-scope errors it's the last fragment (whose
   * conflict-winning fields make up the merged view).
   */
  overrideIndex: number;
  /** Stable machine-readable identifier for the failure class. */
  code: string;
  /** The offending key, when the failure is field-scoped. */
  field?: string;
  /** dataPoint of the offending entry, or undefined if the entry has none. */
  dataPoint?: string;
  /** stationMac from the entry, or undefined for global overrides. */
  stationMac?: string;
  /** Human-readable message; stable enough for tests. */
  message: string;
}

/**
 * Result of `buildEffectiveSensorMap`. `rows` are the resolved
 * accessory rows (one per station+dataPoint pair for which the row
 * is representable). `errors` accumulates row-level failures; the
 * plugin loads valid rows regardless.
 */
/**
 * Non-fatal warning emitted during row-level validation. Attached to
 * the effective-map result so the UI can surface them in a "needs
 * attention" group per §3.7 (ignored-with-warn fields, ambiguous
 * config-mode signals, etc.). Distinct from `RowValidationError`,
 * which is a row rejection.
 *
 * `code` is a stable machine-readable identifier — UI can group,
 * filter, dedup on it without parsing `message`. `field` names the
 * offending SensorMapOverride field when the warning is about a
 * specific field (which is most of them).
 *
 * `overrideIndex` points to the fragment that CAUSED the warning
 * for merged-duplicate rows. When a warning is about a specific
 * `field`, the index is the fragment whose value for that field
 * survived the merge (i.e., who's actually responsible). For
 * whole-row warnings (like "duplicate entries merged"), the index
 * is the first fragment's — the one users typically scroll to first.
 */
export interface RowValidationWarning {
  overrideIndex: number;
  code: string;
  field?: string;
  dataPoint?: string;
  stationMac?: string;
  message: string;
}

export interface EffectiveSensorMap {
  rows: EffectiveSensorRow[];
  errors: RowValidationError[];
  warnings: RowValidationWarning[];
}

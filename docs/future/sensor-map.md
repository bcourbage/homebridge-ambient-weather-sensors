# Sensor Map — Design for v2.0

**Status:** Design approved for implementation. Five implementation acceptance criteria captured in §16.
**Last revised:** 2026-07-13 (approved after fifth external review — see §17 decision log).
**Implementation phase:** Beta cycle target 2.0.0-beta.0 begins after this doc is signed off; GA target 2.0.0 after test-suite refactor completes.

## 1. Motivation

The plugin has grown three overlapping configuration concerns over v1.5.0 and v1.6.0:

1. **Which sensors to expose** — per-category toggles + `excludeSensors` + `includeOnly` + `stationFilter`
2. **How sensors are named** — no config field today; users rename in Apple Home
3. **Which HomeKit sensor type each AWN field maps to** — hardcoded in `determineSensorType()`; users cannot influence this

All three collapse into a single question: **what HomeKit accessory should each AWN datapoint produce?**

The proposal is a **unified sensor map** — a declarative model where each row expresses that question for one AWN datapoint on one station. The plugin ships built-in defaults matching current v1.6.0 behavior exactly; auto-discovery adds rows for AWN fields the plugin doesn't know about; users edit rows through a custom Angular-based configuration UI.

Reference plugins whose approaches informed the design:

- **valiquette/homebridge-Ambient-realtime** — user-defined custom sensors via a `sensors: []` array; no auto-discovery; no default map
- **rhockenbury/homebridge-ecowitt-weather-sensors** — separate `nameOverrides` + `customHidden` fields; no user-defined sensor kinds
- **hjdhjd/homebridge-unifi-protect** — auto-discovered devices in Homebridge's accessory cache; user overrides as terse strings; custom Angular UI in `homebridge-ui/`; separate discovery store

## 2. Non-goals

- **Not a rewrite of the accessory-wrapper layer**. All existing v1.6.0 wrapper classes stay as-is. No consolidation, no renaming, no shape changes. The sensor map records the exact wrapper class per dataPoint via a stable descriptor (§3.9).
- **Not adding new HAP characteristics**. The kind vocabulary is exactly the HAP-native sensor services that already work.
- **Not changing the AWN API integration**. Polling + realtime paths stay the same.
- **Not changing `stationFilter` or child-bridge multi-Home behavior**. Orthogonal; stays as-is.

## 3. Data model

### 3.1 SensorKind — HAP wrapper family selector

Twelve values, each corresponding to a HAP-native sensor service family.

**Value tiles:** `temperature`, `humidity`, `light`, `co2`, `co`, `air-quality-pm25`, `air-quality-pm10`.

**State tiles:** `motion`, `leak`, `contact`, `occupancy`.

**Special:** `unrecognized` — auto-discovery sentinel. Does NOT produce a HomeKit accessory until the user assigns a real kind.

### 3.2 Measurement — physical dimension

Independent of `kind`. Determines allowed units, threshold interpretation, conversion, AND wrapper subtype selection when `kind` is ambiguous.

```typescript
type Measurement =
  | 'temperature'          | 'humidity'
  | 'illuminance'          | 'co2' | 'co'
  | 'pm25'                 | 'pm10'
  | 'wind-speed'           | 'rain-rate'
  | 'rain-accumulation'    | 'pressure'
  | 'distance'             | 'uv-index'
  | 'count'                | 'direction'
  | 'timestamp'
  | 'boolean';
```

For known defaults, both `kind` and `measurement` are baked into the default map. For custom (unrecognized) rows, the user must declare BOTH before activation, subject to the compatibility table in §3.8.

**`kind: motion` requires `measurement` to disambiguate the wrapper** — see §3.9.

### 3.3 SensorMapOverride — public config schema

Users write these into `config.json`. Only fields the user has explicitly set appear:

```typescript
interface SensorMapOverride {
  // Required.
  dataPoint: string;

  // Optional — restrict to one station. Strict MAC format; name-shaped
  // values are REJECTED at validation (§3.7).
  stationMac?: string;

  // Optional — override the default kind. Required for custom (unrecognized)
  // dataPoints. For known dataPoints, permitted only when the new kind
  // is compatible with the built-in measurement (§3.8).
  kind?: SensorKind;

  // Optional — measurement dimension. Required for custom dataPoints
  // alongside kind. IGNORED for known dataPoints (measurement is fixed
  // at the default-map level).
  measurement?: Measurement;

  // Optional.
  name?: string;

  // Optional — motion-trigger threshold (numeric, stored in sourceUnit).
  threshold?: number;

  // Optional — default true for kind: motion. Set false for informational
  // rows that should never fire. Replaces v1.6.0 Infinity sentinel.
  triggerEnabled?: boolean;

  // Optional — 'above' | 'below'. Default 'above'. Only meaningful for
  // kind: motion; ignored on other kinds with warn.
  triggerDirection?: 'above' | 'below';

  // Optional — display unit override. Must be legal for the row's
  // measurement (§3.5). Not applicable to boolean / timestamp
  // measurements — see §3.5.
  displayUnit?: SensorUnit;

  // Optional — for CUSTOM dataPoints. Declares AWN's reported unit.
  // Ignored for known defaults. Not applicable to boolean measurements;
  // fixed to 'ms' for timestamp.
  sourceUnit?: SensorUnit;

  // Optional — AWN batt* field. Set to null to explicitly suppress
  // a Battery sub-service that the plugin default would attach.
  batteryField?: string | null;

  // Optional — show live value in tile name. Default false. Only
  // affects kind: motion.
  embedName?: boolean;

  // Optional — explicit disable. Absent or true = enabled. False =
  // the entire accessory (and its Battery sub-service) is NOT registered.
  enabled?: boolean;
}
```

#### 3.3.1 Station identity — strict MAC validation

`stationMac` MUST match `/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i`. Any other value → row-level failure (§3.7). No best-effort name resolution.

Manually-edited configs with names are surfaced to the user via the UI's "needs attention" path. The UI's station picker offers to replace the value with the correct MAC.

#### 3.3.2 Uniqueness — one override per key

**Invariant:** `sensorMap` contains at most ONE override per `(dataPoint, stationMac?)` key. Global (`stationMac` absent) and station-specific overrides for the same dataPoint are DIFFERENT keys and both may coexist.

The UI ALWAYS serializes to a canonical single-entry-per-key form. Multi-field updates consolidate into one entry:

```jsonc
// Canonical — one entry combining threshold + displayUnit for the same key
{ "dataPoint": "windspeedmph", "threshold": 30, "displayUnit": "kph" }
```

**Hand-edited duplicates:** if `config.json` contains multiple entries for the same key (e.g., a user editing by hand), the plugin merges them in array order with later fields winning (later entries override earlier ones field-by-field), emits a warn identifying the specific key, and canonicalizes on the next UI save.

### 3.4 EffectiveSensorRow — internal representation, discriminated by measurement shape

The type is discriminated first on `kind === 'unrecognized'`, then on the measurement's unit shape:

```typescript
type EffectiveSensorRow =
  | UnrecognizedRow
  | NumericRow
  | TimestampRow
  | BooleanRow;

interface CommonMeta {
  dataPoint: string;
  stationMac: string;
  // Observational metadata — OPTIONAL on configured rows (row may be
  // configured before the station reports the field).
  firstSeen?: string;
  lastSeen?: string;
  lastValue?: unknown;
}

interface UnrecognizedRow extends CommonMeta {
  kind: 'unrecognized';
  enabled: false;
  // Unrecognized rows exist because something reported them;
  // observational metadata is present.
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
  embedName: boolean;
  enabled: boolean;
  structuralSignature: string;
}

interface NumericRow extends ConfiguredRowBase {
  measurement: Exclude<Measurement, 'timestamp' | 'boolean'>;
  sourceUnit: SensorUnit;
  displayUnit: SensorUnit;
}

interface TimestampRow extends ConfiguredRowBase {
  measurement: 'timestamp';
  sourceUnit: 'ms';
  displayUnit?: never;   // rendered as relative time; no display unit
}

interface BooleanRow extends ConfiguredRowBase {
  measurement: 'boolean';
  sourceUnit?: never;
  displayUnit?: never;
}
```

TypeScript's discriminant narrowing enforces at compile time:
- Boolean rows cannot carry `sourceUnit` or `displayUnit`
- Timestamp rows have `sourceUnit: 'ms'` fixed; no display unit
- Numeric rows require both units
- Unrecognized rows carry no configured fields

Invalid states are unrepresentable.

**Custom dataPoint activation rules** (§3.7):
- Boolean-measurement custom: user provides `kind` + `measurement: 'boolean'`. `sourceUnit` and `displayUnit` are not applicable; if either is provided, the plugin logs a warn identifying the row and ignores the field. The row still loads.
- Timestamp-measurement custom: user provides `kind: 'motion'` + `measurement: 'timestamp'`. `sourceUnit` if provided must be `'ms'` (any other value is a row-level failure). `displayUnit` is not applicable; if provided, warn is logged and the field is ignored.
- Numeric-measurement custom: user provides `kind` + `measurement` + `sourceUnit`. `displayUnit` defaults to the measurement's default if not specified.

Rationale for warn-and-ignore rather than silent normalization: the plugin's overall philosophy is to make user-visible problems discoverable via the "needs attention" UI group. Silent normalization would hide the mistake; a warn log surfaces it without breaking the row.

### 3.5 Unit compatibility — allowed by measurement

The allowed-unit set for each numeric `measurement`:

| Measurement | Legal units | Default source | Default display | Conversion |
|---|---|---|---|---|
| `temperature` | fahrenheit, celsius | fahrenheit | fahrenheit | °F↔°C |
| `humidity` | percent | percent | percent | — |
| `illuminance` | wm2, lux | wm2 (solar), lux (other) | lux | W/m² × 127 → lux |
| `co2` / `co` | ppm | ppm | ppm | — |
| `pm25` / `pm10` | ugm3 | ugm3 | ugm3 | — |
| `wind-speed` | mph, kph, mps, kts | mph | mph | linear |
| `rain-rate` | in_per_hr, mm_per_hr | in_per_hr | in_per_hr | ×25.4 |
| `rain-accumulation` | in, mm | in | in | ×25.4 |
| `pressure` | inHg, hPa | inHg | inHg | ×33.8639 |
| `distance` | mi, km, nm | mi | mi | linear |
| `uv-index` | index | index | index | — |
| `count` | count | count | count | — |
| `direction` | degrees | degrees | degrees | — |

Special cases:
- `timestamp`: `sourceUnit: 'ms'`, no display unit (rendered as relative time)
- `boolean`: no units

Plugin ships `LEGAL_UNITS_FOR_MEASUREMENT: Record<Measurement, SensorUnit[] | 'none'>`.

Thresholds are always stored in `sourceUnit`. Display conversion happens at render time only.

### 3.6 Trigger semantics

`kind: motion` rows have `triggerDirection` (default 'above') and `triggerEnabled` (default true). Wind / rain / UV / gust default 'above'; pressure and lightning distance default 'below'.

`triggerEnabled: false` = row's motion state never fires. JSON-safe replacement for v1.6.0's internal `Infinity` sentinel.

### 3.7 Row validation and failure handling

Row-level failures never fail the whole plugin. Every valid row still loads. Invalid rows surface in the UI's "needs attention" group.

| Failure | Handling |
|---|---|
| `dataPoint` missing or empty | Row rejected. Warn: `sensorMap entry with no dataPoint; skipping`. |
| `kind: unrecognized` set explicitly by user | Ignored — kind is auto-inferred for unrecognized fields. |
| `stationMac` present but not MAC-shaped (per §3.3.1) | Row-level failure. UI surfaces with `stationMac 'Cabin' is not a MAC address. Use the station picker.` |
| `stationMac` MAC-shaped but no station currently reports it AND no cached / discovered reference | Row loaded but flagged "waiting for station". Activates when the station starts reporting. |
| Custom `dataPoint` missing required fields for its measurement shape (§3.4) | Row-level failure. Error message identifies the missing field. |
| `displayUnit` not in the row's `measurement`'s legal set (numeric only) | Row-level failure. |
| `displayUnit` or `sourceUnit` provided on a boolean-measurement row | Ignored with warn. Row still loads. |
| `displayUnit` provided on a timestamp-measurement row | Ignored with warn. Row still loads. |
| `sourceUnit` provided as anything other than `'ms'` on a timestamp row | Row-level failure. |
| `wrapperId` field in an override entry | Rejected as unknown field. Row-level failure. `wrapperId` is not part of the v2.0 public schema; see §3.9. |
| Known `dataPoint` with `kind` override incompatible with built-in measurement (§3.8) | Row-level failure. |
| `triggerDirection` set on non-motion kind | Ignored with warn. |
| `threshold` or `triggerEnabled` set on non-motion kind | Ignored with warn. Row still loads. |
| `embedName: true` on non-motion kind | Ignored with warn. Row still loads. |
| Duplicate override for same `(dataPoint, stationMac?)` key | Merged in array order with later-wins; warn; canonicalized on next UI save. |
| Invalid `configVersion` value type (string, negative, NaN) | Row-level failure surfaces in UI; per §5 the plugin enters safe mode. |
| JSON parse failure of `config.json` overall | Whole-plugin startup failure (Homebridge's own behavior). |
| Missing `apiKey` / `applicationKey` | Whole-plugin startup failure (existing v1.6.0 behavior; unchanged). |

### 3.8 Kind changes on known datapoints — remapping rules

Known datapoints retain their built-in `measurement` and `sourceUnit`. Users can override `kind` only within the compatible set for the datapoint's measurement:

| Measurement | Compatible kinds |
|---|---|
| `temperature` | `temperature` (only) |
| `humidity` | `humidity` (only) |
| `illuminance` | `light` (only) |
| `co2` | `co2` (only) |
| `co` | `co` (only) |
| `pm25` | `air-quality-pm25` (only) |
| `pm10` | `air-quality-pm10` (only) |
| `wind-speed`, `rain-rate`, `rain-accumulation`, `pressure`, `distance`, `uv-index`, `count`, `direction`, `timestamp` | `motion` (only) |
| `boolean` | `leak`, `contact`, `occupancy` |

For most measurements, kind is effectively fixed. The only user choice is on `measurement: boolean` where three state-tile kinds render similarly — user picks semantic meaning.

Custom datapoints declare all three (`kind`, `measurement`, and — for numeric measurements — `sourceUnit`) at row creation.

Changing measurement on a known datapoint is not supported. The design does not permit re-interpreting a temperature value as humidity by config.

### 3.9 Wrapper selection — stable descriptors, no consolidation

Every existing v1.6.0 wrapper class stays as-is. The default map declares each dataPoint's wrapper via a `WrapperDescriptor`:

```typescript
interface WrapperDescriptor {
  id: string;                                    // stable, refactor-safe identifier
  schemaVersion: number;                         // bumped when the HAP graph changes
  constructor: WrapperClass;                     // the actual class to instantiate
}
```

Descriptors are declared as module-level constants:

```typescript
const TEMPERATURE_WRAPPER: WrapperDescriptor        = { id: 'temperature',           schemaVersion: 1, constructor: TemperatureAccessory };
const HUMIDITY_WRAPPER: WrapperDescriptor           = { id: 'humidity',              schemaVersion: 1, constructor: HumidityAccessory };
const SOLAR_RADIATION_WRAPPER: WrapperDescriptor    = { id: 'solar-radiation',       schemaVersion: 1, constructor: SolarRadiationAccessory };
const CO2_WRAPPER: WrapperDescriptor                = { id: 'co2',                   schemaVersion: 1, constructor: Co2Accessory };
const AIR_QUALITY_PM25_WRAPPER: WrapperDescriptor   = { id: 'air-quality-pm25',      schemaVersion: 1, constructor: AirQualityAccessory };  // variant handled by ctor
const AIR_QUALITY_PM10_WRAPPER: WrapperDescriptor   = { id: 'air-quality-pm10',      schemaVersion: 1, constructor: AirQualityAccessory };
const WIND_SPEED_WRAPPER: WrapperDescriptor         = { id: 'wind-speed',            schemaVersion: 1, constructor: WindSpeedAccessory };
const WIND_GUST_WRAPPER: WrapperDescriptor          = { id: 'wind-gust',             schemaVersion: 1, constructor: WindGustAccessory };
const WIND_MAX_DAILY_GUST_WRAPPER: WrapperDescriptor= { id: 'wind-max-daily-gust',   schemaVersion: 1, constructor: WindMaxDailyGustAccessory };
const WIND_DIRECTION_WRAPPER: WrapperDescriptor     = { id: 'wind-direction',        schemaVersion: 1, constructor: WindDirectionAccessory };
const WIND_DIRECTION_10M_WRAPPER: WrapperDescriptor = { id: 'wind-direction-10m',    schemaVersion: 1, constructor: WindDirection10mAccessory };
const RAIN_RATE_WRAPPER: WrapperDescriptor          = { id: 'rain-rate',             schemaVersion: 1, constructor: RainRateAccessory };
const RAIN_EVENT_WRAPPER: WrapperDescriptor         = { id: 'rain-event',            schemaVersion: 1, constructor: RainEventAccessory };
const RAIN_DAILY_WRAPPER: WrapperDescriptor         = { id: 'rain-daily',            schemaVersion: 1, constructor: RainDailyAccessory };
const RAIN_WEEKLY_WRAPPER: WrapperDescriptor        = { id: 'rain-weekly',           schemaVersion: 1, constructor: RainWeeklyAccessory };
const RAIN_MONTHLY_WRAPPER: WrapperDescriptor       = { id: 'rain-monthly',          schemaVersion: 1, constructor: RainMonthlyAccessory };
const RAIN_YEARLY_WRAPPER: WrapperDescriptor        = { id: 'rain-yearly',           schemaVersion: 1, constructor: RainYearlyAccessory };
const LAST_RAIN_WRAPPER: WrapperDescriptor          = { id: 'last-rain',             schemaVersion: 1, constructor: LastRainAccessory };
const PRESSURE_RELATIVE_WRAPPER: WrapperDescriptor  = { id: 'pressure-relative',     schemaVersion: 1, constructor: PressureRelativeAccessory };
const PRESSURE_ABSOLUTE_WRAPPER: WrapperDescriptor  = { id: 'pressure-absolute',     schemaVersion: 1, constructor: PressureAbsoluteAccessory };
const UV_WRAPPER: WrapperDescriptor                 = { id: 'uv',                    schemaVersion: 1, constructor: UvAccessory };
const LIGHTNING_DAY_WRAPPER: WrapperDescriptor      = { id: 'lightning-day',         schemaVersion: 1, constructor: LightningDayAccessory };
const LIGHTNING_HOUR_WRAPPER: WrapperDescriptor     = { id: 'lightning-hour',        schemaVersion: 1, constructor: LightningHourAccessory };
const LIGHTNING_DISTANCE_WRAPPER: WrapperDescriptor = { id: 'lightning-distance',    schemaVersion: 1, constructor: LightningDistanceAccessory };
const LIGHTNING_TIME_WRAPPER: WrapperDescriptor     = { id: 'lightning-last-strike', schemaVersion: 1, constructor: LightningLastStrikeAccessory };
```

25 descriptors — one for every accessory wrapper class the plugin ships. The `ALL_WRAPPERS` ordered array in `src/sensorMap/wrappers.ts` and the snapshot test in `tests/unit/sensorMap/wrappers.test.ts` are the authoritative list; this section mirrors it. No consolidation from v1.6.0.

Each entry in `DEFAULT_SENSOR_MAP` references its wrapper directly:

```typescript
{ dataPoint: 'tempf',        kind: 'temperature', measurement: 'temperature', wrapper: TEMPERATURE_WRAPPER,      name: 'Outdoor Temperature',  batteryField: 'battout', ... },
{ dataPoint: 'windgustmph',  kind: 'motion',      measurement: 'wind-speed',  wrapper: WIND_GUST_WRAPPER,        name: 'Wind Gust',            batteryField: 'battout', threshold: 35, ... },
{ dataPoint: 'baromabsin',   kind: 'motion',      measurement: 'pressure',    wrapper: PRESSURE_ABSOLUTE_WRAPPER, name: 'Pressure Station',    batteryField: 'battin', threshold: 29.5, triggerDirection: 'below', ... },
```

For CUSTOM datapoints (not in the default map), the wrapper is chosen from a canonical `(kind, measurement)` → descriptor lookup. This table is the ONLY way custom sensors pick a wrapper — there is no public `wrapperId` override in v2.0.

| `(kind, measurement)` for custom sensor | Canonical wrapper |
|---|---|
| `(temperature, temperature)` | TEMPERATURE_WRAPPER |
| `(humidity, humidity)` | HUMIDITY_WRAPPER |
| `(light, illuminance)` | SOLAR_RADIATION_WRAPPER |
| `(co2, co2)` | CO2_WRAPPER |
| `(air-quality-pm25, pm25)` | AIR_QUALITY_PM25_WRAPPER |
| `(air-quality-pm10, pm10)` | AIR_QUALITY_PM10_WRAPPER |
| `(motion, wind-speed)` | WIND_SPEED_WRAPPER |
| `(motion, rain-rate)` | RAIN_RATE_WRAPPER |
| `(motion, rain-accumulation)` | RAIN_EVENT_WRAPPER |
| `(motion, pressure)` | PRESSURE_ABSOLUTE_WRAPPER |
| `(motion, distance)` | LIGHTNING_DISTANCE_WRAPPER |
| `(motion, uv-index)` | UV_WRAPPER |
| `(motion, count)` | LIGHTNING_DAY_WRAPPER |
| `(motion, direction)` | WIND_DIRECTION_WRAPPER |
| `(motion, timestamp)` | LAST_RAIN_WRAPPER |
| `(leak, boolean)` | LEAK_WRAPPER (new; introduced when leak/contact/occupancy support ships) |
| `(contact, boolean)` | CONTACT_WRAPPER |
| `(occupancy, boolean)` | OCCUPANCY_WRAPPER |

The wrapper class names carry v1.6.0 provenance (e.g., a custom count sensor uses the "lightning-day" wrapper class internally) but the wrapper's rendering is generic within its `(kind, measurement)` combination — the class name doesn't leak to the user through HomeKit or the UI. Users see the display name they set, not the wrapper class.

If a user's custom sensor doesn't fit any canonical wrapper cleanly (e.g., they want a pressure-relative wrapper for a custom pressure sensor), they file an issue. A user-facing `wrapperId` override is deferred to a v2.1+ project with its own validation, canonicalization, and UI treatment. Not in v2.0.

Bumping a descriptor's `schemaVersion` re-registers only accessories using THAT descriptor.

## 4. Config schema

`config.json` sensor-map fields:

- `configVersion: number` — see §5
- `sensorMap: SensorMapOverride[]` — sparse; canonical one-entry-per-key form

Example (canonical form, no duplicate keys):

```jsonc
{
  "platform": "AmbientWeatherSensors",
  "name": "Ambient Weather",
  "configVersion": 2,
  "apiKey": "…",
  "applicationKey": "…",
  "dataSource": "realtime",
  "stationFilter": ["Fairhills WS-2000"],

  "sensorMap": [
    { "dataPoint": "tempinf", "name": "Backyard Indoor Temp" },
    { "dataPoint": "tempinf", "stationMac": "AA:BB:CC:44:55:66", "name": "Cabin Indoor Temp" },
    { "dataPoint": "lightning_distance", "enabled": false },
    { "dataPoint": "windspeedmph", "threshold": 30, "displayUnit": "kph" },
    { "dataPoint": "lightning_day", "batteryField": null },
    {
      "dataPoint": "soilmoisture1",
      "kind": "humidity",
      "measurement": "humidity",
      "sourceUnit": "percent",
      "name": "Garden Moisture",
      "batteryField": "batt_soil"
    }
  ]
}
```

Note the `windspeedmph` entry combines `threshold` and `displayUnit` — canonical form, one entry per `(dataPoint, stationMac?)` key.

## 5. Config-mode detection

| `configVersion` | Interpretation | Behavior |
|---|---|---|
| Absent | Legacy v1 | Apply compat layer (§6). Absent legacy toggles = v1.6.0 defaults. |
| `2` | Explicit v2 | Start from v2 defaults. Apply `sensorMap`. No compat translation. |
| `2` AND legacy toggles present | Ambiguous | Warn once: `Both configVersion: 2 and legacy toggle <name> are set. configVersion: 2 takes precedence`. |
| Any positive integer > 2 | Future version, plugin outdated | **Safe mode**: log a prominent error asking the user to upgrade the plugin. Keep cached accessories running with their last-known state (via the accessory cache). Do NOT attempt any add/remove based on unrecognized config. Return zero effective sensor-map rows so no config-derived structural change happens. |
| Non-integer (string, negative, NaN, non-number) | Malformed | Configuration error at row-level (§3.7). Plugin enters safe mode as above. |

**Safe mode rationale:** a plugin startup failure means ALL cached accessories vanish from HomeKit. Safe mode keeps them running with last-known values while surfacing the "upgrade the plugin" message. Users lose config editability, not accessories.

**Safe mode is strictly read-only.** While active:

- `config.json` writes from the UI are refused. If the user attempts to save through the UI, the server-side rejects the write with an explanatory error.
- Manual "Refresh from Ambient Weather" is disabled. AWN calls that would mutate discovery state don't happen.
- Row lifecycle actions (Enable / Disable / Remove user override / Forget discovered field) are disabled.
- Notice dismissal remains permitted — it only writes `ui-state.json` (which the plugin reads but doesn't interpret in a schema-version-sensitive way), so an older UI can safely acknowledge notices left by a newer plugin.
- The UI displays a prominent read-only banner:
  > This configuration was written by a newer plugin version. Upgrade the plugin before making changes.

This prevents an older plugin's UI from partially rewriting a newer configuration and corrupting it silently.

**Migration event:** first UI save on a legacy config atomically:
1. Reads effective sensor map (compat-translated)
2. Computes minimal-diff canonical serialization against v2 baseline (§11.3)
3. Writes as sparse canonical `sensorMap[]`
4. Removes legacy fields
5. Sets `configVersion: 2`

Users who never open the UI keep the legacy shape indefinitely. Compat layer runs forever.

## 6. Compat layer (legacy-mode only)

Legacy fields translate to internal sensor-map state. Deterministic, one-shot per boot, nothing written back.

| 1.6.0 field | Value | Effect |
|---|---|---|
| `temperatureSensors` | true/false/absent | All `kind: temperature` → `enabled`. Absent = false. |
| `humiditySensors` | same | Same, for `kind: humidity` |
| `solarRadiationSensors` | same | Same, for `kind: light` (solar rows only) |
| `co2Sensors` | same | Same, for `kind: co2` |
| `airQualitySensors` | same | Same, for pm25 + pm10 |
| `extendedSensors: false` | | All motion-kind rows → `enabled: false` |
| `extendedSensors: true` | | Sub-toggles apply |
| `windSensors` / `rainSensors` / `pressureSensors` / `uvSensors` / `lightningSensors` | | Corresponding rows → `enabled` |
| `thresholds.<foo>Enabled: false` | | Row → `enabled: false` |
| `thresholds.<foo>Mph` / `.InHr` / `.uv` / etc. | numeric | Row's `threshold` set |
| `units.windSpeed` / `.rain` / `.pressure` / `.distance` | e.g. `kph` | Rows' `displayUnit` |
| `extendedDisplayMode: embed` | | All motion-kind rows → `embedName: true` |
| `embedNameUpdateMinIntervalMinutes: N` | | Global setting stays |
| `excludeSensors: ["Foo"]` | | Matching rows → `enabled: false`. `-batt` suffix + raw battery field name matching continues. |
| `includeOnly: [...]` | | Non-matching rows → `enabled: false`. After `excludeSensors`. |
| `stationFilter: [...]` | | Not sensor-map related. Top-level field. |
| `dataSource` | | Not sensor-map related. Top-level field. |

## 7. Effective map construction

Pure function:

```typescript
function buildEffectiveSensorMap(input: {
  defaultMap: DefaultSensorRow[];
  configMode: 'legacy' | 'v2' | 'safe-mode';
  legacyConfig?: LegacyConfig;
  userOverrides: SensorMapOverride[];
  discovery: DiscoveryStore;
  notices: NoticeStore;
  uiState: UiStateStore;
  stations: StationInventory;
}): EffectiveSensorMap
```

Precedence (later overrides earlier):

1. Built-in defaults (global templates, no `stationMac`)
2. Compat-layer transformation (legacy mode only)
3. Global user overrides (`stationMac` absent)
4. Station-specific user overrides (`stationMac` matches)
5. Runtime availability metadata

**Uniqueness pre-processing:** before applying steps 3-4, the merge de-duplicates user overrides by `(dataPoint, stationMac?)` key. Duplicates merge with later-wins field precedence; warn logged.

**Safe-mode:** returns zero effective rows to prevent any structural changes. Existing cached accessories continue via `configureAccessory()` restore; no new add/remove decisions happen.

Output: one `EffectiveSensorRow` per `(stationMac, dataPoint)` pair. Pure — no I/O, no clocks. Deterministic and property-testable (§12).

## 8. Persistence — five surfaces, strict single-writer per file

| Surface | Writer | Readers | Purpose |
|---|---|---|---|
| `config.json` | HB UI X (via UI server), or user via text editor | plugin, UI server | User intent — sparse overrides |
| Homebridge accessory cache | plugin | plugin (on restart) | HomeKit registration state + last-known values |
| `discovery.json` | **plugin only** | plugin, UI server (RO) | Observational — what fields AWN reports |
| `notices.json` | **plugin only** | plugin, UI server (RO) | Structural-change notices |
| `ui-state.json` | **UI server only** | plugin, UI server | Dismissed IDs + forgotten fields |

Persistence path: `api.user.persistPath()/plugin-data/ambient-weather/`.

### 8.1 `config.json` — user intent

Managed by Homebridge. Plugin reads; plugin never writes. UI writes via HB UI X's config APIs.

### 8.2 Homebridge accessory cache

Managed by Homebridge. Plugin restores runtime state from `accessory.context.device`:

```typescript
interface AccessoryContext {
  uniqueId: string;                    // ${macAddress}-${sensorKey}
  displayName: string;
  kind?: SensorKind;                   // NEW in 2.0
  measurement?: Measurement;           // NEW in 2.0
  type?: string;                       // legacy 1.6.0; retained for bootstrap
  structuralSignature?: string;        // NEW in 2.0
  value?: number;
  batteryLow?: boolean;
}
```

### 8.3 Plugin discovery store — observational data

Plugin-owned. Plugin-only writes. Path: `discovery.json`.

```typescript
interface DiscoveryStore {
  schemaVersion: 1;
  entries: DiscoveredFieldRecord[];
}

interface DiscoveredFieldRecord {
  stationMac: string;
  stationName: string;                 // last-known display name
  dataPoint: string;
  firstSeen: string;
  lastSeen: string;
}
```

**Write throttling:**
- Immediate on new station or dataPoint discovery (structural change to the registry)
- Coarser cadence (default 15 minutes) for `lastSeen`-only updates
- Flush pending updates on graceful shutdown via `SIGTERM` handler
- `lastValue` is NOT persisted (in-memory only if needed by UI)

**Atomic writes** via temp-file + rename (details in §8.6).

### 8.4 Plugin notices store — structural-change events

Plugin-owned. Path: `notices.json`.

```typescript
interface NoticeStore {
  schemaVersion: 1;
  notices: SensorMapNotice[];
}

interface SensorMapNotice {
  id: string;
  type: 'structural-change';
  stationMac: string;
  dataPoint: string;
  oldSignature?: string;
  newSignature: string;
  occurredAt: string;
}
```

Plugin appends when a structural re-registration happens (§9). Size-capped (default: 100 most recent) to prevent unbounded growth.

### 8.5 UI-state store — dismissed IDs + forgotten fields

UI-server-owned. Path: `ui-state.json`.

```typescript
interface UiStateStore {
  schemaVersion: 1;
  dismissedNoticeIds: string[];
  forgottenFields: ForgottenField[];
}

interface ForgottenField {
  stationMac: string;
  dataPoint: string;
  forgottenAt: string;
}
```

UI reads both `notices.json` and `ui-state.json`. Visible notices = `notices \ dismissedNoticeIds`. Plugin never touches `ui-state.json`.

Plugin reads `ui-state.json` at the start of each `discoverDevices()` invocation. `forgottenFields` entries suppress corresponding `(stationMac, dataPoint)` combinations from auto-discovery.

### 8.6 Atomic write implementation details

A centralized persistence helper handles all writes. Implementation requirements:

- **Unique temp filenames** using `<name>.<pid>.<random>.tmp` to avoid collisions across processes
- **Cleanup of stale `.tmp` files** on startup: any `<name>.*.tmp` older than 1 hour is removed
- **File permissions** match Homebridge's own persistence files (0640 on Unix; inherit on Windows)
- **`fsync` before rename** for durability on power-loss scenarios (behind a `PERSIST_FSYNC=1` env flag; defaults false for performance)
- **Cross-platform rename** — POSIX `rename()` atomically replaces existing files; Windows `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` equivalent used via Node's `fs.rename`. Fallback to unlink + rename with warn if platform doesn't support atomic replace.
- **Corrupt-file quarantine** — on read, if the file is missing, malformed, or has unrecognized `schemaVersion`:
  1. Rename to `<name>.corrupt-<ISO-8601-timestamp>.json` (preserves evidence)
  2. Log a warn including the quarantine path
  3. Start with an empty in-memory store
  4. Continue normally

### 8.7 Station inventory sources when AWN unavailable

`buildEffectiveSensorMap` takes `stations: StationInventory`. UI server produces this by unioning, in preference order:

1. Current AWN response (if a poll or refresh succeeded recently)
2. Discovery registry (`discovery.json`)
3. Accessory cache — station MACs from cached `uniqueId` prefixes
4. `stationMac` values in `config.json` overrides

Stations for which AWN isn't currently reporting appear grayed with "not currently reporting" in the UI. Display names come from the freshest available source.

## 9. Structural signature and re-registration

Fields that affect the HAP service graph:
- `kind`
- `measurement` (determines wrapper subtype under `kind: motion`)
- `batteryField` presence/absence
- Wrapper `schemaVersion`

**Signature — human-readable, uses stable wrapper `id`:**

```typescript
function structuralSignature(row: EffectiveSensorRow): string {
  if (row.kind === 'unrecognized') return 'unrecognized';
  const hasBattery = attachesBatterySubService(row) ? '1' : '0';
  const wrapper = wrapperFor(row);   // uses (kind, measurement, dataPoint) lookup
  return `${row.kind}|measurement:${row.measurement}|battery:${hasBattery}|wrapper:${wrapper.id}:v${wrapper.schemaVersion}`;
}
```

Example signatures:
- `temperature|measurement:temperature|battery:1|wrapper:temperature:v1`
- `motion|measurement:wind-speed|battery:1|wrapper:wind-speed:v1`
- `motion|measurement:pressure|battery:1|wrapper:pressure-absolute:v1`

Signature uses `wrapper.id` (stable across refactoring), NOT `wrapper.constructor.name` (which could change with a rename).

### 9.1 Per-wrapper versioning

Bumping `RAIN_RATE_WRAPPER.schemaVersion` from 1 to 2 re-registers ONLY rain-rate accessories. Every other wrapper is unaffected.

### 9.2 Names are NOT structural

`name`, `displayName`, `Name`, `ConfiguredName` — none affect the signature. Handled by `updatePlatformAccessories()` in-place.

### 9.3 Detection

On startup, for each cached accessory:

1. Read `oldSignature` from context (or bootstrap-infer — §11.2)
2. Compute `newSignature` from the effective row
3. Match: update in-place
4. Differ:
   - Log warn: `Structural change for <dataPoint>: <old> → <new>. Re-registering. HomeKit room, automations, custom name will be lost.`
   - Append `SensorMapNotice` to `notices.json`
   - Unregister old accessory, register new

### 9.4 Row lifecycle actions

Three coherent UI actions:

| Action | Applies to | Behavior |
|---|---|---|
| **Enable / Disable** | Any configured row | Toggles `enabled` in the user override. `false` deregisters. `true` re-registers. |
| **Remove user override** | Any row with a `sensorMap` entry | Removes entry. Recomputes effective row. Structural-signature comparison determines in-place update vs re-registration; UI confirms on structural change. |
| **Forget discovered field** | Rows for AWN fields not in the default map | Adds `ForgottenField` to `ui-state.json`. Suppresses auto-discovery for that `(stationMac, dataPoint)`. Reappears if UI removes the entry. |

## 10. Custom Angular UI

### 10.1 Directory layout

```
homebridge-ambient-weather-sensors/
├── homebridge-ui/
│   ├── src/                             # Angular source (committed)
│   ├── dist/                            # Build output (gitignored)
│   ├── server.ts                        # Node bridge source (committed)
│   ├── server.js                        # Compiled (gitignored)
│   ├── tsconfig.json
│   └── angular.json
├── src/
│   ├── awnClient.ts                     # Shared AWN client
│   └── ...
├── config.schema.json                   # Minimal schema-driven fallback
└── package.json
```

Committed: `homebridge-ui/src/`, `server.ts`, tsconfig/angular config. Not committed: `dist/`, `server.js` (in `.gitignore`).

Shipped to npm (added to `package.json` `files`): `homebridge-ui/dist/`, `homebridge-ui/server.js`. Not shipped: source.

Build commands:

```json
"scripts": {
  "build:ui": "cd homebridge-ui && ng build --configuration production && tsc server.ts",
  "build": "…existing plugin build… && npm run build:ui",
  "prepublishOnly": "npm run lint && npm test && npm run build"
}
```

### 10.2 Process boundary

```
Angular front-end ↔ homebridge-ui/server (short-lived) ↔ persistence files ← plugin (long-lived)
```

State passes through five persistence surfaces (§8). No direct IPC.

### 10.3 Shared AWN client

`src/awnClient.ts` — imported by plugin and UI server. Plugin uses on normal polls. UI server uses only on user-initiated "Refresh from Ambient Weather". Credentials never round-trip through the browser.

### 10.4 Front-end responsibilities

- Grouped-row sensor-map table (defaults collapsed, edited/disabled/additional/needs-attention visible)
- Row expansion for editing
- Kind + measurement + unit dropdowns (dropdown options driven by §3.5/§3.8 rules)
- Structural-change confirmation modal (blocks save on kind/measurement change that alters signature)
- Row-level failure surfacing in "needs attention" group
- Enable/Disable / Remove override / Forget discovered field
- Persistent notice banner (`notices \ dismissedNoticeIds`)
- Advanced tab — raw JSON view for `sensorMap`, `triggerDirection`, and seldom-used fields
- Station picker writes MAC to `stationMac` (never a name)
- Canonical serialization: one override entry per `(dataPoint, stationMac?)` key

### 10.5 Schema-driven fallback

`config.schema.json` continues to ship. Users who disable custom UI in HB UI X preferences see a minimal form that lets them edit the raw `sensorMap` array.

## 11. Migration semantics

### 11.1 Default map preserves service types

Every v1.6.0 sensorKey produces the same HAP service in v2.0. Audit (representative rows):

| sensorKey | v1.6.0 service | Legacy `type` | Inferred kind | Measurement | Wrapper | v2.0 service | Match |
|---|---|---|---|---|---|---|---|
| `tempf` .. `dewPoint{N}` | TemperatureSensor | `Temperature` | temperature | temperature | temperature | TemperatureSensor | ✓ |
| `humidity` .. `humidity{N}` | HumiditySensor | `Humidity` | humidity | humidity | humidity | HumiditySensor | ✓ |
| `solarradiation` | LightSensor | `Solar Radiation` | light | illuminance | solar-radiation | LightSensor | ✓ |
| `co2`, `co2_in_aqin` | CarbonDioxideSensor | `CO2` | co2 | co2 | co2 | CarbonDioxideSensor | ✓ |
| `pm25`, `pm25_in_aqin` | AirQualitySensor | `PM2.5` | air-quality-pm25 | pm25 | air-quality-pm25 | AirQualitySensor + PM2_5Density | ✓ |
| `pm10_in_aqin` | AirQualitySensor | `PM10` | air-quality-pm10 | pm10 | air-quality-pm10 | AirQualitySensor + PM10Density | ✓ |
| `windspeedmph` | MotionSensor + WindSpeedAccessory chars | `WindSpeed` | motion | wind-speed | wind-speed | Same | ✓ |
| `windgustmph` | MotionSensor + WindGustAccessory chars | `WindGust` | motion | wind-speed | wind-gust | Same | ✓ |
| `maxdailygust` | MotionSensor + WindMaxDailyGustAccessory chars | `WindMaxDailyGust` | motion | wind-speed | wind-max-daily-gust | Same | ✓ |
| `winddir`, `winddir_avg10m` | MotionSensor + WindDirection*Accessory chars | Wind direction types | motion | direction | wind-direction / wind-direction-10m | Same | ✓ |
| `hourlyrainin` | MotionSensor + RainRateAccessory chars | `RainRate` | motion | rain-rate | rain-rate | Same | ✓ |
| `eventrainin` .. `yearlyrainin` | MotionSensor + Rain*Accessory chars | Individual rain types | motion | rain-accumulation | rain-event/daily/weekly/monthly/yearly | Same | ✓ |
| `lastRain` | MotionSensor + LastRainAccessory chars | `LastRain` | motion | timestamp | last-rain | Same | ✓ |
| `baromrelin` | MotionSensor + PressureRelativeAccessory chars | `PressureRelative` | motion | pressure | pressure-relative | Same | ✓ |
| `baromabsin` | MotionSensor + PressureAbsoluteAccessory chars | `PressureAbsolute` | motion | pressure | pressure-absolute | Same | ✓ |
| `uv` | MotionSensor + UvAccessory chars | `UV` | motion | uv-index | uv | Same | ✓ |
| `lightning_day` | MotionSensor + LightningDayAccessory chars | `LightningDay` | motion | count | lightning-day | Same | ✓ |
| `lightning_hour` | MotionSensor + LightningHourAccessory chars | `LightningHour` | motion | count | lightning-hour | Same | ✓ |
| `lightning_distance` | MotionSensor + LightningDistanceAccessory chars | `LightningDistance` | motion | distance | lightning-distance | Same | ✓ |
| `lightning_time` | MotionSensor + LightningLastStrikeAccessory chars | `LightningLastStrike` | motion | timestamp | lightning-last-strike | Same | ✓ |

All ✓ by construction. Each row uses the same wrapper class it uses in v1.6.0.

### 11.2 Bootstrap rule for existing cached accessories

Existing v1.6.0 cached accessories have no `kind`, `measurement`, or `structuralSignature`. On first v2.0 startup:

```typescript
function inferForCachedAccessory(accessory): { kind: SensorKind; measurement: Measurement } | 'preserve-cached' {
  // Kind: three-level fallback
  const explicitKind = accessory.context.device?.kind;
  const kind = explicitKind
    ?? LEGACY_TYPE_TO_KIND[accessory.context.device?.type]
    ?? inferKindFromServices(accessory);

  // Measurement: three-level fallback that AVOIDS guessing from kind alone.
  // `kind: motion` maps to multiple possible measurements — never infer from
  // kind alone.
  const dataPoint = accessory.context.device.uniqueId.split('-').slice(1).join('-');
  const defaultRow = DEFAULT_SENSOR_MAP.find(r => r.dataPoint === dataPoint);
  const legacyType = accessory.context.device?.type;
  const measurement =
      defaultRow?.measurement                       // #1 default-map lookup
    ?? LEGACY_TYPE_TO_MEASUREMENT[legacyType];      // #2 legacy-type table

  if (!measurement) {
    // #3 give up. The cached accessory doesn't map to a known measurement.
    // Preserve it in the accessory cache without structural reconciliation;
    // its context.kind / context.measurement / context.structuralSignature
    // are NOT written. On subsequent starts, if AWN starts reporting the
    // field again, the row can be recognized. Meanwhile the accessory stays
    // in HomeKit with its last-known values.
    return 'preserve-cached';
  }

  return { kind, measurement };
}
```

**`LEGACY_TYPE_TO_MEASUREMENT`** — one-to-one companion to `LEGACY_TYPE_TO_KIND`:

```typescript
const LEGACY_TYPE_TO_MEASUREMENT: Record<string, Measurement> = {
  'Temperature':        'temperature',
  'Humidity':           'humidity',
  'Solar Radiation':    'illuminance',
  'CO2':                'co2',
  'PM2.5':              'pm25',
  'PM10':               'pm10',
  'WindSpeed':          'wind-speed',
  'WindGust':           'wind-speed',
  'WindMaxDailyGust':   'wind-speed',
  'WindDirection':      'direction',
  'WindDirection10m':   'direction',
  'RainRate':           'rain-rate',
  'RainEvent':          'rain-accumulation',
  'RainDaily':          'rain-accumulation',
  'RainWeekly':         'rain-accumulation',
  'RainMonthly':        'rain-accumulation',
  'RainYearly':         'rain-accumulation',
  'LastRain':           'timestamp',
  'PressureRelative':   'pressure',
  'PressureAbsolute':   'pressure',
  'UV':                 'uv-index',
  'LightningDay':       'count',
  'LightningHour':      'count',
  'LightningDistance':  'distance',
  'LightningLastStrike':'timestamp',
};
```

The 'preserve-cached' fallback should be rare in practice — every v1.5.0 through v1.6.x cached accessory should have a legacy `type` field that maps via `LEGACY_TYPE_TO_MEASUREMENT`. It exists for hypothetical very old or hand-manipulated caches whose context lacks a `type` field entirely.

`LEGACY_TYPE_TO_KIND` covers all v1.5.0 and v1.6.0 type strings (see previous revision for the full table — unchanged).

AirQuality bootstrap disambiguates via optional density-characteristic inspection:

```typescript
case AIR_QUALITY_SENSOR_UUID:
  if (service.testCharacteristic(PM2_5_DENSITY_UUID)) return 'air-quality-pm25';
  if (service.testCharacteristic(PM10_DENSITY_UUID))  return 'air-quality-pm10';
  // Fallback: sensorKey pattern matching
  ...
```

Once inferred, kind + measurement + structural signature are written to context via `updatePlatformAccessories()`. No re-registration.

### 11.3 Formal minimal-diff migration serialization

Definition:

> A migrated override contains only fields whose effective legacy value differs from the v2 built-in baseline for the same `(stationMac, dataPoint)`.

**Canonicalization rules** (enforced by the serializer):

1. At most one entry per `(dataPoint, stationMac?)` key
2. Entries with identical field values across all stations serialize as a single global override (no `stationMac`)
3. Divergent stations get per-station entries only for stations whose diff is non-empty
4. Fields within an entry appear in a stable alphabetical order for byte-stable output
5. Entries sort by `dataPoint`, then `stationMac` (global first, then MACs alphabetically)

**Idempotency:**

```
legacyConfig → compat → effectiveMap1
             → serialize → sparse1
             → v2Load → effectiveMap2
assertEqual(effectiveMap1, effectiveMap2)     // structural equivalence
assertEqual(sparse1, serialize(compat(legacyConfig)))  // determinism
```

Repeated UI saves produce byte-identical `sensorMap` arrays for the same input.

### 11.4 What DOES change on upgrade

- Users who open the plugin config in HB UI see the Angular UI
- Auto-discovered rows appear for unknown AWN fields — informational, no accessories created until user assigns kind
- `[embed-diag]` debug logs subsumed by richer per-sensor logging

### 11.5 User rename behavior

Same behavior as v1.6.0-beta.15/16/17:
- `displayName` and service `Name` refresh on restart from effective row's `name`
- `ConfiguredName` set ONCE at registration; plugin stops overwriting when `isUserRenamed()` detects divergence
- Structural re-registration deregisters + registers new; new `ConfiguredName` comes from plugin `name`, previous user rename is lost

## 12. Testing plan

### 12.1 Existing test coverage — ports as-is

385 tests port with minor adjustments; `parseDevices` tests substantially rewritten around `buildEffectiveSensorMap`.

### 12.2 Property-driven invariants

Parameterized over `DEFAULT_SENSOR_MAP`:

1. Every default row's `(kind, measurement)` combination resolves to a wrapper descriptor
2. Every default row's units are legal for its measurement
3. Canonical battery uniqueness — one canonical per batteryField
4. `LEGACY_TYPE_TO_KIND` coverage — every value maps to a real kind
5. Compat determinism — `compat(compat(cfg)) === compat(cfg)`
6. Effective map determinism — `buildEffectiveSensorMap` is pure
7. Sparse-serialize round-trip
8. Migration idempotency (§11.3)
9. Structural signature stability across runs
10. Bootstrap coverage — every `LEGACY_TYPE_TO_KIND` entry produces the kind the default map assigns

### 12.3 Persistence tests

- Plugin discovery writes cannot erase UI dismissals — separate files
- UI forget-field writes cannot erase plugin notices — separate files
- Atomic replacement never exposes a partial JSON document (100 concurrent readers during a write; every read returns valid JSON)
- Corrupt files are quarantined with timestamped names; original preserved for diagnosis
- Unknown schema versions handled without modifying `config.json`
- Startup succeeds even when all three plugin-managed persistence files are missing
- Stale `.tmp` files older than 1 hour are cleaned up on startup

### 12.4 Measurement + structural signature tests

- Every `(kind, measurement)` in the default map has exactly one wrapper descriptor
- Unsupported `(kind, measurement)` combinations fail at row validation
- Measurement change from `wind-speed` to `pressure` produces a different structural signature
- Identity measurement change produces the same signature (no re-registration)
- Known datapoints reject kind overrides incompatible with their built-in measurement
- Custom datapoints require the correct field set per §3.4

### 12.5 Unit-shape tests

- Boolean rows with `sourceUnit` or `displayUnit` load successfully AND emit the documented warn — the field is ignored, but the warn is present in the log
- Boolean custom rows without units activate cleanly
- Timestamp rows require or infer `sourceUnit: 'ms'`
- Timestamp rows with `displayUnit` load successfully AND emit the documented warn
- Timestamp rows with non-'ms' `sourceUnit` fail at row level (per §3.7)
- Numeric rows require legal source and display units; illegal units fail at row level
- Serialization omits structurally-inapplicable fields (e.g., `displayUnit` absent from boolean row output)

### 12.6 Override-key tests

- At most one canonical override per `(dataPoint, stationMac?)`
- Duplicate rows in hand-edited config merge with later-wins per array order; warn emitted
- Conflicting duplicate fields produce deterministic results
- Global override and station-specific override for the same dataPoint remain distinct and layer correctly
- Repeated UI saves produce byte-stable canonical ordering
- Post-canonicalization: `serialize(deserialize(canonical)) === canonical`

### 12.7 Migration-equivalence tests — full HAP graph

Because we're NOT consolidating wrappers, every v1.6.0 accessory maps to the same v2.0 wrapper. Test that:

For every v1.6.0 fixture config:
```
v1.6.0 accessory graph (services, subtypes, characteristics, metadata, Battery placement, initial values, update behavior, embedded-name behavior)
==
v2.0 accessory graph (produced by loading the same config via compat layer)
```

Full-graph equivalence, not just structural signature.

### 12.8 Safe-mode read-only tests

- On a `configVersion: 3` (or any unsupported version), cached accessories continue to load via `configureAccessory()` with their last-known values
- UI's "Save" button is disabled or its server-side handler rejects the request
- UI's "Refresh from Ambient Weather" is disabled
- Row lifecycle actions (Enable/Disable / Remove override / Forget field) are disabled at the UI layer AND at the server layer
- Notice dismissal remains functional (a UI write to `ui-state.json` succeeds)
- UI displays the documented read-only banner

### 12.9 Bootstrap-measurement tests

- Every value of `LEGACY_TYPE_TO_KIND` has a corresponding entry in `LEGACY_TYPE_TO_MEASUREMENT`
- For every entry in `LEGACY_TYPE_TO_MEASUREMENT`, the inferred `(kind, measurement)` matches what the default map assigns for the corresponding sensorKey
- A cached accessory with `type: 'WindSpeed'` bootstraps to `measurement: wind-speed` (not `motion`)
- A cached accessory with unknown `type` AND unknown dataPoint returns `'preserve-cached'` — the accessory stays in HomeKit with no structural reconciliation attempted
- The bootstrap NEVER produces a measurement from `kind: motion` alone

### 12.10 `wrapperId` rejection tests

- A `sensorMap` entry with a `wrapperId` field fails at row-level validation
- The specific error message identifies `wrapperId` as an unknown field
- Other valid rows in the same `sensorMap` load normally

### 12.11 Suite stays green — every merge

Every merge to the implementation branch must leave CI green. No same-day companion-PR loophole; no known-failing tests during transition.

`npm test` in CI immediately at start of the beta cycle. Added to `prepublishOnly` **before publishing 2.0.0-beta.0** — not deferred to GA.

## 13. Rollout plan

### 13.1 Beta cycle

1. **2.0.0-beta.0**: data model + `sensorMap` parsing + compat + configVersion + bootstrap + LEGACY_TYPE_TO_KIND + discovery / notices / ui-state stores + minimal Angular UI. CI green + tests refactored.
2. **2.0.0-beta.1 .. N**: full Angular UI features.
3. **Late betas**: end-to-end coverage. Maintainer + solmssen exercise every path.
4. **Final beta**: docs polished.

Published under `@beta` dist-tag only.

### 13.2 GA criteria

- CI green throughout
- Every invariant in §12 has passing tests
- Zero-migration audit re-verified
- Both testers running latest beta for at least a week
- Angular UI validated in supported HB UI X versions
- CHANGELOG, README, UPGRADING.md finalized
- `npm test` in `prepublishOnly`

### 13.3 Post-GA

- Deferred: multi-Home tabbed UI. Angular infrastructure now available; small v2.1 feature if demand.
- Deferred: removing legacy 1.6.0 config fields. Compat layer stays permanently.
- Deferred: wrapper consolidation (WindGust + WindMaxDailyGust into a family, Rain accumulation family, etc.). Separate v2.x+ project with full HAP-graph equivalence tests.

## 14. Open questions

Answered:
- Custom UI or schema-driven? — Custom Angular UI.
- Auto-discovered row persistence? — Three single-writer files.
- Kind change UX? — Structural-signature re-registration + UI confirmation.
- Bootstrap for existing accessories? — `LEGACY_TYPE_TO_KIND` + service inspection + AirQuality density check.
- Config-mode detection? — `configVersion` with safe-mode for unsupported versions.
- Row identity across stations? — `(dataPoint, stationMac?)`, stationMac strictly MAC.
- Measurement dimension? — Separate from kind, participates in wrapper selection AND structural signature.
- Unrecognized rows in the type model? — Discriminated union; unrecognized/numeric/timestamp/boolean.
- Structural signature format? — `${kind}|measurement:${m}|battery:${0|1}|wrapper:${id}:v${version}` with per-wrapper `WrapperDescriptor`.
- Cleanup actions? — Three coherent actions (Enable/Disable, Remove user override, Forget discovered field).
- Discovery store concurrency? — Three single-writer files.
- Discovery write frequency? — Immediate on new; 15-min for lastSeen; flush on shutdown.
- Corrupt persistence file handling? — Quarantine to timestamped path.
- Test suite refactor? — Green every merge. `npm test` in CI immediately and `prepublishOnly` before first public beta.
- Beta.0 UI? — Minimal usable.
- AirQuality kind disambiguation? — Density characteristic inspection first.
- Migration serialization? — Formal minimal-diff with canonicalization rules (§11.3).
- Angular UI directory layout? — `homebridge-ui/{src,dist,server.ts}`.
- Row-level failure vs whole-plugin failure? — Row-level for `sensorMap`; safe mode for `configVersion` mismatch.
- Kind changes on known dataPoints? — Only within same measurement family.
- `stationMac` accepting name-shaped values? — Rejected.
- Wrapper consolidation? — NOT part of v2.0. Every v1.6.0 wrapper stays 1-to-1.
- Structural signature wrapper identifier? — Stable `id` from `WrapperDescriptor`, not `class.name`.
- Boolean/timestamp unit shapes? — Discriminated union with `never` for inapplicable units.
- Duplicate override keys? — At most one per `(dataPoint, stationMac?)`. Hand-edited duplicates merge with later-wins + warn + canonicalize on save.
- Invalid `configVersion` values? — Safe mode; keep cached accessories running; prominent error.

Still open (minor):
- Node/Homebridge version bumps? No plan.
- `docs/future/tabbed-config-ui.md` disposition? Superseded on UI-technology decision.
- Windows CI matrix? No plan.

## 15. What's NOT settled — implementation-time judgment

- Angular 17 signals / RxJS / slimmer state library.
- Notices size cap details. Lean 100.
- Exact schema-driven fallback shape in `config.schema.json`.
- `awnClient.ts` CommonJS vs ESM.
- Whether any of the canonical `(kind, measurement)` → wrapper choices in §3.9 turn out to be wrong for a real user's custom sensor. If so, a future v2.1+ can add a user-facing `wrapperId` override with proper validation, canonicalization, and UI. Not in v2.0.

## 16. Implementation acceptance criteria

Non-negotiable checks that the implementation must satisfy before 2.0.0-beta.0 ships. These are not open design questions; they are correctness properties the implementation must verify.

### 17.1 Canonical wrappers must be verified as generic

The canonical `(kind, measurement) → WrapperDescriptor` table in §3.9 reuses existing v1.6.0 wrapper classes for custom sensors — e.g., a custom `(motion, count)` sensor uses `LIGHTNING_DAY_WRAPPER`. This assumes those wrapper classes are generic enough to serve arbitrary datapoints within their `(kind, measurement)`.

**Before beta.0**, audit every wrapper class reused for custom sensors and confirm none of the following are hardcoded to the wrapper's original AWN datapoint:

- The AWN sensorKey (must accept any dataPoint that matches the row's `kind`/`measurement`)
- Display labels or characteristic display names (must derive from the effective row's `name`, not a class constant)
- Motion-trigger threshold defaults for motion-kind wrappers (must come from the row, not from the wrapper class). Fixed HAP alert-state boundaries baked into native characteristics (e.g. `Co2Accessory`'s 1000-ppm `CarbonDioxideDetected` threshold, which is a HAP alert-state semantic, not a user-configurable motion trigger) stay hardcoded — the v2.0 schema explicitly makes `row.threshold` a motion-only field. Extending threshold to native HAP alert wrappers is a schema change deferred post-2.0; see `docs/future/wrapper-parameterization.md`.
- Battery field assumptions (must come from the row's `batteryField`, not a wrapper-level default)
- Characteristic metadata (min/max/step values) that presume the original AWN field's range

Any wrapper found to hardcode its origin datapoint must be refactored to parameterize on the effective row BEFORE it appears in the custom-sensor canonical table. If refactoring proves substantial for a specific wrapper, that entry drops from the canonical table for v2.0 and its `(kind, measurement)` combination becomes "not supported for custom sensors" until v2.1+.

Tests: for every wrapper in the canonical table, instantiate with a synthetic custom effective row (dataPoint `test_custom`, arbitrary threshold, no battery field) and verify the accessory renders correctly with the row's data, not the wrapper's original defaults.

### 17.2 Safe mode must bypass reconciliation entirely

Safe mode (§5) returns zero effective rows. The reconciliation code path that compares effective rows against cached accessories normally interprets "row is missing for this cached accessory" as "unregister the cached accessory."

**Safe mode must short-circuit this path.** When `configMode === 'safe-mode'`:

- `discoverDevices()` calls `configureAccessory` for every cached accessory (Homebridge's normal restore path)
- The reconciliation-vs-effective-map step is SKIPPED entirely — no cached accessory is unregistered, no structural signature comparison runs
- Polling / realtime updates continue to push values to existing wrappers if they can be identified from cached context
- No new registrations happen (no config-derived rows exist)

Tests: fixture a `configVersion: 3` config with a legacy accessory cache containing 15 accessories. On plugin startup, verify all 15 cached accessories remain registered; no calls to `unregisterPlatformAccessories` are made; the safe-mode banner state is exposed to the UI.

### 17.3 Preserve-cached state must have a recovery path

The bootstrap flow (§11.2) returns `'preserve-cached'` when neither the default map nor `LEGACY_TYPE_TO_MEASUREMENT` resolves a cached accessory's measurement. Such an accessory stays in HomeKit with its last-known values, but its context does not receive `kind` / `measurement` / `structuralSignature`.

**On every subsequent `discoverDevices()` invocation**, the plugin re-attempts bootstrap for every `'preserve-cached'` accessory:

- If a newly-observed AWN response includes the accessory's dataPoint AND the default map now covers it (e.g., a plugin update added the default), resolve normally
- If a legacy type field becomes recognizable (unlikely — legacy types don't change post-registration, but a future compat table update could add entries), resolve normally
- Otherwise, remain in `'preserve-cached'` state

Once resolved, the context is populated via `updatePlatformAccessories()` (no re-registration).

Tests: fixture a cached accessory with no legacy type and a dataPoint absent from the initial default map. Verify the accessory stays in HomeKit through initial startup. Then simulate a plugin update that adds the dataPoint to the default map; on the next `discoverDevices()`, verify the accessory's context receives `kind` and `measurement` and enters the normal reconciliation lifecycle.

### 17.4 Canonical ordering for byte-stable sensorMap output

The migration serializer's canonicalization rules (§11.3) apply to ALL sensorMap writes, not just the initial legacy → v2 migration event. Any UI save must produce a byte-stable canonical form:

1. At most one entry per `(dataPoint, stationMac?)` key
2. Global entries (no stationMac) appear before station-specific entries for the same dataPoint
3. Entries sort by `dataPoint` first, then `stationMac` (global first, then MACs ascending alphabetically, case-insensitive)
4. Within each entry, fields appear in a fixed alphabetical order: `batteryField`, `dataPoint`, `displayUnit`, `embedName`, `enabled`, `kind`, `measurement`, `name`, `sourceUnit`, `stationMac`, `threshold`, `triggerDirection`, `triggerEnabled`
5. JSON output uses 2-space indentation, no trailing whitespace, LF line endings

Repeated saves of the same effective state produce byte-identical `config.json` diffs of size zero. Tests: pick 10 effective-map fixtures; serialize each; deserialize + re-serialize; assert byte-equality.

### 17.5 Threshold-family fields validated inapplicable on non-motion kinds

The following fields are only meaningful for `kind: motion`:
- `threshold`
- `triggerEnabled`
- `triggerDirection`
- `embedName`

When any of these appears in a non-motion row (default or user override), the plugin logs a warn identifying the specific field and row, ignores the field, and lets the row load normally. See §3.7 validation table.

Tests: for every non-motion kind, submit an override with each of these fields; verify the specific warn is emitted and the field is absent from the resulting effective row.

## 17. Decision log

- **2026-07-08**: v1 drafted.
- **2026-07-09**: First review. Revision incorporated configVersion, station-layered overrides, discovery store, structural signatures, bootstrap for existing accessories, unit source/display split, property-driven testing, minimal UI in beta.0.
- **2026-07-10**: Second review. Revision incorporated split discovery + ui-state files with single-writer semantics; consolidated row lifecycle to three actions; canonical `stationMac`; measurement dimension; discriminated-union `EffectiveSensorRow`; `triggerDirection` in public interface; row-level failure; readable structural signature; AirQuality disambiguation; formal minimal-diff migration; stricter test rule; Angular src/dist layout; station inventory sources.
- **2026-07-11**: Third review. Revision incorporated three separate single-writer files (`discovery.json`, `notices.json`, `ui-state.json`); measurement participation in wrapper selection AND structural signature; known-datapoint remapping rule; strict MAC validation; discovery write throttling; corrupt-file quarantine; optional observation timestamps; multi-process + structural-identity tests.
- **2026-07-12**: Fourth review. This revision incorporates:
  - **Blocking**: measurement-discriminated union for `EffectiveSensorRow` (`NumericRow` / `TimestampRow` / `BooleanRow`) — boolean and timestamp measurements no longer require inapplicable units at the type level. Uniqueness invariant: at most one override per `(dataPoint, stationMac?)`; canonical UI serialization; hand-edited duplicates merge with warn.
  - **Important**: `configVersion` handling refined — unsupported positive versions and malformed values enter **safe mode** (keep cached accessories, don't attempt structural changes, prominent upgrade-plugin error) instead of silently entering legacy mode. Wrapper consolidation removed from v2.0 scope — every v1.6.0 wrapper stays 1-to-1 in the default map via 25 `WrapperDescriptor` constants (the count includes `AIR_QUALITY_PM25_WRAPPER` and `AIR_QUALITY_PM10_WRAPPER`, which share the AirQualityAccessory ctor but need distinct ids because their HAP characteristic set differs). Structural signature uses stable `WrapperDescriptor.id`, not `class.name`. Atomic write implementation details specified (§8.6).
  - **Testing additions**: unit-shape tests (§12.5), override-key tests (§12.6), migration-equivalence tests upgraded to full HAP-graph equivalence (§12.7).
- **2026-07-13**: Fifth review. This revision incorporates:
  - **Blocking**: `wrapperId` removed from the design entirely — it was mentioned in prose but absent from `SensorMapOverride`. Rather than add it (with all the validation, canonicalization, UI, and test surface that entails), removed from v2.0 scope. Custom-sensor wrapper selection uses a canonical `(kind, measurement)` → descriptor table in §3.9 as the sole path. If a real user need surfaces, a user-facing `wrapperId` override becomes a v2.1+ project.
  - **Important**: Boolean rows with `sourceUnit`/`displayUnit` and timestamp rows with `displayUnit` now emit a warn (not silently ignored) — matches the design's "needs attention" philosophy. Row still loads; the warning surfaces the mistake. Safe mode is explicitly read-only — UI saves refused, "Refresh from Ambient Weather" disabled, lifecycle actions disabled; notice dismissal still permitted since it's schema-version-independent. Read-only banner text specified. Bootstrap measurement inference uses a new `LEGACY_TYPE_TO_MEASUREMENT` table paired with `LEGACY_TYPE_TO_KIND`; the earlier `inferMeasurementFromKind` fallback is removed because it's impossible for `motion`. If neither table matches, the plugin returns `'preserve-cached'` and leaves the accessory in HomeKit without structural reconciliation.
  - **Testing additions**: `wrapperId` rejection tests, boolean/timestamp warn tests, safe-mode read-only tests, bootstrap-measurement-never-from-kind-alone tests.
- **2026-07-14**: Sixth review — sign-off. Reviewer accepted the fifth revision. Five implementation acceptance criteria added as §16:
  - Canonical wrappers verified as genuinely generic before use for custom sensors
  - Safe mode bypasses reconciliation entirely (does NOT flow through the "row missing = unregister" path)
  - Preserve-cached state has a recovery path (re-evaluate on subsequent `discoverDevices` invocations)
  - Canonical ordering for byte-stable `sensorMap` serialization across all writes, not just migration
  - Explicit validation of inapplicable fields (threshold / triggerEnabled / triggerDirection / embedName) on non-motion kinds
  - Also added: §3.7 validation table entries for `threshold`/`triggerEnabled`/`embedName` on non-motion kinds
- Status: **APPROVED FOR IMPLEMENTATION**. Beta cycle can begin.

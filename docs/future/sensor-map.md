# Sensor Map — Design for v2.0

**Status:** Design in review — pending fourth review pass.
**Last revised:** 2026-07-11 (after third external review — see §16 decision log).
**Implementation phase:** Beta cycle target 2.0.0-beta.0 begins after this doc is signed off; GA target 2.0.0 after test-suite refactor completes.

## 1. Motivation

The plugin has grown three overlapping configuration concerns over v1.5.0 and v1.6.0:

1. **Which sensors to expose** — per-category toggles + `excludeSensors` + `includeOnly` + `stationFilter`
2. **How sensors are named** — no config field today; users rename in Apple Home
3. **Which HomeKit sensor type each AWN field maps to** — hardcoded in `determineSensorType()`; users cannot influence this

All three collapse into a single question: **what HomeKit accessory should each AWN datapoint produce?**

The proposal is a **unified sensor map** — a declarative model where each row expresses that question for one AWN datapoint on one station. The plugin ships built-in defaults matching current v1.6.0 behavior; auto-discovery adds rows for AWN fields the plugin doesn't know about; users edit rows through a custom Angular-based configuration UI.

Reference plugins whose approaches informed the design:

- **valiquette/homebridge-Ambient-realtime** — user-defined custom sensors via a `sensors: []` array; no auto-discovery; no default map
- **rhockenbury/homebridge-ecowitt-weather-sensors** — separate `nameOverrides` + `customHidden` fields; no user-defined sensor kinds
- **hjdhjd/homebridge-unifi-protect** — auto-discovered devices in Homebridge's accessory cache; user overrides as terse strings; custom Angular UI in `homebridge-ui/`; separate discovery store

## 2. Non-goals

- **Not a rewrite of the accessory-wrapper layer**. TemperatureAccessory, HumidityAccessory, WindSpeedAccessory, PressureRelativeAccessory, LightningDistanceAccessory, etc. all continue to exist. The sensor map's `(kind, measurement)` pair selects which wrapper class to instantiate.
- **Not adding new HAP characteristics**. The kind vocabulary is exactly the HAP-native sensor services that already work.
- **Not changing the AWN API integration**. The polling + realtime paths stay the same.
- **Not changing `stationFilter` or child-bridge multi-Home behavior**. Orthogonal to sensor mapping; stays as-is.

## 3. Data model

### 3.1 SensorKind — HAP wrapper selector

Twelve values, each corresponding to a HAP-native sensor service the plugin can render.

**Value tiles:** `temperature`, `humidity`, `light`, `co2`, `co`, `air-quality-pm25`, `air-quality-pm10`.

**State tiles:** `motion`, `leak`, `contact`, `occupancy`.

**Special:** `unrecognized` — auto-discovery sentinel for AWN fields not in the plugin's default map. Does NOT produce a HomeKit accessory until the user assigns a real kind.

### 3.2 Measurement — physical dimension

Independent of `kind`. Determines allowed units, threshold interpretation, conversion, and **wrapper subtype selection when kind alone is ambiguous**:

```typescript
type Measurement =
  | 'temperature'           // °F / °C
  | 'humidity'              // %
  | 'illuminance'           // lux (converted from W/m² for solar)
  | 'wind-speed'            // mph / kph / m/s / knots
  | 'rain-rate'             // in/hr / mm/hr
  | 'rain-accumulation'     // in / mm
  | 'pressure'              // inHg / hPa
  | 'distance'              // mi / km / nm
  | 'uv-index'              // dimensionless 0-15+
  | 'count'                 // integer count (lightning strikes)
  | 'direction'             // degrees 0-360
  | 'timestamp'             // Unix ms
  | 'co2'                   // ppm
  | 'co'                    // ppm
  | 'pm25'                  // µg/m³
  | 'pm10'                  // µg/m³
  | 'boolean';              // detected / not
```

For known defaults, both `kind` and `measurement` are baked into the default map. For custom (unrecognized) rows, the user must declare BOTH before activation.

**`kind: motion` requires `measurement` to disambiguate the wrapper** — see §3.8 for how `(kind, measurement)` selects a specific wrapper class.

### 3.3 SensorMapOverride — public config schema

Users write these into `config.json`. Only fields the user has explicitly set appear:

```typescript
interface SensorMapOverride {
  // Required — the AWN field this override applies to.
  dataPoint: string;

  // Optional — restrict this override to one station.
  // MUST be a MAC-formatted string (case-insensitive), matching a
  // discovered station. Absent = global template (applies to all
  // stations). Name-shaped values are REJECTED at validation with
  // row-level failure (see §3.7).
  stationMac?: string;

  // Optional — override the default kind. Required for custom
  // (unrecognized) dataPoints. For KNOWN dataPoints, changing kind
  // is only permitted when the new kind supports the datapoint's
  // built-in measurement (see §3.8).
  kind?: SensorKind;

  // Optional — measurement dimension. Required for custom dataPoints
  // alongside kind. IGNORED for known dataPoints (measurement is
  // fixed at the default-map level; changing physical interpretation
  // of a known datapoint is not supported — §3.8).
  measurement?: Measurement;

  // Optional — display name in HomeKit.
  name?: string;

  // Optional — motion-trigger threshold (numeric, stored in sourceUnit).
  threshold?: number;

  // Optional — whether the motion trigger is armed. Default true for
  // kind: motion. Set false for informational rows that should never
  // fire. Replaces the v1.6.0 internal Infinity sentinel (which
  // couldn't be JSON-serialized).
  triggerEnabled?: boolean;

  // Optional — trigger direction for motion-kind rows. Default 'above'.
  // Only meaningful for kind: motion; ignored (with warn) on other kinds.
  triggerDirection?: 'above' | 'below';

  // Optional — display unit override. Must be in the row's
  // measurement's legal set. Otherwise row-level failure.
  displayUnit?: SensorUnit;

  // Optional — for CUSTOM dataPoints only. Declares the unit the AWN
  // payload reports the value in. Ignored for known defaults.
  sourceUnit?: SensorUnit;

  // Optional — AWN batt* field name driving the Battery sub-service.
  // Set to null to explicitly suppress a Battery sub-service.
  batteryField?: string | null;

  // Optional — show the live value in the tile name (embed mode).
  // Default false. Only affects kind: motion.
  embedName?: boolean;

  // Optional — explicit disable. Absent or true = enabled. False =
  // the entire accessory (and its Battery sub-service) is NOT registered.
  enabled?: boolean;
}
```

#### 3.3.1 Station identity — strict MAC validation

`stationMac` is the ONLY station identity field. Strict validation:

- Must match the pattern `/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i` (standard colon-separated MAC-48). Colons required. Case insensitive.
- Any other value (station name, IP, hostname, empty string) → row-level failure (§3.7). The row surfaces in the UI's "needs attention" group with a specific error message.
- The plugin does NOT attempt best-effort name resolution. Reason: name-based matching is fragile (renames, duplicates, case) and gets in the way of the type contract.

Manually-edited configs that used to have a name are surfaced to the user via the "needs attention" path; the UI's station picker offers to replace the value with the correct MAC. Users editing `config.json` by hand can look up MACs from the plugin's discovered-stations log line (present since v1.5.0-beta.19) or from the AWN dashboard.

### 3.4 EffectiveSensorRow — internal representation after merge

Discriminated union. Observation timestamps are OPTIONAL because a row can be configured before the station reports it:

```typescript
type EffectiveSensorRow =
  | {
      // Auto-discovered field with no default and no user kind assignment.
      dataPoint: string;
      stationMac: string;
      kind: 'unrecognized';
      enabled: false;
      // Observational metadata — always present since the row exists
      // only because something reported it.
      firstSeen: string;
      lastSeen: string;
      lastValue?: unknown;
    }
  | {
      // Every other row — default, user-configured custom, or default
      // with overrides applied.
      dataPoint: string;
      stationMac: string;
      kind: Exclude<SensorKind, 'unrecognized'>;
      measurement: Measurement;
      name: string;
      threshold: number | undefined;
      triggerEnabled: boolean;
      triggerDirection: 'above' | 'below';
      sourceUnit: SensorUnit;
      displayUnit: SensorUnit;
      batteryField: string | null;
      embedName: boolean;
      enabled: boolean;
      structuralSignature: string;
      // Observational metadata — optional. Absent when the row is
      // configured but the station/field hasn't been reported yet.
      firstSeen?: string;
      lastSeen?: string;
      lastValue?: unknown;
    };
```

Consumers narrow on `kind === 'unrecognized'` vs the configured branch. TypeScript enforces at compile time that observational timestamps on configured rows may be undefined.

### 3.5 Unit compatibility — allowed by measurement

The allowed-unit set for each `measurement` is fixed:

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
| `timestamp` | ms | ms | — (relative time) | — |
| `boolean` | — | — | — | — |

Plugin ships `LEGAL_UNITS_FOR_MEASUREMENT: Record<Measurement, SensorUnit[]>` used for validation.

**Thresholds are always stored in `sourceUnit`.** Conversion to `displayUnit` happens at render time only.

### 3.6 Trigger semantics

`kind: motion` rows have `triggerDirection` (default 'above') and `triggerEnabled` (default true). Wind / rain / UV / gust default to `above`; pressure and lightning distance default to `below`.

`triggerEnabled: false` = row's motion state never fires, regardless of threshold. Explicit JSON-safe replacement for the v1.6.0 internal `Infinity` sentinel.

Users can override `triggerDirection` in the raw-JSON view of the UI's advanced tab. Only meaningful for `kind: motion`; validation logs a warn if set on any other kind but the row still loads.

### 3.7 Row validation and failure handling

Config load runs per-row validation. Row-level problems in `sensorMap` NEVER fail the whole plugin. Every valid row still loads. Invalid rows are visible in the UI so users can fix them.

| Failure | Handling |
|---|---|
| `dataPoint` missing or empty | Row rejected. Warn: `sensorMap entry with no dataPoint; skipping`. |
| `kind: unrecognized` set explicitly by user | Ignored — kind is auto-inferred for unrecognized fields. |
| `stationMac` present but not MAC-shaped | Row-level failure. UI shows: `stationMac 'Cabin' is not a MAC address. Use the station picker to select a station, or provide a colon-separated MAC.` |
| `stationMac` MAC-shaped but no station currently reports it AND no cached accessory/discovery entry references it | Row loaded but flagged "waiting for station" — configured but inactive. Activates if the station starts reporting. |
| Custom `dataPoint` missing `kind` OR `sourceUnit` OR `measurement` | Row-level failure. Surfaces in "needs attention". |
| `displayUnit` not in the row's `measurement`'s legal set | Row-level failure with specific message. |
| Known `dataPoint` with `kind` override incompatible with its built-in measurement (see §3.8) | Row-level failure. |
| `triggerDirection` set on a non-motion kind | Ignored with warn. Row still loads. |
| Invalid `configVersion` value | Warn once; treated as absent (legacy mode). |
| JSON parse failure of `config.json` overall | Whole-plugin startup failure (Homebridge's own behavior; not our concern). |
| Missing `apiKey` / `applicationKey` | Whole-plugin startup failure (existing v1.6.0 behavior; unchanged). |

### 3.8 Kind changes on known datapoints — remapping rules

**Known datapoints retain their built-in measurement and source unit.** The plugin's default map assigns them; users cannot change these.

**A kind override on a known datapoint is accepted only when the new kind supports the datapoint's built-in measurement.** The compatibility table:

| Measurement | Compatible kinds |
|---|---|
| `temperature` | `temperature` (only) |
| `humidity` | `humidity` (only) |
| `illuminance` | `light` (only) |
| `co2` | `co2` (only) |
| `co` | `co` (only) |
| `pm25` | `air-quality-pm25` (only) |
| `pm10` | `air-quality-pm10` (only) |
| `wind-speed` / `rain-rate` / `rain-accumulation` / `pressure` / `distance` / `uv-index` / `count` / `direction` / `timestamp` | `motion` (only) |
| `boolean` | `leak`, `contact`, `occupancy` |

For most measurements, kind is effectively fixed. The only interesting choice is on `measurement: boolean` where three state-tile kinds (leak, contact, occupancy) all render similarly — user can pick semantic meaning.

For custom datapoints: user declares `kind`, `measurement`, and `sourceUnit` at row creation. The row is inactive until all three are set.

**Rationale:** the wrapper class is selected by `(kind, measurement)`. Changing kind while measurement stays fixed only changes the HAP-service wrapper — most measurements have exactly one compatible kind, so the choice is effectively "which kind produces this measurement's tile." Changing measurement would mean re-interpreting the physical value, which the plugin doesn't support for known fields.

### 3.9 Wrapper selection

Wrappers are selected by `(kind, measurement)`:

```typescript
const WRAPPER_FOR_KIND_AND_MEASUREMENT: {
  [K in Exclude<SensorKind, 'unrecognized'>]: Partial<Record<Measurement, WrapperClass>>
} = {
  temperature:        { temperature: TemperatureAccessory },
  humidity:           { humidity: HumidityAccessory },
  light:              { illuminance: SolarRadiationAccessory },
  co2:                { co2: Co2Accessory },
  co:                 { co: CoAccessory },
  'air-quality-pm25': { pm25: Pm25AirQualityAccessory },
  'air-quality-pm10': { pm10: Pm10AirQualityAccessory },
  motion: {
    'wind-speed':        WindSpeedAccessory,
    'rain-rate':         RainRateAccessory,
    'rain-accumulation': RainAccumulationAccessory,
    'pressure':          PressureAccessory,
    'distance':          LightningDistanceAccessory,
    'uv-index':          UvAccessory,
    'count':             LightningCountAccessory,
    'direction':         WindDirectionAccessory,
    'timestamp':         LastEventAccessory,
  },
  leak:      { boolean: LeakAccessory },
  contact:   { boolean: ContactAccessory },
  occupancy: { boolean: OccupancyAccessory },
};
```

Some existing v1.6.0 wrapper classes get consolidated: WindGustAccessory + WindMaxDailyGustAccessory become instances of the WindSpeedAccessory family parameterized by dataPoint; RainDaily/Weekly/Monthly/Yearly/Event all become RainAccumulationAccessory instances. This is a refactoring detail — externally, HAP service graphs are unchanged.

Per-wrapper schema versioning:

```typescript
const WRAPPER_SCHEMA_VERSION: Record<string, string> = {
  // Keyed by wrapper class name for finest-grained versioning.
  TemperatureAccessory: 'v1',
  HumidityAccessory: 'v1',
  WindSpeedAccessory: 'v1',
  PressureAccessory: 'v1',
  LightningDistanceAccessory: 'v1',
  // etc.
};
```

Bumping one wrapper's version re-registers only accessories that use that wrapper.

## 4. Config schema — user-facing shape

`config.json` sensor-map fields:

- `configVersion: number` — see §5
- `sensorMap: SensorMapOverride[]` — sparse; only user-modified rows

Example:

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
    { "dataPoint": "windspeedmph", "threshold": 30 },
    { "dataPoint": "windspeedmph", "displayUnit": "kph" },
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

## 5. Config-mode detection

The plugin's startup distinguishes three cases:

| `configVersion` | Legacy toggles present? | Interpretation | Behavior |
|---|---|---|---|
| Absent | Any | Legacy v1 | Apply compat layer (§6). Absent legacy toggles = v1.6.0 defaults. |
| `2` | No | Explicit v2 | Start from v2 defaults. Apply `sensorMap` overrides. No compat. |
| `2` | Yes | Invalid | Warn once: `Both configVersion: 2 and legacy toggle <name> are set. configVersion: 2 takes precedence; legacy toggles ignored`. |

**Migration event:** first UI save on a legacy config atomically:
1. Reads effective sensor map (compat-translated)
2. Computes minimal-diff serialization against v2 baseline (§11.3)
3. Writes as sparse `sensorMap[]`
4. Removes legacy fields
5. Sets `configVersion: 2`

Users who never open the UI keep the legacy shape indefinitely. Compat layer runs forever.

## 6. Compat layer (legacy-mode only)

When `configVersion` is absent, legacy fields translate to internal sensor-map state. One-shot per plugin boot. Nothing written back.

| 1.6.0 field | Value | Effect |
|---|---|---|
| `temperatureSensors` | true/false/absent | All `kind: temperature` rows → `enabled`. Absent = false. |
| `humiditySensors` | same | Same, for `kind: humidity` |
| `solarRadiationSensors` | same | Same, for `kind: light` (solar rows only) |
| `co2Sensors` | same | Same, for `kind: co2` |
| `airQualitySensors` | same | Same, for pm25 + pm10 |
| `extendedSensors: false` | | All motion-kind extended rows → `enabled: false` |
| `extendedSensors: true` | | Sub-toggles apply |
| `windSensors` / `rainSensors` / `pressureSensors` / `uvSensors` / `lightningSensors` | | Corresponding rows → `enabled` |
| `thresholds.<foo>Enabled: false` | | Row → `enabled: false` |
| `thresholds.<foo>Mph` / `.InHr` / `.uv` / etc. | numeric | Row's `threshold` set |
| `units.windSpeed` / `.rain` / `.pressure` / `.distance` | e.g. `kph` | Rows' `displayUnit` |
| `extendedDisplayMode: embed` | | All motion-kind rows → `embedName: true` |
| `embedNameUpdateMinIntervalMinutes: N` | | Global setting stays |
| `excludeSensors: ["Foo"]` | | Matching rows → `enabled: false`. `-batt` suffix + raw battery field name matching from 1.6.0-beta.24 continues. |
| `includeOnly: [...]` | | Non-matching rows → `enabled: false`. Applied AFTER `excludeSensors`. |
| `stationFilter: [...]` | | Not sensor-map related. Stays as top-level field. |
| `dataSource` | | Not sensor-map related. Stays. |

## 7. Effective map construction

Pure function:

```typescript
function buildEffectiveSensorMap(input: {
  defaultMap: DefaultSensorRow[];
  configMode: 'legacy' | 'v2';
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
5. Runtime availability metadata (from discovery + AWN response)

Output: one `EffectiveSensorRow` per `(stationMac, dataPoint)` pair. Pure — no I/O, no clocks, no globals. Deterministic and property-testable (§12).

## 8. Persistence — five surfaces

State lives in five separate files/domains. Each has **exactly one writer**. No shared read-modify-write across processes.

| Surface | Writer | Readers | Purpose |
|---|---|---|---|
| `config.json` | HB UI X (via UI server), or user via text editor | plugin, UI server | User intent — sparse overrides |
| Homebridge accessory cache (`cachedAccessories.*`) | plugin | plugin (on restart) | HomeKit registration state + last-known values |
| `<persistPath>/ambient-weather-discovery.json` | **plugin only** | plugin, UI server (read-only) | Observational — what fields AWN reports |
| `<persistPath>/ambient-weather-notices.json` | **plugin only** | plugin, UI server (read-only) | Structural-change notices |
| `<persistPath>/ambient-weather-ui-state.json` | **UI server only** | plugin, UI server | Dismissed notice IDs + forgotten fields |

`<persistPath>` = `api.user.persistPath()/plugin-data/ambient-weather/`.

**Single-writer rule is strict.** No file has two writers. UI dismissals don't touch plugin-owned files; plugin notices don't touch UI-owned files.

### 8.1 `config.json` — user intent

Managed by Homebridge. Plugin reads at startup; plugin never writes. UI writes via HB UI X's config APIs.

Fields relevant to sensor map: `configVersion`, `sensorMap`.

Legacy fields (`temperatureSensors`, `excludeSensors`, etc.) also read in legacy mode; removed atomically on first UI save.

### 8.2 Homebridge accessory cache

Managed by Homebridge. On restart, HB calls `configureAccessory(accessory)`. Plugin restores runtime state from `accessory.context.device`:

```typescript
interface AccessoryContext {
  uniqueId: string;                    // ${macAddress}-${sensorKey} — stable across restarts
  displayName: string;                 // last name written to HomeKit
  kind?: SensorKind;                   // NEW in 2.0. Bootstrap-inferred for legacy accessories (§11.2).
  measurement?: Measurement;           // NEW in 2.0. Bootstrap-inferred where possible.
  type?: string;                       // legacy 1.6.0 field; kept for bootstrap-time inference
  structuralSignature?: string;        // NEW in 2.0. See §9.
  value?: number;                      // last-known reading
  batteryLow?: boolean;                // last-known battery state
}
```

### 8.3 Plugin discovery store — observational data

Plugin-owned. Plugin-only writes.

Path: `<persistPath>/ambient-weather-discovery.json`

```typescript
interface DiscoveryStore {
  schemaVersion: 1;
  entries: DiscoveredFieldRecord[];
}

interface DiscoveredFieldRecord {
  stationMac: string;
  stationName: string;                 // last-known — for UI display only, not identity
  dataPoint: string;
  firstSeen: string;
  lastSeen: string;
}
```

**Design decisions:**

- **`lastValue` is NOT persisted.** Kept in-memory only if the UI needs it (currently, no UI feature depends on persistence of last values). This reduces file size and avoids write amplification on values that change every poll.

- **Persistence throttled.** Writes happen:
  - Immediately when a new station or dataPoint is discovered (structural change to the registry).
  - At a coarser cadence (default 15 minutes) for `lastSeen`-only updates.
  - On graceful shutdown to flush pending updates.
  - This means SD-card Homebridge installs don't see a write on every poll. In-memory registry stays current; persistence is throttled.

- **Atomic writes** via `fs.writeFile(<path>.tmp) → fs.rename(<path>.tmp, <path>)`. Filesystem-atomic on all major OS/filesystem combinations relevant to Homebridge.

- **Corrupt-file recovery.** On startup, if the file is missing, malformed, or has an unrecognized `schemaVersion`:
  1. Rename the offending file to `<name>.corrupt-<ISO-8601-timestamp>.json` (preserves for diagnosis)
  2. Log a warn including the quarantine path
  3. Start with an empty in-memory store
  4. Continue plugin startup normally
  Never silently overwrite. Never fail plugin startup because a persistence file is corrupt.

### 8.4 Plugin notices store — structural-change events

Plugin-owned. Plugin-only writes.

Path: `<persistPath>/ambient-weather-notices.json`

```typescript
interface NoticeStore {
  schemaVersion: 1;
  notices: SensorMapNotice[];          // structural change events, plugin-appended
}

interface SensorMapNotice {
  id: string;                          // UUID
  type: 'structural-change';
  stationMac: string;
  dataPoint: string;
  oldSignature?: string;
  newSignature: string;
  occurredAt: string;
}
```

The plugin appends a notice whenever a structural re-registration happens (§9). Notices are size-capped (default: keep the 100 most recent) to prevent unbounded growth. Corrupt-file recovery same as §8.3.

### 8.5 UI-state store — dismissed IDs + forgotten fields

UI-server-owned. UI-only writes.

Path: `<persistPath>/ambient-weather-ui-state.json`

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

**How the UI renders active notices:** UI reads `notices.json` (plugin-owned) AND `ui-state.json` (its own). Computes visible notices as `notices \ dismissedNoticeIds`. Plugin never touches `ui-state.json`.

**How the plugin handles forgotten fields:** plugin reads `ui-state.json` at the start of each `discoverDevices()` invocation. Any `(stationMac, dataPoint)` in `forgottenFields` is suppressed from auto-discovery — the row does NOT appear as `unrecognized`. If the user later removes the forgotten-field entry via the UI (which writes `ui-state.json`), the plugin picks up the removal on next poll and the field re-surfaces.

Corrupt-file recovery same as §8.3.

### 8.6 Station inventory sources when AWN unavailable

`buildEffectiveSensorMap` takes a `stations: StationInventory`. The UI server produces this by unioning multiple sources, in preference order:

1. Current AWN response (freshest) — if a poll or manual refresh succeeded recently
2. Discovery registry (`discovery.json`) — every station ever observed with last-seen timestamps
3. Accessory cache — every station in a cached accessory's `uniqueId` prefix
4. `stationMac` values from `config.json` overrides

The union covers every station the user has interacted with, whether or not AWN is currently reachable. Rows for currently-unreachable stations appear grayed with "not currently reporting" in the UI.

Station display names come from the freshest available source (usually AWN response, falling back to discovery registry's `stationName`, then to the MAC itself).

## 9. Structural signature and re-registration

HAP does not allow an accessory's service graph to change on the same UUID once registered. Fields that affect the service graph:

- `kind` (primary service)
- `measurement` (which wrapper subclass, which custom characteristics)
- `batteryField` presence/absence (adds/removes Battery sub-service)
- Wrapper implementation changes

**Signature includes `measurement`** because `kind: motion` alone underspecifies the wrapper:

```typescript
function structuralSignature(row: EffectiveSensorRow): string {
  if (row.kind === 'unrecognized') return 'unrecognized';
  const hasBattery = attachesBatterySubService(row) ? '1' : '0';
  const wrapperClass = WRAPPER_FOR_KIND_AND_MEASUREMENT[row.kind][row.measurement];
  const wrapperVer = WRAPPER_SCHEMA_VERSION[wrapperClass?.name ?? 'unknown'];
  return `${row.kind}|measurement:${row.measurement}|battery:${hasBattery}|wrapper:${wrapperClass?.name}:${wrapperVer}`;
}
```

Example signatures:
- `temperature|measurement:temperature|battery:1|wrapper:TemperatureAccessory:v1`
- `motion|measurement:wind-speed|battery:1|wrapper:WindSpeedAccessory:v1`
- `motion|measurement:pressure|battery:1|wrapper:PressureAccessory:v1`

Different measurements under the same kind produce different signatures — swapping wind-speed for pressure triggers structural re-registration, correctly.

### 9.1 Per-wrapper versioning

Wrapper schema versions keyed by wrapper class name. Bumping `WindSpeedAccessory: 'v2'` re-registers only wind-speed accessories, not all motion-kind ones.

### 9.2 Names are NOT structural

`name`, `displayName`, `Name`, `ConfiguredName` — not in the signature. Name updates handled by `updatePlatformAccessories()` without re-registration.

### 9.3 Detection

On startup, for each cached accessory:

1. Read `oldSignature = accessory.context.device.structuralSignature` (or bootstrap-infer if absent — §11.2)
2. Compute `newSignature = structuralSignature(effectiveRowFor(sensorKey))`
3. If match: update in-place via `updatePlatformAccessories()`
4. If differ:
   - Log warn: `Structural change detected for <dataPoint>: <old> → <new>. Re-registering. HomeKit room, automations, and custom name will be lost.`
   - Append a `SensorMapNotice` to `notices.json`
   - `unregisterPlatformAccessories(...)` old
   - `registerPlatformAccessories(...)` new

### 9.4 Row lifecycle actions

The UI's "Manage sensors" panel offers three actions. Each has coherent semantics:

| Action | Applies to | Behavior |
|---|---|---|
| **Enable / Disable** | Any configured row | Toggles `enabled` in the user override. `false` deregisters the accessory. `true` re-registers. Idempotent across restarts. |
| **Remove user override** | Any row with a `sensorMap` entry | Removes the entry from `config.json`. Recomputes the effective row against defaults + discovery + compat. Structural signature comparison determines whether it's an in-place update or a re-registration; if re-registration, UI shows confirmation modal beforehand. |
| **Forget discovered field** | Rows for AWN fields not in the default map | Adds a `ForgottenField` to `ui-state.json`. The `(stationMac, dataPoint)` combination stops appearing as auto-discovered. Reappears if the user removes the forgotten-field entry via UI. |

## 10. Custom Angular UI

### 10.1 Directory layout

```
homebridge-ambient-weather-sensors/
├── homebridge-ui/
│   ├── src/                             # Angular source (committed)
│   │   ├── app/
│   │   │   ├── sensor-map/
│   │   │   ├── station-filter/
│   │   │   ├── general/
│   │   │   └── shared/
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── styles.css
│   ├── dist/                            # Angular build output (gitignored)
│   ├── server.ts                        # Node bridge source (committed)
│   ├── server.js                        # server.ts compiled (gitignored)
│   ├── tsconfig.json
│   └── angular.json
├── src/
│   ├── awnClient.ts                     # Shared AWN client (plugin + UI server)
│   └── ...
├── config.schema.json                   # Minimal schema-driven fallback
└── package.json
```

**Committed to git:** `homebridge-ui/src/`, `homebridge-ui/server.ts`, tsconfig / angular config files.
**Not committed:** `homebridge-ui/dist/`, `homebridge-ui/server.js`. In `.gitignore`.

**Shipped to npm** (added to `package.json`'s `files` allowlist):
- `homebridge-ui/dist/`
- `homebridge-ui/server.js`

**Not shipped to npm:** source, tsconfig, angular.json.

**Build commands:**

```json
"scripts": {
  "build:ui": "cd homebridge-ui && ng build --configuration production && tsc server.ts",
  "build": "…existing plugin build… && npm run build:ui",
  "prepublishOnly": "npm run lint && npm test && npm run build"
}
```

`prepublishOnly` runs UI build before packaging. UI build failure → release failure.

### 10.2 Process boundary

```
┌───────────────────┐      ┌───────────────────────┐      ┌────────────────────┐
│ Angular front-end │      │ homebridge-ui/server  │      │ Plugin process     │
│ (browser)         │◄────►│ (short-lived, spawned │      │ (long-lived)       │
│                   │      │  by HB UI X)          │      │                    │
│                   │      │                       │      │                    │
│                   │      │ reads:                │      │ writes:            │
│                   │      │   config.json         │      │   HB accessory     │
│                   │      │   discovery.json (RO) │      │   cache            │
│                   │      │   notices.json (RO)   │      │   discovery.json   │
│                   │      │   ui-state.json       │      │   notices.json     │
│                   │      │   accessory cache (RO)│      │                    │
│                   │      │ writes:               │      │                    │
│                   │      │   config.json         │      │                    │
│                   │      │   ui-state.json       │      │                    │
└───────────────────┘      └───────────────────────┘      └────────────────────┘
```

State passes through five persistence surfaces (§8). No file has two writers.

### 10.3 Shared AWN client

`src/awnClient.ts` — imported by both plugin and UI server:

- REST call to `https://rt.ambientweather.net/v1/devices?...`
- 429 retry with backoff
- Same JSON parsing + type validation

Plugin uses on normal polls. UI server uses ONLY on user-initiated "Refresh from Ambient Weather" action. Credentials never round-trip through the browser.

### 10.4 Front-end responsibilities

- Grouped-row sensor-map table
- Row expansion for editing; kind + measurement + unit dropdowns
- Structural-change confirmation modal (blocks save on kind or measurement change that alters signature)
- Row-level failure surfacing in "needs attention" group
- Enable/Disable / Remove user override / Forget discovered field
- Persistent notice banner (`notices \ dismissedNoticeIds`)
- Advanced tab — raw JSON view for `sensorMap`, `triggerDirection`, and seldom-used fields
- Station picker that writes MAC to `stationMac` (never a name)

### 10.5 Schema-driven fallback

`config.schema.json` continues to ship. If a user disables custom UI in HB UI X preferences, they see a minimal form that lets them edit the raw `sensorMap` array.

## 11. Migration semantics

### 11.1 Default map preserves service types

The plugin's v2.0 default sensor map produces the same HAP service type for every AWN sensorKey v1.6.0 exposes. Audit table:

| sensorKey | v1.6.0 service | Legacy `type` | Inferred kind | Measurement | v2.0 service | Match |
|---|---|---|---|---|---|---|
| `tempf` .. `dewPoint` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `humidity`, `humidityin` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `solarradiation` | LightSensor | `Solar Radiation` | light | illuminance | LightSensor | ✓ |
| `co2`, `co2_in_aqin` | CarbonDioxideSensor | `CO2` | co2 | co2 | CarbonDioxideSensor | ✓ |
| `pm25`, `pm25_in_aqin` | AirQualitySensor | `PM2.5` | air-quality-pm25 | pm25 | AirQualitySensor+PM2_5Density | ✓ |
| `pm10_in_aqin` | AirQualitySensor | `PM10` | air-quality-pm10 | pm10 | AirQualitySensor+PM10Density | ✓ |
| `pm_in_temp_aqin` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `pm_in_humidity_aqin` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `uv` | MotionSensor + custom chars | `UV` | motion | uv-index | MotionSensor + UvAccessory custom chars | ✓ |
| `windspeedmph`, `windgustmph`, `maxdailygust` | MotionSensor + custom chars | Wind types | motion | wind-speed | MotionSensor + WindSpeedAccessory custom chars | ✓ |
| `winddir`, `winddir_avg10m` | MotionSensor + custom chars | WindDirection types | motion | direction | MotionSensor + WindDirectionAccessory custom chars | ✓ |
| `hourlyrainin` | MotionSensor + custom chars | `RainRate` | motion | rain-rate | MotionSensor + RainRateAccessory custom chars | ✓ |
| `eventrainin` .. `yearlyrainin` | MotionSensor + custom chars | Rain accumulation types | motion | rain-accumulation | MotionSensor + RainAccumulationAccessory custom chars | ✓ |
| `lastRain` | MotionSensor + custom chars | `LastRain` | motion | timestamp | MotionSensor + LastEventAccessory custom chars | ✓ |
| `baromrelin`, `baromabsin` | MotionSensor + custom chars | Pressure types | motion | pressure | MotionSensor + PressureAccessory custom chars | ✓ |
| `lightning_day`, `lightning_hour` | MotionSensor + custom chars | Lightning count types | motion | count | MotionSensor + LightningCountAccessory custom chars | ✓ |
| `lightning_distance` | MotionSensor + custom chars | `LightningDistance` | motion | distance | MotionSensor + LightningDistanceAccessory custom chars | ✓ |
| `lightning_time` | MotionSensor + custom chars | `LightningLastStrike` | motion | timestamp | MotionSensor + LastEventAccessory custom chars | ✓ |
| `temp{N}f`, `humidity{N}`, `feelsLike{N}`, `dewPoint{N}` | Various | Various | temperature / humidity | temperature / humidity | Same | ✓ |

All ✓ by construction.

### 11.2 Bootstrap rule for existing cached accessories

Existing v1.6.0 cached accessories have no `kind`, `measurement`, or `structuralSignature`. On first v2.0 startup, apply this fallback chain per accessory:

```typescript
function inferKindForCachedAccessory(accessory: PlatformAccessory): SensorKind {
  const explicitKind = accessory.context.device?.kind;
  if (explicitKind) return explicitKind;

  const legacyType = accessory.context.device?.type;
  if (legacyType && LEGACY_TYPE_TO_KIND[legacyType]) {
    return LEGACY_TYPE_TO_KIND[legacyType];
  }

  return inferKindFromServices(accessory);
}

function inferKindFromServices(accessory: PlatformAccessory): SensorKind {
  const primary = accessory.services.find(s => s.UUID !== ACCESSORY_INFORMATION_SERVICE_UUID);
  if (!primary) return 'unrecognized';

  switch (primary.UUID) {
    case TEMPERATURE_SENSOR_UUID:    return 'temperature';
    case HUMIDITY_SENSOR_UUID:       return 'humidity';
    case LIGHT_SENSOR_UUID:          return 'light';
    case CARBON_DIOXIDE_SENSOR_UUID: return 'co2';
    case CARBON_MONOXIDE_SENSOR_UUID: return 'co';
    case MOTION_SENSOR_UUID:         return 'motion';
    case LEAK_SENSOR_UUID:           return 'leak';
    case CONTACT_SENSOR_UUID:        return 'contact';
    case OCCUPANCY_SENSOR_UUID:      return 'occupancy';

    case AIR_QUALITY_SENSOR_UUID:
      // Disambiguate by which optional density characteristic is present.
      if (primary.testCharacteristic(PM2_5_DENSITY_UUID)) return 'air-quality-pm25';
      if (primary.testCharacteristic(PM10_DENSITY_UUID))  return 'air-quality-pm10';
      // Fallback: pattern-match sensorKey (best effort; documented as such)
      if (accessory.context.device?.uniqueId?.includes('pm10')) return 'air-quality-pm10';
      return 'air-quality-pm25';

    default: return 'unrecognized';
  }
}
```

Measurement is inferred from the effective row's default (fetched via sensorKey lookup) once kind is known. Once bootstrap-inferred, kind + measurement + structuralSignature are written to context via `updatePlatformAccessories()` — no HAP re-registration.

`LEGACY_TYPE_TO_KIND`:

```typescript
const LEGACY_TYPE_TO_KIND: Record<string, SensorKind> = {
  'Temperature': 'temperature',       'Humidity': 'humidity',
  'Solar Radiation': 'light',         'CO2': 'co2',
  'PM2.5': 'air-quality-pm25',        'PM10': 'air-quality-pm10',
  'WindSpeed': 'motion',              'WindGust': 'motion',
  'WindMaxDailyGust': 'motion',       'WindDirection': 'motion',
  'WindDirection10m': 'motion',       'RainRate': 'motion',
  'RainEvent': 'motion',              'RainDaily': 'motion',
  'RainWeekly': 'motion',             'RainMonthly': 'motion',
  'RainYearly': 'motion',             'LastRain': 'motion',
  'PressureRelative': 'motion',       'PressureAbsolute': 'motion',
  'UV': 'motion',                     'LightningDay': 'motion',
  'LightningHour': 'motion',          'LightningDistance': 'motion',
  'LightningLastStrike': 'motion',
};
```

### 11.3 Formal minimal-diff migration serialization

When the UI migrates a legacy config, it serializes the effective map to sparse `sensorMap[]` entries. Formal definition:

> A migrated override contains only fields whose effective legacy value differs from the v2 built-in baseline for the same `(stationMac, dataPoint)`.

Algorithm:

```typescript
function serializeMinimalOverrides(
  effectiveMap: EffectiveSensorRow[],
  v2Baseline: DefaultSensorRow[],
  observedStations: string[]
): SensorMapOverride[] {
  const overrides: SensorMapOverride[] = [];

  const byDataPoint = groupBy(effectiveMap, r => r.dataPoint);
  for (const [dataPoint, rows] of byDataPoint) {
    const baseline = v2Baseline.find(r => r.dataPoint === dataPoint);
    if (!baseline) {
      for (const row of rows) overrides.push(fullOverrideFor(row));
      continue;
    }
    const diffs = rows.map(row => ({ stationMac: row.stationMac, diff: fieldDiff(row, baseline) }));
    if (allSameDiff(diffs) && diffs.length === observedStations.length) {
      if (Object.keys(diffs[0].diff).length > 0) {
        overrides.push({ dataPoint, ...diffs[0].diff });
      }
    } else {
      for (const { stationMac, diff } of diffs) {
        if (Object.keys(diff).length > 0) {
          overrides.push({ dataPoint, stationMac, ...diff });
        }
      }
    }
  }
  return overrides;
}
```

**Idempotency test** (part of §12): `legacyConfig → compat → effectiveMap1 → serialize → v2Load → effectiveMap2`; assert `effectiveMap1 === effectiveMap2` row-for-row.

**Determinism:** deterministic — running twice on the same input produces identical output.

### 11.4 What DOES change on upgrade

- Users who open the plugin config in HB UI see the Angular UI
- Auto-discovered rows appear for AWN fields the plugin doesn't have defaults for — informational, no accessories created until user assigns kind
- `[embed-diag]` debug log lines subsumed by richer per-sensor logging

### 11.5 User rename behavior

Three name-adjacent characteristics:

- `accessory.displayName` — HB's own field
- Service `Name` — HAP standard
- Service `ConfiguredName` — HAP 2.x

Plugin already has logic from v1.5.0-beta.15/16/17. Under sensor-map:

- **`displayName` and service `Name`** update on every restart from effective row's `name`.
- **`ConfiguredName`** set ONCE at registration. `isUserRenamed()` detects divergence; when detected, plugin stops overwriting.
- **Kind/measurement change / structural re-registration** deregisters accessory. New accessory's `ConfiguredName` set from plugin's `name` — previous user rename is lost with the old accessory.

The Angular UI displays user-renames as "user-set" on affected rows.

## 12. Testing plan

### 12.1 Existing test coverage — how it ports

385-test suite ports as follows:
- Pure-function tests: unchanged
- Wrapper tests: mostly unchanged
- Existing `parseDevices` tests: substantially rewritten around `buildEffectiveSensorMap`
- Regression tests: unchanged

### 12.2 New tests — property-driven invariants

Parameterized tests over the default map:

```typescript
describe('default sensor map invariants', () => {
  for (const row of DEFAULT_SENSOR_MAP) {
    test(`${row.dataPoint}: (kind, measurement) resolves to a wrapper`, () => {
      expect(WRAPPER_FOR_KIND_AND_MEASUREMENT[row.kind]?.[row.measurement]).toBeDefined();
    });
    test(`${row.dataPoint}: measurement is compatible with kind`, () => {
      expect(COMPATIBLE_MEASUREMENTS_FOR_KIND[row.kind]).toContain(row.measurement);
    });
    test(`${row.dataPoint}: displayUnit is legal for measurement`, () => {
      expect(LEGAL_UNITS_FOR_MEASUREMENT[row.measurement]).toContain(row.displayUnit);
    });
  }
});
```

Invariants:

1. Wrapper coverage — every `(kind, measurement)` used by the default map resolves to a wrapper
2. Unit legality — every default row's units are in the allowed set for its measurement
3. Canonical battery — for every batteryField, exactly one row in the default map is canonical
4. Legacy compat coverage — every legacy `type` value maps to a real kind via `LEGACY_TYPE_TO_KIND`
5. Compat determinism — `compat(compat(cfg)) === compat(cfg)`
6. Effective-map determinism — `buildEffectiveSensorMap` is pure
7. Sparse-serialize round-trip — serialize + deserialize produces same effective map
8. Migration idempotency — `legacyConfig → effective → sparse → v2Load → effective` yields the same effective map
9. Structural signature stability — deterministic across runs
10. v1 fixture equivalence — every legacy fixture's accessories under v2 have the same signatures as under v1.6
11. Bootstrap coverage — every entry in `LEGACY_TYPE_TO_KIND` produces the kind the default map assigns

### 12.3 Persistence tests (NEW)

- Plugin notice write cannot erase UI dismissals — they're in different files
- UI forget-field write cannot erase plugin discovery entries — different files
- Atomic replacement never exposes a partial JSON document (spawn 100 concurrent readers during a write; every read returns valid JSON)
- Corrupt files are quarantined with timestamped names; original preserved for diagnosis
- Unknown schema versions handled without modifying `config.json`
- Startup succeeds even when all three plugin-managed persistence files are missing

### 12.4 Measurement + structural signature tests (NEW)

- Every `(kind, measurement)` combination in the default map has exactly one wrapper class
- Unsupported `(kind, measurement)` combinations fail at row validation with a clear error
- Measurement change from `wind-speed` to `pressure` produces a different structural signature (forces re-registration)
- Measurement change from `wind-speed` to `wind-speed` (identity — user re-set the same value) produces the same signature (no re-registration)
- Known dataPoints reject kind overrides incompatible with their built-in measurement (row-level failure)
- Custom dataPoints require kind, measurement, sourceUnit — missing any one produces row-level failure

### 12.5 Suite stays green — every merge

Every merge to the implementation branch must leave CI green. No same-day companion-PR loophole; no known-failing tests during transition.

`npm test` in CI immediately at start of beta cycle. Added to `prepublishOnly` **before publishing 2.0.0-beta.0**.

Any implementation change that would break tests must include the refactor in the SAME PR. If that grows unmanageably, split into smaller PRs each of which independently leaves CI green.

## 13. Rollout plan

### 13.1 Beta cycle

1. **2.0.0-beta.0**: data model + `sensorMap` parsing + compat + configVersion + bootstrap + LEGACY_TYPE_TO_KIND + discovery / notices / ui-state stores + minimal Angular UI. CI green + tests refactored.
2. **2.0.0-beta.1 .. N**: full Angular UI — grouped rows, edit view, unit dropdowns, embed toggle, structural-change modal, Enable/Disable / Remove override / Forget field actions, persistent notice banner.
3. **Late betas**: end-to-end coverage. Maintainer + solmssen exercise every path.
4. **Final beta**: docs polished — README, UPGRADING.md, config.schema.json.

Published under `@beta` dist-tag only.

### 13.2 GA criteria

- CI green throughout beta cycle
- Every invariant in §12 has passing tests
- Zero-migration audit re-verified against shipped default map
- Both testers running latest beta successfully for at least a week
- Angular UI validated in supported HB UI X versions
- CHANGELOG, README, UPGRADING.md describe final shape
- `npm test` in `prepublishOnly` (added at start of beta cycle, verified at GA)

### 13.3 Post-GA

- Deferred: multi-Home tabbed UI (`docs/future/tabbed-config-ui.md`). Angular infrastructure now available; small v2.1 feature if demand emerges.
- Deferred: removing legacy 1.6.0 config fields. No plan; compat layer stays permanently.

## 14. Open questions

Answered up front (via conversation + reviews):

- **Custom UI or schema-driven?** — Custom Angular UI.
- **Where do auto-discovered rows persist?** — Split into three single-writer files: `discovery.json` (plugin), `notices.json` (plugin), `ui-state.json` (UI).
- **Kind change UX?** — Structural-signature-based re-registration with UI confirmation.
- **Bootstrap for existing accessories?** — `LEGACY_TYPE_TO_KIND` + service inspection with AirQuality disambiguation.
- **Config-mode detection?** — Explicit `configVersion` field.
- **Row identity across stations?** — `(dataPoint, stationMac?)`. `stationMac` strictly MAC-shaped.
- **Measurement dimension?** — Separate from `kind`, participates in wrapper selection AND structural signature.
- **Unrecognized rows in the type model?** — Discriminated-union `EffectiveSensorRow`.
- **Structural signature format?** — Human-readable `${kind}|measurement:${m}|battery:${0|1}|wrapper:${name}:${version}` with per-wrapper versions.
- **Cleanup actions?** — Three coherent actions: Enable/Disable, Remove user override (with structural reconciliation), Forget discovered field.
- **Discovery store concurrency?** — Three single-writer files. No shared writes.
- **Discovery write frequency?** — Immediate on new discovery; 15-minute cadence for `lastSeen`-only updates; flush on graceful shutdown.
- **Corrupt persistence file handling?** — Quarantine to `<name>.corrupt-<timestamp>.json`; start with empty store; log warn.
- **Test suite refactor?** — Green every merge. `npm test` in CI immediately and `prepublishOnly` before first public beta.
- **Beta.0 UI?** — Minimal usable UI in beta.0.
- **AirQuality kind disambiguation?** — Density characteristic inspection first, then sensorKey pattern.
- **Migration serialization?** — Formal minimal-diff algorithm per §11.3.
- **Angular UI directory layout?** — `homebridge-ui/{src,dist,server.ts}`.
- **Row-level failure vs whole-plugin failure?** — Row-level for `sensorMap` issues.
- **Kind changes on known dataPoints?** — Only allowed within the same measurement family (§3.8). Physical interpretation of known dataPoints cannot change.
- **`stationMac` accepting name-shaped values?** — Rejected at validation. Row-level failure. UI provides station picker.

Still open (minor):

- **Node/Homebridge version bumps?** No plan.
- **`docs/future/tabbed-config-ui.md` disposition?** Superseded on UI-technology decision.
- **Windows CI matrix?** No plan.

## 15. What's NOT settled — implementation-time judgment

- Angular 17 signals / RxJS / slimmer state library. Decide during implementation.
- Notices size cap details. Lean 100.
- Exact schema-driven fallback shape in `config.schema.json`.
- `awnClient.ts` CommonJS vs ESM. Match plugin's `"type": "module"`.

## 16. Decision log

- **2026-07-08**: v1 drafted. Sent for review.
- **2026-07-09**: First review. Revision incorporated: configVersion, station-layered overrides, discovery store, structural signatures, bootstrap for existing accessories, unit source/display split, property-driven testing, minimal UI in beta.0.
- **2026-07-10**: Second review. Revision incorporated: split discovery + ui-state files with single-writer semantics; consolidated row lifecycle to three actions; canonical `stationMac`; measurement dimension separated from kind; discriminated-union `EffectiveSensorRow`; `triggerDirection` in public interface; row-level vs whole-plugin failure; readable structural signature; AirQuality disambiguation; formal minimal-diff migration; stricter test rule; Angular src/dist layout; station inventory sources when AWN unavailable.
- **2026-07-11**: Third review. This revision incorporates:
  - **Blocking**: three separate single-writer files (`discovery.json`, `notices.json`, `ui-state.json`) — the previous "plugin appends to ui-state.json" compromise had a real lost-update race; now eliminated by strict single-writer per file. `measurement` participates in wrapper selection (`WRAPPER_FOR_KIND_AND_MEASUREMENT`) AND structural signature (`${kind}|measurement:${m}|...`), preventing false in-place updates when the wrapper's HAP graph actually changes.
  - **Important**: Known-datapoint kind-remapping rule formalized (§3.8) — new kind must support existing measurement; physical interpretation cannot change. `stationMac` strictly MAC-shaped — name-shaped values reject at row validation. Discovery write frequency throttled (immediate on new discovery, 15-min cadence on `lastSeen` updates, flush on shutdown, `lastValue` in-memory only). Corrupt persistence files quarantined to timestamped paths (not silently overwritten). `firstSeen`/`lastSeen` optional on configured rows (a row can be configured before the station reports).
  - **Testing**: added multi-process persistence tests + measurement/structural-identity tests (§12.3, §12.4).
- Status: pending fourth review pass. If this revision addresses the remaining blocking issues, the design is ready for implementation.

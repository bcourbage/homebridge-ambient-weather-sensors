# Sensor Map — Design for v2.0

**Status:** Design in review — pending third review pass.
**Last revised:** 2026-07-10 (after second external review — see §16 decision log).
**Implementation phase:** Beta cycle target 2.0.0-beta.0 begins after this doc is signed off; GA target 2.0.0 after test-suite refactor completes.

## 1. Motivation

The plugin has grown three overlapping configuration concerns over v1.5.0 and v1.6.0:

1. **Which sensors to expose** — per-category toggles (`temperatureSensors`, `humiditySensors`, etc.) + `excludeSensors` + `includeOnly` + `stationFilter`
2. **How sensors are named** — no config field today; users rename in Apple Home, which loses the rename if the accessory ever re-registers
3. **Which HomeKit sensor type each AWN field maps to** — hardcoded in `determineSensorType()` in `platform.ts`; users cannot influence this

All three collapse into a single question: **what HomeKit accessory should each AWN datapoint produce?**

The proposal is a **unified sensor map** — a declarative model where each row expresses that question for one AWN datapoint on one station. The plugin ships built-in defaults matching current v1.6.0 behavior; auto-discovery adds rows for AWN fields the plugin doesn't know about; users edit rows through a custom Angular-based configuration UI.

Reference plugins whose approaches informed the design:

- **valiquette/homebridge-Ambient-realtime** — user-defined custom sensors via a `sensors: []` array; no auto-discovery; no default map
- **rhockenbury/homebridge-ecowitt-weather-sensors** — separate `nameOverrides` + `customHidden` fields; no user-defined sensor kinds
- **hjdhjd/homebridge-unifi-protect** — auto-discovered devices in Homebridge's accessory cache; user overrides as terse strings; custom Angular UI in `homebridge-ui/`; separate discovery store

The proposal unifies all three concerns into one model and adopts hjdhjd's process-boundary + persistence pattern.

## 2. Non-goals

- **Not a rewrite of the accessory-wrapper layer**. TemperatureAccessory, HumidityAccessory, etc. continue to exist. The sensor map's `kind` field selects which wrapper class to instantiate.
- **Not adding new HAP characteristics**. The kind vocabulary is exactly the HAP-native sensor services that already work.
- **Not changing the AWN API integration**. The polling + realtime paths stay the same.
- **Not changing `stationFilter` or child-bridge multi-Home behavior**. Orthogonal to sensor mapping; stays as-is.

## 3. Data model

### 3.1 SensorKind — HAP wrapper selector

Twelve values, each corresponding to a HAP-native sensor service the plugin can render.

**Value tiles** — Apple Home renders the live reading directly on the tile:
- `temperature` → `TemperatureSensor`
- `humidity` → `HumiditySensor`
- `light` → `LightSensor` (with W/m² → lux conversion for solar radiation)
- `co2` → `CarbonDioxideSensor`
- `co` → `CarbonMonoxideSensor`
- `air-quality-pm25` → `AirQualitySensor` with PM2_5Density characteristic
- `air-quality-pm10` → `AirQualitySensor` with PM10Density characteristic

**State tiles** — Apple Home renders a boolean state; live value visible in Eve / Controller for HomeKit via custom characteristics:
- `motion` → `MotionSensor` with configurable threshold; used by extended sensors (wind, rain, pressure, UV, lightning)
- `leak` → `LeakSensor`
- `contact` → `ContactSensor`
- `occupancy` → `OccupancySensor`

**Special:**
- `unrecognized` — auto-discovery sentinel for AWN fields not in the plugin's default map. Row does NOT produce a HomeKit accessory until the user assigns a real kind through the UI.

### 3.2 Measurement — physical dimension

Independent of `kind`. Determines allowed units, threshold interpretation, and conversion:

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

**Why separate from `kind`:** `kind: motion` is a HAP-service catch-all for anything without a native value tile — wind, rain, pressure, distance, count all fall under it. But their UNITS are wildly different (mph vs inHg vs mi vs count). A `motion`-kind row that accepts any motion-compatible unit would let a user assign hPa to wind speed, which is nonsense.

Splitting `kind` from `measurement`:
- `kind` determines the HAP wrapper (which `MotionSensor` subclass? or which value-tile service?)
- `measurement` determines the physical dimension (which units are legal? which conversion happens? how is threshold interpreted?)

For known defaults, both are baked in. For custom (unrecognized) rows, the user must declare BOTH before activation.

### 3.3 SensorMapOverride — public config schema

Users write these into `config.json`. Only fields the user has explicitly set appear:

```typescript
interface SensorMapOverride {
  // Required — the AWN field this override applies to.
  dataPoint: string;

  // Optional — restrict this override to a single station.
  // Absent = applies to every station AWN reports (global template).
  // Present = applies only to the station whose macAddress matches
  //           exactly. Station names are NOT accepted here — see §3.3.1
  //           for identity semantics.
  stationMac?: string;

  // Optional — override the default kind for this dataPoint. Required
  // when adding an unrecognized (custom) dataPoint the plugin doesn't
  // know about.
  kind?: SensorKind;

  // Optional — measurement dimension. For custom dataPoints, must be
  // declared alongside kind. Ignored for known defaults (baked into
  // the default map).
  measurement?: Measurement;

  // Optional — display name in HomeKit. Falls back to the default.
  name?: string;

  // Optional — motion-trigger threshold (numeric, stored in sourceUnit).
  threshold?: number;

  // Optional — whether the motion trigger is armed. Default true for
  // motion-kind rows. Set false for informational rows that should
  // never fire (replaces the v1.6.0 internal Infinity sentinel).
  triggerEnabled?: boolean;

  // Optional — trigger direction for motion-kind rows. 'above' means
  // MotionDetected fires when reading >= threshold; 'below' means
  // fires when reading <= threshold. Default 'above'. Meaningful only
  // for kind: motion.
  triggerDirection?: 'above' | 'below';

  // Optional — display unit override. Falls back to the plugin's
  // default for this measurement. Must be legal for the row's
  // measurement (see §3.5).
  displayUnit?: SensorUnit;

  // Optional — for CUSTOM dataPoints only. Declares the unit the
  // AWN payload reports the value in. Ignored for known defaults.
  sourceUnit?: SensorUnit;

  // Optional — AWN batt* field name driving the Battery sub-service.
  // Set to null to explicitly suppress a Battery sub-service that
  // the plugin default would attach.
  batteryField?: string | null;

  // Optional — show the live value in the tile name (embed mode).
  // Default false. Only affects motion-kind rows.
  embedName?: boolean;

  // Optional — explicit disable. Absent or true = enabled. False =
  // the entire accessory (and its Battery sub-service, if any) is
  // NOT registered.
  enabled?: boolean;
}
```

#### 3.3.1 Station identity — persisted as MAC, displayed as name

`stationMac` is the ONLY canonical field for station identity in persisted config. Station names change (users can rename in the AWN app), can be duplicated, and don't survive case-insensitive matching cleanly.

The custom UI displays station names for readability and offers a picker keyed by the current AWN response. When the user picks a station from the picker, the UI writes its MAC address to `stationMac`. Manually-edited configs that use a name-shaped value in `stationMac` log a warn on load — `stationMac 'Cabin' is not a MAC-shaped identifier; matching by name may drift across renames. Use the UI picker or specify the MAC directly.` — and attempt best-effort name resolution against the current AWN response. If the name resolves unambiguously to a MAC, the plugin logs the resolution and proceeds; the next UI save normalizes to the MAC form.

Ambiguous or unresolvable name matches trigger row-level failure (§3.7), not plugin-wide startup failure.

### 3.4 EffectiveSensorRow — internal representation after merge

Discriminated union. Rows that produce accessories carry full unit + measurement information; unrecognized rows carry only observational data:

```typescript
type EffectiveSensorRow =
  | {
      // Auto-discovered field the plugin doesn't have a default for
      // and the user hasn't assigned a kind to yet.
      dataPoint: string;
      stationMac: string;
      kind: 'unrecognized';
      enabled: false;      // literally cannot be enabled — no wrapper to instantiate
      // observational metadata from discovery store
      firstSeen: string;
      lastSeen: string;
      lastValue?: unknown;
    }
  | {
      // Every other row — either a plugin default, a user-configured
      // custom, or a default with user overrides applied.
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
      structuralSignature: string;   // see §9
      // observational metadata from discovery store
      firstSeen?: string;
      lastSeen: string;
      lastValue?: unknown;
    };
```

Invalid states become unrepresentable: an `unrecognized` row cannot have a `measurement` field, and a configured row must have units. TypeScript's discriminant narrowing enforces this at every consumer.

### 3.5 Unit compatibility — allowed by measurement, not by kind

The allowed-unit set for each `measurement` is fixed and small:

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
| `timestamp` | ms | ms | — (rendered as relative time) | — |
| `boolean` | — | — | — | — |

The plugin ships a lookup table `LEGAL_UNITS_FOR_MEASUREMENT: Record<Measurement, SensorUnit[]>` used for validation.

**Validation:**

- If `displayUnit` is set, it must be in the row's `measurement`'s legal set. Otherwise row-level failure (§3.7).
- If `kind` changes on an existing row and the current unit remains legal for the new kind's default measurement (usually not the case for cross-measurement kind changes), keep the unit. If not, auto-select the new measurement's default unit and log a warn.
- Thresholds are ALWAYS stored in `sourceUnit`. Conversion to `displayUnit` happens at render time only.

### 3.6 Trigger semantics

Every default row for `kind: motion` has a fixed `triggerDirection` baked into the plugin's default map. For wind / rain / UV / gust rows, direction is `above`; for pressure and lightning distance, direction is `below`.

`triggerEnabled: false` means "this row's motion state never fires, regardless of threshold." Replaces the v1.6.0 `Infinity` threshold sentinel, which was internal-only and can't be JSON-serialized.

Users can override `triggerDirection` in the raw-JSON view of the UI's advanced tab. Only meaningful for `kind: motion`; validation logs a warn if set on any other kind.

### 3.7 Row validation and failure handling

Config load runs per-row validation. Failure modes and their handling:

| Failure | Handling |
|---|---|
| `dataPoint` missing or empty | Whole-row rejected. Warn: `sensorMap entry with no dataPoint; skipping`. Other rows continue. |
| `kind: unrecognized` set explicitly by user | Ignored. Kind is auto-inferred for unrecognized fields; user can't set it. |
| `stationMac` present but doesn't match any known station in the current AWN response OR the discovery registry | Row loaded but marked "waiting for station". If the station later reports, row activates. |
| Custom `dataPoint` missing `kind` OR `sourceUnit` OR `measurement` | Row-level failure. Row surfaces in UI's "needs attention" group. Other rows continue. |
| `displayUnit` not in the row's `measurement`'s legal set | Row-level failure. Warn with the specific problem. Row surfaces in "needs attention". |
| `triggerDirection` set on a non-motion kind | Ignored with warn. Row still loads. |
| JSON parse failure of `config.json` overall | Whole-plugin startup failure (Homebridge's own behavior; not our concern). |
| Missing `apiKey` / `applicationKey` | Whole-plugin startup failure (existing v1.6.0 behavior; unchanged). |

**Rule:** row-level problems in `sensorMap` never fail the whole plugin. Every valid row still loads. Invalid rows are visible in the UI so users can fix them.

## 4. Config schema — user-facing shape

`config.json` fields for the sensor-map subsystem:

- `configVersion: number` — see §5
- `sensorMap: SensorMapOverride[]` — sparse; only user-modified rows

Everything else (`apiKey`, `applicationKey`, `dataSource`, `stationFilter`, etc.) stays as it is today.

Full example:

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
    // Rename an existing default (applies to all stations)
    { "dataPoint": "tempinf", "name": "Backyard Indoor Temp" },

    // Rename the same dataPoint differently for one specific station
    { "dataPoint": "tempinf", "stationMac": "AA:BB:CC:44:55:66", "name": "Cabin Indoor Temp" },

    // Disable an existing default globally
    { "dataPoint": "lightning_distance", "enabled": false },

    // Change a threshold
    { "dataPoint": "windspeedmph", "threshold": 30 },

    // Change display unit
    { "dataPoint": "windspeedmph", "displayUnit": "kph" },

    // Suppress the WH31L lightning battery sub-service
    { "dataPoint": "lightning_day", "batteryField": null },

    // Add a custom sensor. MUST declare kind, measurement, sourceUnit
    // for the row to activate.
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

The plugin's startup logic distinguishes three cases explicitly. **Ambiguity between "legacy default" and "explicit v2 opt-out" is the reason `configVersion` exists.**

| `configVersion` field | Legacy category toggles present? | Interpretation | Behavior |
|---|---|---|---|
| Absent | Any | Legacy v1 config | Apply compat layer (§6). Absent legacy toggles interpret as v1.6.0 defaults. |
| `2` | No | Explicit v2 config | Start from v2 defaults (all enabled at default-map level). Apply `sensorMap` overrides. No compat translation. |
| `2` | Yes | Invalid | Warn once: `Both configVersion: 2 and legacy toggle <name> are set. configVersion: 2 takes precedence; legacy toggles ignored`. |

**Migration event:** when a user with a legacy config opens the UI and saves any change, the UI:

1. Reads the effective sensor map (compat-translated from legacy)
2. Computes the minimal-diff serialization against the v2 baseline (§11.3)
3. Writes it as sparse `sensorMap[]`
4. Removes the legacy category toggles + `excludeSensors` + `includeOnly` + `thresholds` + `units` + `extendedDisplayMode` + `embedNameUpdateMinIntervalMinutes`
5. Sets `configVersion: 2`

Atomic. Users who never open the UI stay on the legacy shape indefinitely — the compat layer keeps handling them.

**New v2 installs:** the UI writes `configVersion: 2` from the start. No legacy fields are ever created.

## 6. Compat layer (legacy-mode only)

When `configVersion` is absent, legacy fields translate to internal sensor-map state. Deterministic, one-shot per plugin boot. Nothing is written back to `config.json`.

| 1.6.0 field | Value | Effect on effective sensor map |
|---|---|---|
| `temperatureSensors` | true / false / absent | All `kind: temperature` rows → `enabled` set. Absent = false (v1.6.0 default). |
| `humiditySensors` | same | Same, for `kind: humidity` |
| `solarRadiationSensors` | same | Same, for `kind: light` (solar rows only) |
| `co2Sensors` | same | Same, for `kind: co2` |
| `airQualitySensors` | same | Same, for `kind: air-quality-pm25` and `air-quality-pm10` |
| `extendedSensors: false` | | All Motion-kind extended rows → `enabled: false` |
| `extendedSensors: true` | | Sub-category toggles apply |
| `windSensors` / `rainSensors` / `pressureSensors` / `uvSensors` / `lightningSensors` | | Corresponding rows → `enabled` set |
| `thresholds.<foo>Enabled: false` | | Corresponding row → `enabled: false` |
| `thresholds.<foo>Mph` / `.InHr` / `.uv` / `.lightningDistanceMi` / `.pressureInHg` | numeric | Corresponding row's `threshold` set to this value |
| `units.windSpeed` / `.rain` / `.pressure` / `.distance` | e.g. `kph` | Corresponding rows' `displayUnit` set |
| `extendedDisplayMode: embed` | | All Motion-kind rows → `embedName: true` |
| `embedNameUpdateMinIntervalMinutes: N` | | Global setting stays; applied per-row at render time |
| `excludeSensors: ["Foo"]` | | Row(s) whose friendly name or sensorKey matches → `enabled: false`. `-batt` suffix + raw battery-field-name matching from 1.6.0-beta.24 continues to work: matches set `batteryField: null`. |
| `includeOnly: [...]` | | Rows NOT matching → `enabled: false`. Applied AFTER `excludeSensors`. |
| `stationFilter: [...]` | | Not sensor-map related; stays as top-level field. |
| `dataSource` | | Not sensor-map related; stays as top-level field. |

## 7. Effective map construction

The core operation is a **pure function**:

```typescript
function buildEffectiveSensorMap(input: {
  defaultMap: DefaultSensorRow[];
  configMode: 'legacy' | 'v2';
  legacyConfig?: LegacyConfig;
  userOverrides: SensorMapOverride[];
  discovery: DiscoveryStore;
  stations: StationInventory;
}): EffectiveSensorMap
```

Precedence order (later steps override earlier):

1. Built-in defaults from `defaultMap` — global templates (no `stationMac`)
2. Compat-layer transformation (only in legacy mode)
3. Global user overrides (`sensorMap` entries where `stationMac` is absent)
4. Station-specific user overrides (`sensorMap` entries where `stationMac` matches)
5. Runtime availability metadata from discovery + AWN response

Output: an array of `EffectiveSensorRow` — one entry per `(stationMac, dataPoint)` pair that either has a default, is user-overridden, or has been discovered.

Pure (no I/O, no side effects, no clocks). Every input is passed in explicitly. This makes the merge logic deterministic and testable — see §12.

Callers use it in two places:
- Plugin startup (`platform.discoverDevices`) — to determine which accessories to register / restore / re-register
- Angular UI backend — to compute the effective map that the front-end displays

## 8. Persistence — four surfaces

State lives in four separate files/domains. Each has one writer to prevent cross-process races.

| Surface | Writer | Consumer(s) | Purpose |
|---|---|---|---|
| `config.json` | HB UI X (via UI server), or user via text editor | plugin, UI server | User intent — sparse overrides |
| Homebridge accessory cache (`cachedAccessories.*`) | plugin (via `registerPlatformAccessories` etc.) | plugin (on restart) | HomeKit registration state + last-known values |
| `<persistPath>/ambient-weather-discovery.json` | **plugin only** | plugin, UI server (read-only) | Observational — what fields AWN reports |
| `<persistPath>/ambient-weather-ui-state.json` | **UI server only** | plugin (read-only), UI server | UI-specific state — dismissed notices, forgotten fields |

`<persistPath>` resolves to `api.user.persistPath()/plugin-data/ambient-weather/`.

**Single-writer rule:** each file has exactly one process that writes to it. Read-only consumers may read at any time; no locking or optimistic concurrency needed because there are no concurrent writes to any single file.

### 8.1 `config.json` — user intent

Managed by Homebridge (or hand-edited). The plugin reads it at startup; the plugin never writes it. The Angular UI writes it via HB UI X's config persistence APIs.

Fields relevant to sensor map:
- `configVersion: number`
- `sensorMap: SensorMapOverride[]`

Legacy fields (`temperatureSensors`, `excludeSensors`, etc.) are also read from `config.json` in legacy mode. They persist here until the user's first UI save, at which point they're removed atomically (see §5).

### 8.2 Homebridge accessory cache

Managed by Homebridge itself. On restart, HB calls the plugin's `configureAccessory(accessory)` for every previously-registered accessory. The plugin restores runtime state from `accessory.context.device`:

```typescript
interface AccessoryContext {
  uniqueId: string;                    // `${macAddress}-${sensorKey}` — stable across restarts
  displayName: string;                 // last name written to HomeKit
  kind?: SensorKind;                   // NEW in 2.0. See §11.2 bootstrap rule for legacy accessories.
  measurement?: Measurement;           // NEW in 2.0.
  type?: string;                       // legacy 1.6.0 field; kept for bootstrap-time kind inference
  structuralSignature?: string;        // NEW in 2.0. See §9.
  value?: number;
  batteryLow?: boolean;
}
```

The cache is what makes the plugin robust to AWN being offline at startup — cached accessories continue to display their last-known values until AWN comes back.

### 8.3 Plugin discovery store — observational data

Plugin-owned. Plugin-only writes. UI server reads.

Path: `<persistPath>/ambient-weather-discovery.json`

```typescript
interface DiscoveryStore {
  schemaVersion: 1;
  entries: DiscoveredFieldRecord[];
}

interface DiscoveredFieldRecord {
  stationMac: string;
  stationName: string;                 // last-known info.name — for UI display only, not identity
  dataPoint: string;
  firstSeen: string;                   // ISO-8601
  lastSeen: string;                    // ISO-8601 — updated on every poll where the field is present
  lastValue?: unknown;                 // last observed value (for UI preview)
}
```

**Write policy:** the plugin writes `discovery.json` after each successful AWN poll if any records changed. Writes are **atomic**: content is written to `discovery.json.tmp` first, then `fs.rename()`'d to the final path. This is filesystem-atomic on all major OS/filesystem combinations relevant to Homebridge installs.

**Recovery:** if the file is missing, malformed, or has an unrecognized `schemaVersion`, the plugin logs a warn and starts with an empty store. No data loss beyond that specific store; user intent (`config.json`) and HomeKit state (accessory cache) are unaffected.

### 8.4 UI-state store — dismissed notices, forgotten fields

UI-server-owned. UI-only writes. Plugin reads.

Path: `<persistPath>/ambient-weather-ui-state.json`

```typescript
interface UiStateStore {
  schemaVersion: 1;
  notices: SensorMapNotice[];          // seeded by plugin on structural events; dismissed by UI
  forgottenFields: ForgottenField[];   // UI-added when user forgets a discovered field
}

interface SensorMapNotice {
  id: string;                          // UUID
  type: 'kind-change' | 'structural-change';
  stationMac: string;
  dataPoint: string;
  oldSignature?: string;
  newSignature?: string;
  occurredAt: string;
  dismissedAt?: string;
}

interface ForgottenField {
  stationMac: string;
  dataPoint: string;
  forgottenAt: string;
}
```

**Coordinating with the plugin:** since the plugin writes `discovery.json` (which contains observed records) but not `ui-state.json` (which contains dismissals), the plugin needs to know about forgotten fields to skip them on subsequent auto-discovery adds.

Simple mechanism: the plugin reads `ui-state.json` at the START of each `discoverDevices()` invocation. Forgotten field entries suppress that `(stationMac, dataPoint)` combination from being added to the effective map's `unrecognized` list. The plugin does NOT modify `ui-state.json`; if a forgotten field starts reporting again and the user wants to see it, they use the UI to remove the forgotten-field entry (which the UI writes to `ui-state.json`).

**Notices seeded by the plugin:** notices are conceptually plugin-observations but persisted by the UI so dismissals can survive. Solution: the plugin also writes notices — BUT the plugin writes them to a separate append-only file `<persistPath>/ambient-weather-notices-inbox.json` that the UI processes into `ui-state.json` on next open. Inbox → UI-state is a one-way single-writer channel.

Actually, simpler: **the plugin writes notices directly to `ui-state.json`** — accepting a minor violation of the single-writer rule for the small notice-append case, with atomic rename semantics. The read-modify-write is limited to append-only additions; the UI's dismissal writes never conflict because they only modify entries the plugin isn't currently appending. If a race occurs the worst case is a missed notice (informational log line), not lost user intent. Acceptable trade-off.

Design decision to lock in during implementation: **single-writer-plus-append**. Plugin only ever APPENDS to `ui-state.json.notices`; UI only ever modifies existing notices (dismiss) and writes/deletes `forgottenFields` entries. Atomic writes on both sides.

## 9. Structural signature and re-registration

HAP does not allow an accessory's service graph to change on the same UUID once registered. Several row-field changes affect the service graph:

- `kind` — changes the primary service
- `batteryField` presence/absence — adds/removes Battery sub-service
- Canonical-vs-non-canonical status for a battery field
- Wrapper implementation changes across plugin versions

**The design uses a readable structural signature per row**, not a hash:

```typescript
function structuralSignature(row: EffectiveSensorRow): string {
  if (row.kind === 'unrecognized') return 'unrecognized';
  const hasBattery = attachesBatterySubService(row) ? '1' : '0';
  const wrapperVer = WRAPPER_SCHEMA_VERSION[row.kind];
  return `${row.kind}|battery:${hasBattery}|wrapper:${wrapperVer}`;
}
```

Example values: `temperature|battery:1|wrapper:v1`, `motion|battery:0|wrapper:v1`, `air-quality-pm25|battery:1|wrapper:v1`.

Advantages over a hash:
- Human-readable — appears in logs and stored contexts; diagnosable at a glance
- No algorithm choice, no library dependency
- Two versions of the same signature are trivially diff-able for debugging

### 9.1 Per-kind wrapper versions

```typescript
const WRAPPER_SCHEMA_VERSION: Record<Exclude<SensorKind, 'unrecognized'>, string> = {
  temperature: 'v1',
  humidity: 'v1',
  light: 'v1',
  co2: 'v1',
  co: 'v1',
  'air-quality-pm25': 'v1',
  'air-quality-pm10': 'v1',
  motion: 'v1',
  leak: 'v1',
  contact: 'v1',
  occupancy: 'v1',
};
```

Incrementing one kind's version re-registers only accessories of that kind — not all accessories. Bumped when a wrapper's HAP service graph changes (adds a new characteristic, removes one, changes the primary service type).

### 9.2 Names are NOT structural

`name`, `displayName`, `Name` (service characteristic), `ConfiguredName` — none of these affect the signature. Name updates are ordinary metadata refreshes handled by `updatePlatformAccessories()` without re-registration.

### 9.3 Detection

On startup, for each cached accessory:

1. Read `oldSignature = accessory.context.device.structuralSignature` (or bootstrap-infer if absent — see §11.2)
2. Compute `newSignature = structuralSignature(effectiveRowFor(sensorKey))`
3. If they match: update in-place via `updatePlatformAccessories()` — `name`, `displayName`, `Name`, characteristics all refresh
4. If they differ:
   - Log a warn: `Structural change detected for <dataPoint>: <old> → <new>. Re-registering accessory. HomeKit room, automations, and custom name will be lost.`
   - Append a `SensorMapNotice` to `ui-state.json`
   - `unregisterPlatformAccessories(...)` the old accessory
   - `registerPlatformAccessories(...)` a new accessory

### 9.4 Row lifecycle actions in the UI

The UI's "Manage sensors" panel offers three primary actions. Each has coherent runtime semantics — the previous design's ambiguities are resolved:

| Action | Applies to | Behavior |
|---|---|---|
| **Enable / Disable** | Any configured row (default or custom) | Toggles `enabled` in the user override. `false` deregisters the accessory (and its Battery sub-service). `true` re-registers. Idempotent across restarts. |
| **Remove user override** | Any row with a `sensorMap` entry | Removes the entry. Recomputes the effective row against defaults + discovery + compat. Compares structural signature: unchanged = in-place update; changed = structural re-registration with UI confirmation modal beforehand. |
| **Forget discovered field** | Rows for AWN fields not in the default map, currently in the discovery store | Adds a `ForgottenField` entry to `ui-state.json`. That `(stationMac, dataPoint)` no longer appears as an auto-discovered row. If the field is reported by the next AWN poll OR the next realtime event, it stays suppressed until the UI removes the forgotten-field entry. |

The "Remove accessory" action from earlier revisions is **removed** — it was redundant with "Disable" and had incoherent restart semantics.

## 10. Custom Angular UI

Ships in `homebridge-ui/`. Homebridge UI X loads this in place of the schema-driven form when the plugin's config panel is opened.

### 10.1 Directory layout

```
homebridge-ambient-weather-sensors/
├── homebridge-ui/
│   ├── src/                             # Angular source (committed to git)
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
│   ├── awnClient.ts                     # NEW: shared AWN client, used by plugin + UI server
│   └── ...
├── config.schema.json                   # Minimal schema-driven fallback
└── package.json
```

**Committed to git:** `homebridge-ui/src/`, `homebridge-ui/server.ts`, tsconfig.json, angular.json, and other config files. **NOT committed:** `homebridge-ui/dist/`, `homebridge-ui/server.js`. Both are in .gitignore.

**Shipped to npm** (added to package.json's `files` allowlist):
- `homebridge-ui/dist/` — compiled Angular output
- `homebridge-ui/server.js` — compiled Node bridge

**NOT shipped to npm:** source (`homebridge-ui/src/`), tsconfig, angular.json, `server.ts`.

**Build commands:**

```json
"scripts": {
  "build:ui": "cd homebridge-ui && ng build --configuration production && tsc server.ts",
  "build": "…existing plugin build… && npm run build:ui",
  "prepublishOnly": "npm run lint && npm test && npm run build"
}
```

`prepublishOnly` runs the UI build before packaging. If the UI build fails, the release fails.

### 10.2 Process boundary

```
┌─────────────────────────┐      ┌──────────────────────────┐      ┌─────────────────────┐
│  Angular front-end      │      │  homebridge-ui/server.js │      │  Plugin process     │
│  (browser)              │◄────►│  (short-lived, spawned    │      │  (long-lived,       │
│                         │      │   by HB UI X per session) │      │   the actual plugin)│
│                         │      │                          │      │                     │
│  reads/writes:          │      │  reads:                  │      │  writes:            │
│    effective map view   │      │    config.json           │      │    HB accessory     │
│    validated overrides  │      │    discovery.json (RO)   │      │    cache            │
│                         │      │    ui-state.json         │      │    discovery.json   │
│                         │      │    accessory cache (RO)  │      │    ui-state.json    │
│                         │      │  writes:                 │      │      (notices only, │
│                         │      │    config.json           │      │       via append)   │
│                         │      │    ui-state.json         │      │                     │
└─────────────────────────┘      └──────────────────────────┘      └─────────────────────┘
```

The UI server and the plugin process do not directly communicate. State passes through the four persistence surfaces (§8).

### 10.3 Shared AWN client

`src/awnClient.ts` — a shared module both the plugin and the UI server import:

- REST call to `https://rt.ambientweather.net/v1/devices?applicationKey=...&apiKey=...`
- 429 retry-with-backoff
- Same JSON parsing + type validation

The plugin uses this on normal polls; the UI server uses it ONLY when the user clicks "Refresh from Ambient Weather" — never as a background/startup fetch. Credentials never round-trip through the browser; the UI server reads them from `config.json`, passes them to `awnClient`, returns sanitized response to the front-end.

### 10.4 Station inventory when AWN is unavailable

The effective-map builder takes a `stations: StationInventory` input. The UI server produces this by unioning multiple sources, in preference order:

1. **Current AWN response** (freshest) — if a poll or manual refresh succeeded within the last few minutes
2. **Discovery registry** (`discovery.json`) — every station ever observed, with last-seen timestamps
3. **Accessory cache** — every station represented in a cached accessory's `uniqueId` prefix
4. **`stationMac` values in `config.json`** — every station the user has station-specific overrides for

The union gives every station the user has EVER interacted with, whether or not AWN is currently reachable. Rows for currently-unreachable stations appear grayed with a "not currently reporting" indicator.

Station display names come from the freshest source that has one (usually AWN response, falling back to discovery registry's `stationName` field, then to the MAC address itself).

### 10.5 Front-end responsibilities

- Render the sensor-map table with grouped-row layout
- Row expansion for editing; kind + measurement + unit dropdowns
- Structural-change confirmation modal (blocks save on kind change, batteryField add/remove)
- Row-level failure surfacing in "needs attention" group
- Enable/Disable / Remove user override / Forget discovered field actions (§9.4)
- Persistent notice banner reading from `ui-state.json`
- Advanced tab — raw JSON view for `sensorMap`, `triggerDirection` and other seldom-used fields

### 10.6 Schema-driven fallback

`config.schema.json` continues to ship. If a user disables custom UI in HB UI X preferences, they see a minimal schema-driven form that lets them edit the raw `sensorMap` array of objects. Not the polished UX, but always available.

## 11. Migration semantics

Existing v1.6.0 users must upgrade to v2.0 with zero HomeKit state loss.

### 11.1 Default map preserves service types

The plugin's default sensor map for v2.0 is constructed so that **every AWN sensorKey v1.6.0 exposes produces the same HAP service type in v2.0**. The audit table:

| sensorKey | v1.6.0 service | Legacy `type` | Inferred kind | v2.0 default kind | v2.0 service | Match |
|---|---|---|---|---|---|---|
| `tempf` .. `dewPoint` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `humidity` .. `humidityin` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `solarradiation` | LightSensor | `Solar Radiation` | light | light | LightSensor | ✓ |
| `co2` .. `co2_in_aqin` | CarbonDioxideSensor | `CO2` | co2 | co2 | CarbonDioxideSensor | ✓ |
| `pm25`, `pm25_in_aqin` | AirQualitySensor | `PM2.5` | air-quality-pm25 | air-quality-pm25 | AirQualitySensor + PM2_5Density | ✓ |
| `pm10_in_aqin` | AirQualitySensor | `PM10` | air-quality-pm10 | air-quality-pm10 | AirQualitySensor + PM10Density | ✓ |
| `pm_in_temp_aqin` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `pm_in_humidity_aqin` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `uv` | MotionSensor + custom chars | `UV` | motion | motion | MotionSensor + custom chars | ✓ |
| `windspeedmph` .. `winddir_avg10m` | MotionSensor + custom chars | Various wind types | motion | motion | MotionSensor + custom chars | ✓ |
| `hourlyrainin` .. `lastRain` | MotionSensor + custom chars | Various rain types | motion | motion | MotionSensor + custom chars | ✓ |
| `baromrelin`, `baromabsin` | MotionSensor + custom chars | Pressure types | motion | motion | MotionSensor + custom chars | ✓ |
| `lightning_*` | MotionSensor + custom chars | Lightning types | motion | motion | MotionSensor + custom chars | ✓ |
| `temp{N}f` .. `dewPoint{N}` | Various native | Various | temperature / humidity | temperature / humidity | Same | ✓ |

All ✓ by construction.

### 11.2 Bootstrap rule for existing cached accessories

Existing v1.6.0 cached accessories do NOT have `kind`, `measurement`, or `structuralSignature` in their context. On first v2.0 startup, apply this fallback chain per accessory, in order:

```typescript
function inferKindForCachedAccessory(accessory: PlatformAccessory): SensorKind {
  // 1. Explicit — set by v2 write or later
  const explicitKind = accessory.context.device?.kind;
  if (explicitKind) return explicitKind;

  // 2. Legacy `type` field — set by v1.5.0 through v1.6.x
  const legacyType = accessory.context.device?.type;
  if (legacyType && LEGACY_TYPE_TO_KIND[legacyType]) {
    return LEGACY_TYPE_TO_KIND[legacyType];
  }

  // 3. HAP-service inspection — worst-case fallback for very old accessories
  //    whose context has no kind AND no legacy type field.
  return inferKindFromServices(accessory);
}

function inferKindFromServices(accessory: PlatformAccessory): SensorKind {
  const services = accessory.services.filter(s => s.UUID !== ACCESSORY_INFORMATION_SERVICE_UUID);
  const service = services[0];  // primary service; ignore Battery sub-service
  if (!service) return 'unrecognized';

  switch (service.UUID) {
    case TEMPERATURE_SENSOR_UUID: return 'temperature';
    case HUMIDITY_SENSOR_UUID:    return 'humidity';
    case LIGHT_SENSOR_UUID:       return 'light';
    case CARBON_DIOXIDE_SENSOR_UUID:  return 'co2';
    case CARBON_MONOXIDE_SENSOR_UUID: return 'co';
    case MOTION_SENSOR_UUID:      return 'motion';
    case LEAK_SENSOR_UUID:        return 'leak';
    case CONTACT_SENSOR_UUID:     return 'contact';
    case OCCUPANCY_SENSOR_UUID:   return 'occupancy';

    case AIR_QUALITY_SENSOR_UUID:
      // Disambiguate by which optional density characteristic is present.
      if (service.testCharacteristic(PM2_5_DENSITY_UUID)) return 'air-quality-pm25';
      if (service.testCharacteristic(PM10_DENSITY_UUID))  return 'air-quality-pm10';
      // Both present or neither — ambiguous. Best-effort fallback: use the sensorKey pattern.
      // e.g., context.device.uniqueId contains 'pm25' → pm25 variant; 'pm10' → pm10 variant.
      if (accessory.context.device?.uniqueId?.includes('pm10')) return 'air-quality-pm10';
      return 'air-quality-pm25';  // safest default given AWN's more common PM2.5 exposure

    default:
      return 'unrecognized';
  }
}
```

`LEGACY_TYPE_TO_KIND`:

```typescript
const LEGACY_TYPE_TO_KIND: Record<string, SensorKind> = {
  'Temperature':       'temperature',
  'Humidity':          'humidity',
  'Solar Radiation':   'light',
  'CO2':               'co2',
  'PM2.5':             'air-quality-pm25',
  'PM10':              'air-quality-pm10',
  'WindSpeed':         'motion',
  'WindGust':          'motion',
  'WindMaxDailyGust':  'motion',
  'WindDirection':     'motion',
  'WindDirection10m':  'motion',
  'RainRate':          'motion',
  'RainEvent':         'motion',
  'RainDaily':         'motion',
  'RainWeekly':        'motion',
  'RainMonthly':       'motion',
  'RainYearly':        'motion',
  'LastRain':          'motion',
  'PressureRelative':  'motion',
  'PressureAbsolute':  'motion',
  'UV':                'motion',
  'LightningDay':      'motion',
  'LightningHour':     'motion',
  'LightningDistance': 'motion',
  'LightningLastStrike': 'motion',
};
```

Once bootstrap-inferred, kind + measurement + structuralSignature are written to context via `updatePlatformAccessories()` — no HAP re-registration.

The service-UUID fallback (#3) is best-effort. AirQuality variants use characteristic inspection first, then sensorKey pattern matching. Motion-kind returns `motion` without further disambiguating the measurement — that's read from the sensorKey via the default map on next `discoverDevices` pass, and populated then. Documented as best-effort in the log.

### 11.3 Formal minimal-diff migration serialization

When the UI migrates a legacy config to v2, it needs to serialize the effective map to sparse `sensorMap[]` entries. The algorithm:

**Input:** the effective sensor map after applying legacy → v2 compat translation.

**Output:** an array of `SensorMapOverride` entries, minimal such that:

> A migrated override contains only fields whose effective legacy value differs from the v2 built-in baseline for the same `(stationMac, dataPoint)`.

**Algorithm:**

```typescript
function serializeMinimalOverrides(
  effectiveMap: EffectiveSensorRow[],
  v2Baseline: DefaultSensorRow[],
  observedStations: string[]
): SensorMapOverride[] {
  const overrides: SensorMapOverride[] = [];

  // Group effective rows by dataPoint. For each dataPoint:
  //   - Look up the v2 baseline row.
  //   - Compute the field-level diff for each station.
  //   - If all stations have the same diff, emit ONE global override.
  //   - If stations diverge, emit per-station overrides for the ones that differ from the baseline.

  const byDataPoint = groupBy(effectiveMap, r => r.dataPoint);
  for (const [dataPoint, rows] of byDataPoint) {
    const baseline = v2Baseline.find(r => r.dataPoint === dataPoint);
    if (!baseline) {
      // Custom sensor — emit a full override per station.
      for (const row of rows) {
        overrides.push(fullOverrideFor(row));
      }
      continue;
    }
    const diffs = rows.map(row => ({ stationMac: row.stationMac, diff: fieldDiff(row, baseline) }));
    if (allSameDiff(diffs) && diffs.length === observedStations.length) {
      // Every station has the same override — write as global.
      if (Object.keys(diffs[0].diff).length > 0) {
        overrides.push({ dataPoint, ...diffs[0].diff });
      }
    } else {
      // Divergent — write per-station only for stations whose diff is non-empty.
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

**Idempotency test** (part of §12):

```
legacyConfig
  → applyCompatLayer → effectiveMap1
  → serializeMinimalOverrides(effectiveMap1, v2Baseline) → overrides1
  → simulateV2Load(overrides1) → effectiveMap2
  → assertEqual(effectiveMap1, effectiveMap2)
```

The two effective maps must be identical row-for-row.

**Determinism:** the serialization is deterministic — running it twice on the same input produces identical output (same overrides in the same order). Otherwise repeated UI saves would produce different-but-equivalent arrays and cause spurious diffs in `config.json`.

### 11.4 What DOES change on upgrade

- Users who open the plugin config in HB UI see the Angular UI instead of the schema-driven form
- Auto-discovered rows appear in the UI for AWN fields the plugin doesn't have defaults for — informational (they don't create accessories) until the user assigns a kind
- The `[embed-diag]` debug log lines continue to exist but are subsumed by richer per-sensor logging

### 11.5 User rename behavior

The plugin manages three name-adjacent characteristics on each accessory:

- `accessory.displayName` — Homebridge's own field, controls what HB UI shows
- Service `Name` — HAP standard characteristic, shows in Apple Home before user rename
- Service `ConfiguredName` — HAP 2.x standard, shows in Apple Home after user rename

The plugin already has logic for this from v1.5.0-beta.15/beta.16/beta.17. Under sensor-map:

- **`displayName` and service `Name`** update on every restart from the effective row's `name` field. Guarantees the HB UI + Home-app first-render show the user's plugin-config name.
- **Service `ConfiguredName`** is set ONCE at accessory registration. If the user renames the tile in Apple Home, HAP updates `ConfiguredName` and the plugin's `isUserRenamed()` check detects divergence from the last plugin-written name. Once detected, the plugin stops overwriting `ConfiguredName` — user rename wins.
- **Kind change / structural re-registration** deregisters the accessory. Apple Home considers the new accessory fresh — `ConfiguredName` is set from the plugin's `name`, not the previous user rename (which is lost with the old accessory).

The Angular UI displays user-renames as "user-set" on affected rows, indicating that Apple Home rename takes precedence for that tile.

## 12. Testing plan

### 12.1 Existing test coverage — how it ports

The 385-test suite merged in v1.6.0 covers pure functions, wrapper classes, `parseDevices()`, and beta.5/beta.16/beta.23 regressions.

Under sensor-map:
- **Pure-function tests**: unchanged
- **Wrapper tests**: mostly unchanged — accessory classes themselves aren't rewritten
- **Existing `parseDevices` tests**: substantially rewritten; expressed in terms of `buildEffectiveSensorMap` semantics
- **Regression tests**: unchanged

### 12.2 New tests — property-driven and invariant-based

Rather than 200-400 handwritten tests, use **property-driven parameterized tests over invariants**. The audit table (§11.1) and default map are machine-readable — parameterize over them:

```typescript
describe('default sensor map invariants', () => {
  for (const row of DEFAULT_SENSOR_MAP) {
    test(`${row.dataPoint}: kind resolves to a wrapper`, () => {
      expect(WRAPPER_FOR_KIND[row.kind]).toBeDefined();
    });
    test(`${row.dataPoint}: measurement is compatible with kind`, () => {
      expect(COMPATIBLE_MEASUREMENTS[row.kind]).toContain(row.measurement);
    });
    test(`${row.dataPoint}: displayUnit is legal for measurement`, () => {
      expect(LEGAL_UNITS_FOR_MEASUREMENT[row.measurement]).toContain(row.displayUnit);
    });
  }
});
```

Invariants covered by property-driven tests:

1. **Wrapper coverage**: every `SensorKind` (except `unrecognized`) resolves to exactly one wrapper class.
2. **Measurement compatibility**: every kind → measurement mapping in the default map is legal.
3. **Unit legality**: every default row's units are in the allowed set for its measurement.
4. **Canonical battery**: for every batteryField, exactly one row in the default map is canonical.
5. **Legacy compat coverage**: every legacy `type` value in the accessory-cache universe (from v1.5.0 and v1.6.0) maps to a real kind via `LEGACY_TYPE_TO_KIND`.
6. **Compat determinism**: for every legacy config field, translation is idempotent (`compat(compat(cfg)) === compat(cfg)`).
7. **Effective-map determinism**: `buildEffectiveSensorMap(x)` is a pure function — same inputs produce same output.
8. **Sparse-serialize round-trip**: serializing the effective map's user-overrides to sparse `sensorMap[]`, deserializing, and re-computing produces the same effective map.
9. **Migration idempotency**: `legacyConfig → effective → sparse → v2Load → effective` yields the same effective map (§11.3).
10. **Structural signature stability**: for every default row + a fixed wrapper schema version, the signature is deterministic across runs.
11. **v1 fixture equivalence**: for every legacy 1.6.0 config fixture, the accessories produced under v2.0 have the same structural signatures as under v1.6.0 (proves zero-migration).
12. **Bootstrap coverage**: for every entry in `LEGACY_TYPE_TO_KIND`, bootstrap inference produces the same kind that the default map assigns for the corresponding sensorKey.

Total new test count is likely lower than 200-400 in absolute terms but higher in coverage per line.

### 12.3 Suite stays green throughout — every merge

**Every merge to the implementation branch must leave CI green.** No same-day companion-PR loophole; no known-failing tests during transition. Rationale: a company-PR pattern is fine for local development but doesn't help anyone checking out an intermediate commit, bisecting a regression, or reviewing beta history.

`npm test` is added to CI immediately at the start of the beta cycle. Added to `prepublishOnly` **before publishing 2.0.0-beta.0** — not deferred to GA.

Any implementation change that would break tests must include the test refactor IN THE SAME PR that makes the code change. If that grows unmanageably large, split the work into smaller code+test PRs each of which independently leaves CI green.

## 13. Rollout plan

### 13.1 Beta cycle

1. **2.0.0-beta.0**: data model + `sensorMap` parsing + compat layer + configVersion detection + kind/structural bootstrap rule + LEGACY_TYPE_TO_KIND + discovery + ui-state stores + minimal Angular UI (read-only effective-map table, enable/disable, name, kind selector, raw-JSON advanced view). CI green + tests refactored to match new model.
2. **2.0.0-beta.1 .. N**: full Angular UI — grouped rows, edit view, unit dropdowns, embed toggle, structural-change confirmation modal, Enable/Disable / Remove override / Forget field actions, persistent notice banner.
3. **Toward final betas**: end-to-end tester coverage. Maintainer + solmssen exercise every path.
4. **Final beta**: docs polished. README, UPGRADING.md, config.schema.json all describe the new shape.

Published under `@beta` npm dist-tag only. Existing users on `@latest` stay on v1.6.0.

### 13.2 GA criteria

Before promoting to `@latest`:

- CI green throughout the beta cycle (§12.3)
- Every invariant in §12.2 has passing tests
- Zero-migration audit re-verified against the shipped default map (§11.1)
- Both testers running the latest beta successfully for at least a week without regressions
- Angular UI validated in the HB UI X versions the plugin supports
- CHANGELOG, README, UPGRADING.md describe final shape
- `npm test` in `prepublishOnly` (added at start of beta cycle, verified working at GA)

### 13.3 Post-GA

- Deferred: multi-Home tabbed UI (`docs/future/tabbed-config-ui.md`). Angular infrastructure now available; small v2.1 feature if demand emerges.
- Deferred: removing legacy 1.6.0 config fields. No plan; compat layer stays permanently.

## 14. Open questions

Answered up front (via conversation + reviews):

- **Custom UI or schema-driven?** — Custom Angular UI.
- **Where do auto-discovered rows persist?** — Split into `discovery.json` (plugin-owned) + `ui-state.json` (UI-owned) under `api.user.persistPath()`.
- **Kind change UX?** — Structural-signature-based re-registration with UI confirmation.
- **Bootstrap for existing accessories?** — `LEGACY_TYPE_TO_KIND` + service inspection with AirQuality density-characteristic disambiguation; written to context via `updatePlatformAccessories`.
- **Config-mode detection?** — Explicit `configVersion` field.
- **Row identity across stations?** — Rows keyed by `(dataPoint, stationMac?)`. `stationMac` (canonical) is the persisted station identity; UI displays name but stores MAC.
- **Measurement dimension?** — Separate from `kind`. Determines allowed units, conversion, threshold interpretation.
- **Unrecognized rows in the type model?** — Discriminated-union `EffectiveSensorRow` — unrecognized rows don't carry units.
- **Structural signature format?** — Human-readable `${kind}|battery:${0|1}|wrapper:${version}` with per-kind versions.
- **Cleanup actions?** — Three coherent actions: Enable/Disable, Remove user override (with structural reconciliation), Forget discovered field.
- **Discovery store concurrency?** — Split-writer: plugin writes `discovery.json` + APPENDS notices to `ui-state.json`; UI writes dismissals + `forgottenFields` to `ui-state.json`. Atomic file writes on both sides.
- **Test suite refactor?** — Green every merge. `npm test` in CI immediately and `prepublishOnly` before first public beta.
- **Beta.0 UI?** — Minimal usable UI in beta.0.
- **AirQuality kind disambiguation in bootstrap?** — Optional density characteristic inspection first, then sensorKey pattern.
- **Migration serialization?** — Formal minimal-diff algorithm per §11.3, with idempotency + determinism tests.
- **Angular UI directory layout?** — `homebridge-ui/{src,dist,server.ts}`. Only `dist/` + `server.js` ship to npm.
- **Row-level failure vs whole-plugin failure?** — Row-level for `sensorMap` issues; whole-plugin only for platform-level failures.

Still open (minor):

- **Node/Homebridge version bumps?** No plan.
- **`docs/future/tabbed-config-ui.md` disposition?** Superseded on UI-technology decision; multi-Home tabs use case deferred to v2.1+.
- **Windows CI matrix?** No plan; plugin is macOS-focused in practice.

## 15. What's NOT settled — questions this doc still leaves for implementation-time judgment

- Whether the Angular front-end uses Angular 17 signals, older RxJS, or a slimmer state library. Decide during implementation; no user-visible consequence.
- Whether `ui-state.json.notices` array is size-capped (e.g., last 50 events) or unbounded until manually cleared. Lean toward capped.
- Exact schema-driven fallback shape in `config.schema.json`. Live-editable but minimal.
- Whether the `awnClient.ts` module is CommonJS or ESM. Match plugin's `"type": "module"` in package.json.

## 16. Decision log

- **2026-07-08**: v1 of this doc drafted after conversation-level design discussion. Sent for external review.
- **2026-07-09**: External review returned. First revision incorporated: configVersion, station-layered overrides, discovery store, structural signatures, bootstrap rule for existing accessories, unit source/display split, property-driven testing, minimal UI in beta.0.
- **2026-07-10**: Second external review returned. This revision incorporates:
  - **Blocking-issue resolutions**: split discovery persistence into two files (`discovery.json` + `ui-state.json`) with single-writer semantics; consolidated row lifecycle to three coherent actions (Enable/Disable, Remove override, Forget discovered field); canonical `stationMac` (not `stationId`) for station identity; measurement dimension separated from kind; discriminated-union `EffectiveSensorRow` for unrecognized rows
  - **Important corrections**: `triggerDirection` added to public `SensorMapOverride` shape; row-level failure for invalid `sensorMap` entries (not whole-plugin startup failure); readable structural signature format with per-kind wrapper versions; names explicitly excluded from structural signature; AirQuality PM2.5/PM10 disambiguation via characteristic inspection in bootstrap; formal minimal-diff migration serialization with idempotency + determinism tests
  - **Smaller observations**: stricter "every merge green" test rule (no companion-PR loophole); Angular UI directory layout with `src/dist/server.ts` split; station inventory sources when AWN unavailable
- Status: pending third review pass. If this revision addresses the remaining blocking issues, the design is ready for implementation.

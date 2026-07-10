# Sensor Map — Design for v2.0

**Status:** Design in review. Not yet approved for implementation.
**Last revised:** 2026-07-09 (after external review — see §16 decision log for the changes).
**Implementation phase:** Beta cycle target 2.0.0-beta.0 begins after this doc is signed off; GA target 2.0.0 after test-suite refactor.

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

### 3.1 Public config schema — sparse user overrides

Users write these into `config.json`. Only fields the user has explicitly set appear:

```typescript
interface SensorMapOverride {
  // Required — the AWN field this override applies to.
  dataPoint: string;

  // Optional — restrict this override to a single station.
  // Absent = applies to every station AWN reports (global template).
  // Present = applies only to the station whose macAddress OR info.name
  //           matches (case-insensitive). Layered on top of global overrides.
  stationId?: string;

  // Optional — override the default kind for this dataPoint. Required
  // when adding an unrecognized (custom) dataPoint the plugin doesn't
  // know about. Changing kind on an existing dataPoint triggers a
  // structural re-registration; see §9.
  kind?: SensorKind;

  // Optional — display name in HomeKit. Falls back to the default.
  name?: string;

  // Optional — motion-trigger threshold (numeric).
  threshold?: number;

  // Optional — whether the motion trigger is armed at all. Default
  // true for kinds that use MotionSensor. Set false for informational
  // motion-kind rows that should never fire (replaces the Infinity
  // sentinel that couldn't survive JSON serialization).
  triggerEnabled?: boolean;

  // Optional — display unit override. Source unit is fixed per
  // dataPoint (see §3.4); the user can only override how the value
  // is presented. For custom sensors, the user must ALSO declare
  // sourceUnit (below) before the row can be activated.
  displayUnit?: SensorUnit;

  // Optional — for CUSTOM dataPoints only. Declares the unit the
  // AWN payload reports the value in. Ignored for known defaults
  // (whose source unit is fixed by the plugin).
  sourceUnit?: SensorUnit;

  // Optional — AWN batt* field name driving the Battery sub-service.
  // Set to null to explicitly suppress a Battery sub-service that
  // the plugin default would attach.
  batteryField?: string | null;

  // Optional — show the live value in the tile name (embed mode).
  // Default false. Only affects Motion-kind rows; HAP-native value
  // tiles render the reading directly and ignore this flag.
  embedName?: boolean;

  // Optional — explicit disable. Absent or true = enabled. False =
  // the entire accessory (and its Battery sub-service, if any) is
  // NOT registered.
  enabled?: boolean;
}
```

### 3.2 Effective row — internal representation after merge

After `buildEffectiveSensorMap` (see §7) resolves defaults, compat translation, and user overrides, each row is fully populated:

```typescript
interface EffectiveSensorRow {
  dataPoint: string;
  stationId: string;              // resolved — the specific station this instance applies to
  kind: SensorKind;
  name: string;                   // always populated (falls back to default)
  threshold: number | undefined;  // undefined = threshold not meaningful for this kind
  triggerEnabled: boolean;
  triggerDirection: 'above' | 'below';   // baked in per default row; not user-editable in primary UI
  sourceUnit: SensorUnit;
  displayUnit: SensorUnit;
  batteryField: string | null;
  embedName: boolean;
  enabled: boolean;
}
```

### 3.3 Kind enum

Twelve values corresponding to HAP-native sensor services the plugin can render:

**Value tiles** — Apple Home renders the live reading directly on the tile:
- `temperature` → `TemperatureSensor`
- `humidity` → `HumiditySensor`
- `light` → `LightSensor` (with W/m² → lux conversion for solar radiation)
- `co2` → `CarbonDioxideSensor`
- `co` → `CarbonMonoxideSensor`
- `air-quality-pm25` → `AirQualitySensor` with PM2_5Density
- `air-quality-pm10` → `AirQualitySensor` with PM10Density

**State tiles** — Apple Home renders a boolean state; live value visible in Eve / Controller for HomeKit if the wrapper adds custom characteristics:
- `motion` → `MotionSensor` with configurable threshold; used by extended sensors (wind, rain, pressure, UV, lightning)
- `leak` → `LeakSensor`
- `contact` → `ContactSensor`
- `occupancy` → `OccupancySensor`

**Special:**
- `unrecognized` — auto-discovery sentinel for AWN fields not in the plugin's default map. Row does NOT produce a HomeKit accessory until the user assigns a real kind through the UI.

### 3.4 Unit model

Every SensorKind has a compatible set of units. Source unit (what AWN reports) is separate from display unit (what HomeKit renders):

| Kind | Allowed units | Default source | Default display | Conversion |
|---|---|---|---|---|
| temperature | fahrenheit, celsius | fahrenheit | fahrenheit | °F↔°C |
| humidity | percent | percent | percent | — |
| light | wm2, lux | wm2 (for solar), lux (for direct) | lux | W/m² × 127 → lux |
| co2 / co | ppm | ppm | ppm | — |
| air-quality-* | ugm3 | ugm3 | ugm3 | — |
| motion (wind speed) | mph, kph, mps, kts | mph | mph | linear |
| motion (rain rate) | in_per_hr, mm_per_hr | in_per_hr | in_per_hr | ×25.4 |
| motion (rain accumulation) | in, mm | in | in | ×25.4 |
| motion (pressure) | inHg, hPa | inHg | inHg | ×33.8639 |
| motion (distance) | mi, km, nm | mi | mi | linear |
| motion (UV, count, direction) | index / count / degrees | dimensionless | dimensionless | — |
| motion (timestamp) | ms | ms | — | rendered as relative time |
| leak / contact / occupancy | — | — | — | boolean state |

Validation rules:

- If the user sets `displayUnit`, it must be in the allowed set for the row's `kind`. Otherwise startup fails validation.
- If the user changes `kind` on an existing row and the current unit is not allowed for the new kind, the plugin auto-selects the new kind's default unit and warns.
- For custom (unrecognized) dataPoints, the user MUST declare `sourceUnit` when assigning a `kind`. Otherwise the row stays inactive.
- Thresholds are always stored in `sourceUnit`. Conversion to `displayUnit` happens at render time only.

### 3.5 Trigger semantics

Every default row for `kind: motion` has a fixed `triggerDirection` baked into the plugin's default map (not user-editable in the primary UI). For wind / rain / UV / gust rows, direction is `above`; for pressure and lightning distance, direction is `below`.

Users who add a custom Motion-kind sensor default to `triggerDirection: above`. Advanced users can override via the raw-JSON view (§10.4).

`triggerEnabled: false` means "this row's motion state never fires, regardless of threshold." Replaces the v1.6.0 `Infinity` threshold sentinel, which was internal-only. In JSON, `triggerEnabled: false` is explicit and serializable.

## 4. Config schema — user-facing shape

`config.json` has these fields for the sensor-map subsystem:

- `configVersion: number` — see §5 for detection semantics
- `sensorMap: SensorMapOverride[]` — sparse array, only user-modified rows

Everything else (`apiKey`, `applicationKey`, `dataSource`, `stationFilter`, etc.) stays as it is today.

Full example with mixed overrides:

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
    { "dataPoint": "tempinf", "stationId": "Cabin WS-5000", "name": "Cabin Indoor Temp" },

    // Disable an existing default globally
    { "dataPoint": "lightning_distance", "enabled": false },

    // Change a threshold
    { "dataPoint": "windspeedmph", "threshold": 30 },

    // Suppress the WH31L lightning battery sub-service
    { "dataPoint": "lightning_day", "batteryField": null },

    // Add a custom sensor for an AWN field the plugin doesn't know about.
    // MUST declare kind AND sourceUnit for the row to activate.
    {
      "dataPoint": "soilmoisture1",
      "kind": "humidity",
      "sourceUnit": "percent",
      "name": "Garden Moisture",
      "batteryField": "batt_soil"
    }
  ]
}
```

## 5. Config-mode detection

The plugin's startup logic distinguishes three cases explicitly. **Ambiguity between "legacy default" and "explicit v2 opt-out" is the reason `configVersion` exists.**

| `configVersion` field | Legacy category toggles (`temperatureSensors` etc.) | Interpretation | Behavior |
|---|---|---|---|
| Absent | Present or absent | Legacy v1 config | Apply compat layer (§6). Absent legacy toggles interpret as v1.6.0 defaults (all `false` = all disabled). |
| `2` | Absent | Explicit v2 config | Start from v2 defaults (all enabled at default-map level). Apply `sensorMap` overrides. No compat translation. |
| `2` | Present | Invalid | Warn: "Both `configVersion: 2` and legacy toggle `<name>` are set. `configVersion: 2` takes precedence; legacy toggles ignored." |

**Migration event:** when a user with a legacy config opens the UI and saves any change, the UI:

1. Reads the effective sensor map (compat-translated from legacy)
2. Writes it as sparse `sensorMap[]` entries
3. Removes the legacy category toggles + `excludeSensors` + `includeOnly` + `thresholds` + `units` + `extendedDisplayMode` + `embedNameUpdateMinIntervalMinutes`
4. Sets `configVersion: 2`

That's the atomic migration. Users who never open the UI stay on the legacy shape indefinitely — the compat layer keeps handling them.

**New v2 installs:** the UI writes `configVersion: 2` from the start. No legacy fields are ever created.

## 6. Compat layer (legacy-mode only)

When `configVersion` is absent, legacy fields translate to internal sensor-map state. The translation is deterministic and one-shot per plugin boot. Nothing is written back to `config.json`.

| 1.6.0 field | Value | Effect on effective sensor map |
|---|---|---|
| `temperatureSensors` | true / false / absent | All `kind: temperature` rows → `enabled` set. Absent = false (v1.6.0 default). |
| `humiditySensors` | same | Same, for `kind: humidity` |
| `solarRadiationSensors` | same | Same, for `kind: light` (solar rows only) |
| `co2Sensors` | same | Same, for `kind: co2` |
| `airQualitySensors` | same | Same, for both `kind: air-quality-pm25` and `air-quality-pm10` |
| `extendedSensors: false` | | All Motion-kind rows for extended sensor sensorKeys → `enabled: false` |
| `extendedSensors: true` | | Sub-category toggles below apply |
| `windSensors` / `rainSensors` / `pressureSensors` / `uvSensors` / `lightningSensors` | | Corresponding rows → `enabled` set |
| `thresholds.<foo>Enabled: false` | | Corresponding row → `enabled: false` |
| `thresholds.<foo>Mph` / `.InHr` / `.uv` / `.lightningDistanceMi` / `.pressureInHg` | numeric | Corresponding row's `threshold` set to this value |
| `units.windSpeed` / `.rain` / `.pressure` / `.distance` | e.g. `kph` | Corresponding rows' `displayUnit` set |
| `extendedDisplayMode: embed` | | All Motion-kind rows → `embedName: true` |
| `embedNameUpdateMinIntervalMinutes: N` | | Global setting stays; applied per-row at render time |
| `excludeSensors: ["Foo"]` | | Row(s) whose friendly name or sensorKey matches → `enabled: false`. `-batt` suffix + raw battery-field-name matching from 1.6.0-beta.24 continues to work: matches set `batteryField: null`. |
| `includeOnly: [...]` | | Rows NOT matching → `enabled: false`. Applied AFTER `excludeSensors`. |
| `stationFilter: [...]` | | Not sensor-map related; stays as top-level field |
| `dataSource` | | Not sensor-map related; stays as top-level field |

## 7. Effective map construction

The core operation is expressed as a **pure function**:

```typescript
function buildEffectiveSensorMap(input: {
  defaultMap: DefaultSensorRow[];       // built-in, from code
  configMode: 'legacy' | 'v2';          // from configVersion detection (§5)
  legacyConfig?: LegacyConfig;          // absent in v2 mode
  userOverrides: SensorMapOverride[];   // from config.json sensorMap
  discovery: DiscoveryRegistry;         // from plugin discovery store (§8.3)
  stations: DiscoveredStation[];        // from latest AWN poll
}): EffectiveSensorMap
```

Precedence order (later steps override earlier):

1. Built-in defaults from `defaultMap`
2. Compat-layer transformation (only when `configMode === 'legacy'`)
3. Global user overrides (rows in `userOverrides` where `stationId` is absent)
4. Station-specific user overrides (rows where `stationId` matches)
5. Runtime availability metadata (which stations are currently reporting the field; when it was last seen)

Output: an array of `EffectiveSensorRow` — one entry per `(stationId, dataPoint)` pair that either has a default, is user-overridden, or has been discovered.

The function is pure (no I/O, no side effects, no clocks). Every input is passed in explicitly. This makes the merge logic deterministic and testable — property-driven tests (§13) exercise it exhaustively.

Callers use it in two places:
- Plugin startup (`platform.discoverDevices`) — to determine which accessories to register / restore / re-register
- Angular UI backend — to compute the effective map that the front-end displays for editing

## 8. Persistence — three domains

Following hjdhjd's UniFi Protect pattern, persisted state lives in three separate stores. Each has a clear purpose and its own consistency guarantees.

### 8.1 `config.json` — user intent (declarative)

Contains only what the user has explicitly decided. Managed by Homebridge (or hand-edited). The plugin reads it at startup; the plugin never writes it. The Angular UI writes it via HB UI X's config persistence APIs.

Fields relevant to sensor map:

- `configVersion: number`
- `sensorMap: SensorMapOverride[]`

Legacy fields (`temperatureSensors`, `excludeSensors`, etc.) are also read from `config.json` in legacy mode. They persist here until the user's first UI save, at which point they're removed atomically (see §5).

### 8.2 Homebridge accessory cache — HomeKit registration state

Managed by Homebridge itself. On restart, Homebridge calls `configureAccessory(accessory)` for every previously-registered accessory in `cachedAccessories.*`. The plugin restores runtime state from `accessory.context.device`:

```typescript
interface AccessoryContext {
  uniqueId: string;                // `${macAddress}-${sensorKey}` — stable across restarts
  displayName: string;             // last name written to HomeKit
  kind?: SensorKind;               // NEW in 2.0. See §11 bootstrap rule for legacy accessories.
  type?: string;                   // legacy 1.6.0 field; kept for bootstrap-time kind inference
  structuralSignature?: string;    // NEW in 2.0. See §9.
  value?: number;                  // last-known reading
  batteryLow?: boolean;            // last-known battery state
}
```

The cache is what makes the plugin robust to AWN being offline at startup. Cached accessories continue to display their last-known values until AWN comes back.

### 8.3 Plugin discovery store — observational data

New in 2.0. Persists at `api.user.persistPath()/ambient-weather-discovery.json`. Managed entirely by the plugin.

```typescript
interface DiscoveryRegistry {
  version: number;
  entries: DiscoveredFieldRecord[];
  notices: SensorMapNotice[];
}

interface DiscoveredFieldRecord {
  stationId: string;               // MAC address of the station
  stationName: string;             // last-known info.name
  dataPoint: string;               // AWN field name
  firstSeen: string;               // ISO-8601 timestamp
  lastSeen: string;                // ISO-8601 timestamp
  lastValue?: unknown;             // last observed value (for UI preview)
}

interface SensorMapNotice {
  id: string;
  type: 'kind-change' | 'structural-change' | 'stale-cleanup';
  stationId: string;
  dataPoint: string;
  oldKind?: SensorKind;
  newKind?: SensorKind;
  occurredAt: string;
  dismissedAt?: string;
}
```

Used for:

- **Unrecognized-row survival across polls**: if AWN stops reporting a field briefly, the discovery entry stays. No accessory is (or was) registered — but the record persists so the UI can surface it.
- **Stale detection**: `lastSeen` older than N days → row eligible for cleanup via UI action (§9.4).
- **Structural-change notifications**: writes here when `kind` or another structural field changes and a re-registration happens; UI reads to render a persistent banner until the user dismisses.

**Discovery store does NOT contain user intent.** No overrides, no enabled/disabled, no names. Pure observational + notification state.

## 9. Structural signature and re-registration

HAP does not allow an accessory's service graph to change on the same UUID once registered. Several row-field changes affect the service graph:

- `kind` (obvious — changes the primary service)
- `batteryField` presence/absence (adds/removes Battery sub-service)
- Canonical-vs-non-canonical status for a battery field (affects whether Battery attaches on this row)
- Wrapper implementation changes across plugin versions

The design does NOT special-case each field. Instead, every row has a **structural signature** — a stable hash of the fields that determine the HAP service graph:

```typescript
function structuralSignature(row: EffectiveSensorRow): string {
  return hash({
    kind: row.kind,
    hasBatteryService: attachesBatterySubService(row),
    wrapperVersion: CURRENT_WRAPPER_SCHEMA_VERSION,
  });
}
```

Signature is stored in `accessory.context.device.structuralSignature`.

### 9.1 Detection

On startup, for each cached accessory:

1. Compute `oldSignature = accessory.context.device.structuralSignature` (or bootstrap-infer if absent — see §11)
2. Compute `newSignature = structuralSignature(effectiveRowFor(sensorKey))`
3. If they match: update in-place. `updatePlatformAccessories` refreshes displayName, service Name, ConfiguredName, etc. — but no HAP service is added/removed.
4. If they differ:
   - Log a warn: `Structural change detected for <dataPoint>: <what changed>. Re-registering accessory. HomeKit room, automations, and custom name will be lost.`
   - Write a `SensorMapNotice` to the discovery store
   - `unregisterPlatformAccessories(...)` the old accessory
   - `registerPlatformAccessories(...)` a new accessory with new UUID (or same UUID + new services, per HAP's re-registration semantics)

### 9.2 UI confirmation

The Angular UI intercepts structural changes at edit time. Changing `kind` or `batteryField` from a value that currently produces a Battery service to one that doesn't, etc. — any change that would trip the signature — pops a modal:

> Editing this sensor will remove its current HomeKit accessory and create a new one. The HomeKit room, custom name, and any automations targeting it will be lost. Proceed?

Non-structural changes (`name`, `threshold`, `displayUnit`, `embedName`) save without confirmation — they're in-place updates.

### 9.3 Change notice persistence

Every structural re-registration writes a `SensorMapNotice` to the discovery store. The UI reads these on load and renders a dismissible banner listing recent events. Dismissal writes `dismissedAt` and hides the row from the banner.

### 9.4 Stale-row cleanup — three distinct actions

The UI's "Manage sensors" panel offers three separate actions per row, each with different consequences:

| Action | Applies to | Effect |
|---|---|---|
| **Remove accessory** | Any row with a registered HomeKit accessory | Deregisters the accessory. Loses HomeKit state. Keeps the user override in `sensorMap`. If AWN starts reporting again, the accessory re-registers per user override. |
| **Remove user override** | Any row with an entry in `sensorMap` | Deletes the entry from `config.json`. Row reverts to plugin defaults (or unrecognized if custom). Does NOT deregister the accessory. |
| **Forget discovered field** | Rows for AWN fields not in the default map, currently only in the discovery store | Deletes the discovery record. If AWN reports the field again on next poll, it re-appears. Only affects the discovery-store side. |

The UI shows different affordances based on which of these apply to each row.

## 10. Custom Angular UI

Ships in `homebridge-ui/`. Homebridge UI X loads this in place of the schema-driven form when the plugin's config panel is opened.

### 10.1 Directory layout

```
homebridge-ambient-weather-sensors/
├── homebridge-ui/
│   ├── public/                      # Angular front-end
│   │   ├── index.html
│   │   ├── app/
│   │   │   ├── sensor-map/          # Sensor-map table + row edit
│   │   │   ├── station-filter/      # Include Only These Stations
│   │   │   ├── general/             # API keys, dataSource
│   │   │   └── shared/
│   │   ├── assets/
│   │   └── styles.css
│   └── server.ts                    # Node bridge for HB UI ↔ plugin
├── src/
│   └── awnClient.ts                 # NEW: shared AWN API client (§10.3)
├── config.schema.json               # Minimal schema-driven fallback
└── package.json
```

### 10.2 Process boundary

Two Node.js processes are involved. Diagram of responsibilities:

```
┌─────────────────────────┐      ┌──────────────────────────┐      ┌─────────────────────┐
│  Angular front-end      │      │  homebridge-ui/server.ts │      │  Plugin process     │
│  (browser)              │◄────►│  (short-lived, spawned    │      │  (long-lived,       │
│                         │      │   by HB UI X per session) │      │   the actual plugin)│
│                         │      │                          │      │                     │
│  reads/writes:          │      │  serves the front-end    │      │  writes to:         │
│    effective map view   │      │  reads plugin cache      │      │    HB accessory     │
│    validated overrides  │      │  reads discovery store   │      │    cache            │
│                         │      │  writes config.json      │      │    discovery store  │
│                         │      │  triggers AWN refresh    │      │    notification     │
│                         │      │                          │      │    store            │
└─────────────────────────┘      └──────────────────────────┘      └─────────────────────┘
```

The UI server and the plugin process are separate. The UI server CANNOT inspect the plugin's in-memory state directly. All shared state passes through the discovery store, the accessory cache, and `config.json`.

### 10.3 Shared AWN client (`src/awnClient.ts`)

To avoid duplicating AWN API logic between the plugin and the UI server, both import from `src/awnClient.ts`:

- REST call to `https://rt.ambientweather.net/v1/devices?applicationKey=...&apiKey=...`
- 429 retry-with-backoff logic
- Same JSON parsing + type validation

The plugin calls this on its normal poll cycle (or via socket.io for realtime). The UI server calls this only when the user clicks **Refresh from Ambient Weather** — no automatic UI-side polling.

Credentials never round-trip through the browser. The UI server reads them from `config.json`, passes them to `awnClient`, returns the sanitized response.

### 10.4 Front-end responsibilities

- Render the sensor-map table with grouped-row layout (unmodified defaults collapsed, edited / disabled / additional / needs-attention groups visible)
- Row expansion for editing; kind + unit dropdowns; embed toggle
- Confirmation modal on structural changes
- "Remove accessory" / "Remove user override" / "Forget discovered field" actions (§9.4)
- Persistent banner reading from discovery store's `notices` array
- **Advanced tab** — raw JSON view for `sensorMap` overrides; place for `triggerDirection` and other seldom-used fields

### 10.5 Schema-driven fallback

`config.schema.json` continues to ship. If a user disables custom UI in HB UI X preferences, they see a minimal form that lets them edit the raw `sensorMap` array of objects. Not the polished UX, but always available.

## 11. Migration semantics

Existing v1.6.0 users must upgrade to v2.0 with zero HomeKit state loss. Two guarantees:

### 11.1 The default map preserves service types

The plugin's default sensor map for v2.0 is constructed so that **every AWN sensorKey v1.6.0 exposes produces the same HAP service type in v2.0**. The audit table:

| sensorKey | v1.6.0 service | Legacy `type` string | Inferred kind | v2.0 default kind | v2.0 service | Match |
|---|---|---|---|---|---|---|
| `tempf` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `tempinf` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `feelsLike` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `dewPoint` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `humidity` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `humidityin` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `solarradiation` | LightSensor | `Solar Radiation` | light | light | LightSensor | ✓ |
| `co2` | CarbonDioxideSensor | `CO2` | co2 | co2 | CarbonDioxideSensor | ✓ |
| `co2_in_aqin` | CarbonDioxideSensor | `CO2` | co2 | co2 | CarbonDioxideSensor | ✓ |
| `pm25` | AirQualitySensor | `PM2.5` | air-quality-pm25 | air-quality-pm25 | AirQualitySensor | ✓ |
| `pm25_in_aqin` | AirQualitySensor | `PM2.5` | air-quality-pm25 | air-quality-pm25 | AirQualitySensor | ✓ |
| `pm10_in_aqin` | AirQualitySensor | `PM10` | air-quality-pm10 | air-quality-pm10 | AirQualitySensor | ✓ |
| `pm_in_temp_aqin` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `pm_in_humidity_aqin` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `uv` | MotionSensor + custom chars | `UV` | motion | motion | MotionSensor + custom chars | ✓ |
| `windspeedmph` | MotionSensor + custom chars | `WindSpeed` | motion | motion | MotionSensor + custom chars | ✓ |
| `windgustmph` | MotionSensor + custom chars | `WindGust` | motion | motion | MotionSensor + custom chars | ✓ |
| `maxdailygust` | MotionSensor + custom chars | `WindMaxDailyGust` | motion | motion | MotionSensor + custom chars | ✓ |
| `winddir` | MotionSensor + custom chars | `WindDirection` | motion | motion | MotionSensor + custom chars | ✓ |
| `winddir_avg10m` | MotionSensor + custom chars | `WindDirection10m` | motion | motion | MotionSensor + custom chars | ✓ |
| `hourlyrainin` | MotionSensor + custom chars | `RainRate` | motion | motion | MotionSensor + custom chars | ✓ |
| `eventrainin` .. `yearlyrainin` | MotionSensor + custom chars | `RainEvent` .. `RainYearly` | motion | motion | MotionSensor + custom chars | ✓ |
| `lastRain` | MotionSensor + custom chars | `LastRain` | motion | motion | MotionSensor + custom chars | ✓ |
| `baromrelin` | MotionSensor + custom chars | `PressureRelative` | motion | motion | MotionSensor + custom chars | ✓ |
| `baromabsin` | MotionSensor + custom chars | `PressureAbsolute` | motion | motion | MotionSensor + custom chars | ✓ |
| `lightning_day` .. `lightning_time` | MotionSensor + custom chars | `LightningDay` .. `LightningLastStrike` | motion | motion | MotionSensor + custom chars | ✓ |
| `temp{N}f` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `humidity{N}` | HumiditySensor | `Humidity` | humidity | humidity | HumiditySensor | ✓ |
| `feelsLike{N}` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |
| `dewPoint{N}` | TemperatureSensor | `Temperature` | temperature | temperature | TemperatureSensor | ✓ |

All ✓ by construction.

### 11.2 Bootstrap rule for existing cached accessories

Existing v1.6.0 cached accessories in `cachedAccessories.*` do NOT have a `kind` field in their context. On first v2.0 startup, applying the naive `oldSignature !== newSignature` check would trip a false-positive structural change and cause mass re-registration.

The plugin infers `kind` for every cached accessory using this fallback chain, in order:

```typescript
function inferKindForCachedAccessory(accessory: PlatformAccessory): SensorKind {
  // 1. Explicit — v2 write and later
  const explicitKind = accessory.context.device?.kind;
  if (explicitKind) {
    return explicitKind;
  }

  // 2. Legacy `type` field — v1.5.0 through v1.6.x
  const legacyType = accessory.context.device?.type;
  if (legacyType && LEGACY_TYPE_TO_KIND[legacyType]) {
    return LEGACY_TYPE_TO_KIND[legacyType];
  }

  // 3. HAP-service inspection — worst-case fallback for very old accessories
  const platformService = accessory.services.find(s => s.UUID !== ACCESSORY_INFORMATION_SERVICE_UUID);
  if (platformService) {
    return HAP_SERVICE_TO_KIND[platformService.UUID];
  }

  // 4. Give up — will trigger a re-registration, which is correct behavior for a truly-unknown accessory
  return 'unrecognized';
}
```

`LEGACY_TYPE_TO_KIND` is defined explicitly:

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

After bootstrap-inference, the plugin computes the effective row for the sensor's `sensorKey` and compares `structuralSignature`. Since the audit table (§11.1) is exhaustive and constructed to match, the signatures agree for every legacy row — no re-registration triggers.

The inferred kind is then persisted:

```typescript
accessory.context.device.kind = inferredKind;
accessory.context.device.structuralSignature = newSignature;
api.updatePlatformAccessories([accessory]);
```

Written in-place via `updatePlatformAccessories`. No HAP re-registration. Next restart, the explicit kind is already there.

Every entry in `LEGACY_TYPE_TO_KIND` has a dedicated test (see §13).

### 11.3 What DOES change on upgrade

- Users who open the plugin config in HB UI see the Angular UI instead of the schema-driven form
- Auto-discovered rows appear for AWN fields the plugin doesn't have defaults for — informational (they don't create accessories) until the user assigns a kind
- The `[embed-diag]` debug log lines continue to exist but are subsumed by richer per-sensor logging

### 11.4 User rename behavior

The plugin manages three name-adjacent characteristics on each accessory:

- `accessory.displayName` — Homebridge's own field, controls what HB UI shows
- Service `Name` — HAP standard characteristic, shows in Apple Home before the user renames
- Service `ConfiguredName` — HAP 2.x standard, shows in Apple Home after the user renames

The plugin already has logic for this from v1.5.0-beta.15/beta.16/beta.17. Under sensor-map:

- **`displayName` and service `Name`** are updated by the plugin on every restart from the effective row's `name` field. Guarantees the HB UI + Home-app first-render show the user's plugin-config name.
- **Service `ConfiguredName`** is set ONCE at accessory registration. If the user renames the tile in Apple Home, HAP updates `ConfiguredName` and the plugin's `isUserRenamed()` check detects the divergence between `ConfiguredName` and the last plugin-written name. Once detected, the plugin stops overwriting `ConfiguredName` — user rename wins.
- **Kind change / structural re-registration** deregisters the accessory. Apple Home considers the new accessory fresh — `ConfiguredName` is set from the plugin's `name` (not the previous user rename, which is lost with the old accessory).

The Angular UI displays user-renames as "user-set" on affected rows, indicating that Apple Home rename takes precedence for that tile.

## 12. Testing plan

### 12.1 Existing test coverage

The 385-test suite merged in v1.6.0 covers pure functions, wrapper classes, `parseDevices()`, and beta.5/beta.16/beta.23 regressions.

Under sensor-map, the following ports:

- **Pure-function tests (unit)**: unchanged. `sensorNames.ts`, `batteryFields.ts`, `unitConversions.ts`, `intensityBuckets.ts`, `nameComposer.ts`, platform helpers remain testable in the same shape.
- **Wrapper tests**: mostly unchanged. Accessory classes themselves aren't rewritten — only their instantiation path is. Some assertions about "when is this constructor called" will need to be updated to route through `buildEffectiveSensorMap`.
- **Existing `parseDevices` tests**: substantially rewritten. Behavior is now expressed in terms of the effective map, not raw category-toggle filtering. Same *semantics*, different mechanism.
- **Regression tests**: unchanged. beta.5, beta.16, beta.23 tests continue to pin their respective behaviors.

### 12.2 New tests — property-driven and invariant-based

Rather than 200-400 handwritten tests, favor **property-driven parameterized tests over invariants**. The audit table (§11.1) is machine-readable — parameterize over it:

```typescript
describe('default sensor map', () => {
  for (const row of DEFAULT_SENSOR_MAP) {
    test(`${row.dataPoint}: kind resolves to a wrapper`, () => {
      expect(WRAPPER_FOR_KIND[row.kind]).toBeDefined();
    });
    test(`${row.dataPoint}: displayUnit is legal for kind`, () => {
      expect(ALLOWED_UNITS_FOR_KIND[row.kind]).toContain(row.displayUnit);
    });
    // etc.
  }
});
```

Invariants covered by property-driven tests:

1. **Wrapper coverage**: every `SensorKind` resolves to exactly one wrapper class.
2. **Unit legality**: every default row's units are in the allowed set for its kind.
3. **Canonical battery**: for every batteryField, exactly one row in the default map is canonical.
4. **Legacy compat**: every entry in `LEGACY_TYPE_TO_KIND` maps to a real kind.
5. **Compat determinism**: for every legacy config field, translation is idempotent (`compat(compat(cfg)) === compat(cfg)`).
6. **Effective-map determinism**: `buildEffectiveSensorMap(x)` is a pure function; given the same inputs it produces the same output.
7. **Sparse-serialize round-trip**: serializing the effective map's user-overrides to sparse `sensorMap[]`, deserializing, and re-computing produces the same effective map.
8. **Structural signature stability**: for every default row + a fixed wrapper schema version, the signature is deterministic across runs.
9. **v1 fixture equivalence**: for every legacy 1.6.0 config fixture, the accessories produced under v2.0 have the same structural signatures as under v1.6.0 (proves zero-migration).
10. **Bootstrap coverage**: for every entry in `LEGACY_TYPE_TO_KIND`, the bootstrap-inferred kind matches the default map's kind for the corresponding sensorKey.

Total new test count is likely lower than 200-400 in absolute terms but higher in coverage per line. Property tests execute over 30+ default rows, so a single invariant test is 30 assertions.

### 12.3 Test suite stays green throughout

Every implementation PR either:
- (a) leaves the suite green, or
- (b) is paired with a same-day companion PR that restores green

No week-long broken states. This preserves the ability to distinguish "expected transition breakage" from "real regression."

**`npm test` added to CI immediately at start of the beta cycle.** Added to `prepublishOnly` before publishing 2.0.0-beta.0. Not deferred until GA — the reviewer's push here was justified and I revised from my earlier position.

## 13. Rollout plan

### 13.1 Beta cycle

1. **2.0.0-beta.0**: data model + `sensorMap` config field parsing + compat layer + config-mode detection + kind/structural bootstrap rule + `LEGACY_TYPE_TO_KIND` map + discovery store scaffolding. **Includes minimal usable Angular UI**: read-only effective-map table, enable/disable, name, kind selector, raw-JSON advanced view. Enough for a tester to validate migration + do basic edits without hand-writing JSON.
2. **2.0.0-beta.1 .. N**: full Angular UI features — grouped row layout, expansion + edit, unit selection, embed toggle, structural-change confirmation modal, stale-cleanup actions, persistent notice banner.
3. **2.0.0-beta.N**: end-to-end tester coverage. Maintainer + solmssen exercise every path.
4. **Final beta**: docs polished. README, UPGRADING.md, config.schema.json all describe the new shape.

Published under `@beta` npm dist-tag only. Existing users on `@latest` stay on v1.6.0.

### 13.2 GA criteria

Before promoting to `@latest`:

- Test suite green (every invariant in §12.2 passing, all 385 legacy tests either preserved or replaced)
- Zero-migration audit re-verified against the shipped default map (§11.1)
- Both testers running the latest beta successfully for at least a week without regressions
- Angular UI validated in the HB UI X versions the plugin supports
- CHANGELOG, README, UPGRADING.md describe final shape
- `npm test` in `prepublishOnly` (added at start of beta cycle, verified working at GA)

### 13.3 Post-GA

- Deferred: multi-Home tabbed UI (`docs/future/tabbed-config-ui.md`). Angular infrastructure is now available; this becomes a smaller v2.1 feature if user demand emerges.
- Deferred: removing legacy 1.6.0 config fields. No plan; compat layer stays permanently.

## 14. Open questions

Answered up front (via conversation + review):

- **Custom UI or schema-driven?** — Custom Angular UI.
- **Where do auto-discovered rows persist?** — Plugin discovery store (`api.user.persistPath()`), separate from `config.json` and HB accessory cache.
- **Kind change UX?** — Structural-signature-based re-registration with UI confirmation.
- **Bootstrap for existing accessories?** — Explicit `LEGACY_TYPE_TO_KIND` map + service inspection fallback, written to context via `updatePlatformAccessories` (no re-registration).
- **Config-mode detection?** — Explicit `configVersion` field.
- **Row identity across stations?** — Rows are `(dataPoint, stationId?)`. Absent `stationId` = global template applying to every station.
- **Test suite refactor?** — Green throughout the beta cycle. `npm test` in CI immediately, in `prepublishOnly` before first public beta.
- **Beta.0 UI?** — Minimal usable UI (read-only + enable/disable/name/kind + raw-JSON advanced) in beta.0; full features layered in beta.1+.

Still open (minor):

- **Node/Homebridge version bumps?** No plan. v2.0 stays on the same `engines` range as v1.6.0.
- **What happens to `docs/future/tabbed-config-ui.md`?** Superseded on the UI-technology decision by this document. Its multi-Home tabs use case is deferred to a future v2.1+.
- **Do we run `npm test` on Windows CI too?** No current plan — plugin is macOS-only in practice. Node compatibility matrix in `.github/workflows/build.yml` stays at Linux+macOS if we ever add matrix builds.

## 15. What's NOT settled — questions this doc still leaves open for implementation-time judgment

- Whether the Angular front-end uses Angular 17 signals, older RxJS, or a slimmer state library. Decide during implementation of the sensor-map component; no user-visible consequence.
- Whether the discovery store's `notices` array is size-capped (e.g., last 50 events) or unbounded until manually cleared. Lean toward capped.
- Exact schema-driven fallback shape. Live-editable but minimal.

## 16. Decision log

- **2026-07-08**: v1 of this doc drafted after conversation-level design discussion. Marked "approved for implementation." Sent for external review.
- **2026-07-09**: External review returned. Substantive critiques accepted; the following changes made in this revision:
  - Added §5 config-mode detection with explicit `configVersion` marker
  - Rewrote §3 data model to add `triggerDirection`, `triggerEnabled` (replacing `Infinity` sentinel), `sourceUnit` / `displayUnit`, `stationId?` for layered station overrides
  - Added §3.4 unit compatibility model
  - Added §7 explicit pure-function `buildEffectiveSensorMap` with precedence order
  - Rewrote §8 into three persistence domains (config.json, HB accessory cache, plugin discovery store)
  - Rewrote §9 around structural signatures rather than kind-only comparison
  - Added §9.4 distinct stale-cleanup actions (remove accessory / remove override / forget discovery)
  - Added §11.2 bootstrap rule with `LEGACY_TYPE_TO_KIND` for existing accessories on first v2 startup
  - Added §11.4 user-rename behavior clarification (references existing v1.5.0-beta.15/16/17 work)
  - Rewrote §12 testing plan around property-driven invariants (rather than 200-400 handwritten tests)
  - Revised §12.3: suite stays green throughout the beta cycle; `npm test` in CI immediately and `prepublishOnly` before first public beta
  - Revised §13.1: 2.0.0-beta.0 includes a minimal usable UI, not JSON-editing only
  - Corrected §3 "disabled row keeps Battery" — false. Disabling suppresses the entire accessory including sub-services.
  - Removed "approved for implementation" status pending your re-review
- Status pending re-review of these changes before implementation begins.

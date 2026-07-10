# Sensor Map — Design for v2.0

**Status:** Approved for implementation.
**Last reviewed:** 2026-07-08.
**Implementation phase:** Beta cycle target 2.0.0-beta.0; GA target 2.0.0 after test-suite refactor completes.

## 1. Motivation

The plugin has grown three distinct config-shaped concerns over v1.5.0 and v1.6.0:

1. **Which sensors to expose** — currently per-category toggles (`temperatureSensors`, `humiditySensors`, etc.) + `excludeSensors` blacklist + `includeOnly` allowlist + `stationFilter`
2. **How sensors are named** — no config field today; users rename in Apple Home, which loses the rename if the accessory ever re-registers
3. **Which HomeKit sensor type each AWN field maps to** — hardcoded in `determineSensorType()` in `platform.ts`; users cannot influence this

All three collapse into a single question: **what HomeKit accessory should each AWN datapoint produce?**

The proposal is a unified data model — a **sensor map** — where each row expresses that question for one AWN datapoint. Every row is fully editable by the user. The plugin ships defaults matching current v1.6.0 behavior; auto-discovery adds rows for datapoints AWN reports that the plugin doesn't already know about; users edit any row through a custom Angular-based configuration UI.

The design competes with three reference plugins whose approaches are documented and understood:

- **valiquette/homebridge-Ambient-realtime** — user-defined custom sensors via a `sensors: []` array; no auto-discovery; no default map
- **rhockenbury/homebridge-ecowitt-weather-sensors** — separate `nameOverrides` + `customHidden` config fields; no user-defined sensor kinds
- **hjdhjd/homebridge-unifi-protect** — auto-discovered devices in Homebridge's accessory cache; user overrides as terse strings; custom Angular UI

The proposal unifies all three concerns into one shape and adopts hjdhjd's persistence pattern.

## 2. Non-goals

- **Not a rewrite of the accessory-wrapper layer**. TemperatureAccessory, HumidityAccessory, etc. continue to exist. The sensor map's `kind` field selects which wrapper class to instantiate for each row.
- **Not adding new HomeKit sensor types**. The kind vocabulary is exactly the HAP-native sensor services that already work — no new characteristics.
- **Not changing the AWN API integration**. The polling + realtime paths stay the same.
- **Not changing `stationFilter` or child-bridge multi-Home behavior**. Orthogonal to sensor mapping; stays as-is.

## 3. Data model

### 3.1 Row shape

Each sensor map row expresses the mapping from one AWN datapoint to one HomeKit accessory:

```typescript
interface SensorMapRow {
  // AWN field name — row identity. Cannot be changed by the user.
  dataPoint: string;

  // HomeKit sensor kind. Determines which HAP service is used.
  // Required for the accessory to be exposed to HomeKit.
  kind?: SensorKind;

  // User-facing name shown in HomeKit. Falls back to the default name
  // from the plugin's built-in map if omitted.
  name?: string;

  // Motion-threshold value for kinds that use MotionSensor. Interpreted
  // in the row's `unit` (or AWN's native unit if `unit` is omitted).
  threshold?: number;

  // Display unit. Falls back to the plugin's default for this kind.
  unit?: string;

  // AWN batt* field name whose value drives the Battery sub-service.
  // Set to null to explicitly suppress the sub-service even if the
  // plugin default would attach one.
  batteryField?: string | null;

  // Show the live value in the tile name (embed mode). Default false.
  // Only affects Motion-kind rows — HAP-native value tiles already
  // show the reading directly and ignore this flag.
  embedName?: boolean;

  // Explicit enable/disable. Absent = enabled by default. Present with
  // false = hidden from HomeKit. The plugin's `Battery` sub-service
  // still attaches per the batteryField rule; only the parent accessory
  // is hidden.
  enabled?: boolean;
}
```

### 3.2 Kind enum

Twelve values corresponding to HAP-native sensor services the plugin can render:

**Value tiles** — Apple Home renders the live reading directly on the tile:
- `temperature` → `TemperatureSensor` (unit: °F / °C)
- `humidity` → `HumiditySensor` (unit: %)
- `light` → `LightSensor` (unit: lux; converted from W/m² for solar radiation)
- `co2` → `CarbonDioxideSensor` (unit: ppm)
- `co` → `CarbonMonoxideSensor` (unit: ppm)
- `air-quality-pm25` → `AirQualitySensor` with PM2_5Density
- `air-quality-pm10` → `AirQualitySensor` with PM10Density

**State tiles** — Apple Home renders a boolean detected/not-detected state; live values visible in Eve / Controller for HomeKit if the wrapper adds custom characteristics:
- `motion` → `MotionSensor` with configurable threshold; used by all extended sensors that lack a HAP-native value tile
- `leak` → `LeakSensor` (boolean)
- `contact` → `ContactSensor` (boolean)
- `occupancy` → `OccupancySensor` (boolean)

**Special:**
- `unrecognized` → auto-discovery sentinel. Assigned to rows for AWN fields not in the plugin's default map. Accessory is NOT created until the user picks a real kind.

Not included:
- `smoke` — no AWN equivalent
- Complex HAP services (SecuritySystem, Doorbell, etc.) — not sensor-shaped

### 3.3 Trigger direction for motion-kind rows

For most Motion-kind sensors, MotionDetected fires when the reading equals or exceeds the threshold (wind speed high, UV high, etc.). For pressure and lightning distance, low readings are the alarming case (storm incoming, close strike) — the plugin currently handles this via a `triggerDirection: 'below'` option in `ExtendedSensorOptions`.

**Design decision:** `triggerDirection` stays baked into the plugin's default sensor map per-datapoint, NOT exposed as a user-editable field. Every wind/rain/UV/gust row has `triggerDirection: above`; every pressure/lightning-distance row has `triggerDirection: below`. Users don't need to think about this. If someone remaps a sensorKey via config (e.g., they add a `custom_pressure_field` mapped to `kind: motion` and want below-triggering), they can override via a separate `triggerBelow: true` field. Advanced use; not shown in the primary UI.

## 4. Config schema — user-facing shape

`config.json` stays minimal. The `sensorMap` field is a sparse array — **only user-modified rows appear**. Everything else uses the plugin's defaults.

Full example config with a user who has renamed one sensor, disabled another, added a custom sensor, and suppressed a battery:

```jsonc
{
  "platform": "AmbientWeatherSensors",
  "name": "Ambient Weather",
  "apiKey": "…",
  "applicationKey": "…",
  "dataSource": "realtime",
  "stationFilter": ["Fairhills WS-2000"],

  "sensorMap": [
    // Rename an existing sensor
    { "dataPoint": "tempinf", "name": "Backyard Indoor Temp" },

    // Disable an existing sensor
    { "dataPoint": "lightning_distance", "enabled": false },

    // Change a threshold on an existing sensor
    { "dataPoint": "windspeedmph", "threshold": 30 },

    // Suppress the WH31L lightning battery
    { "dataPoint": "lightning_day", "batteryField": null },

    // Define a custom sensor for an AWN field the plugin doesn't know about
    {
      "dataPoint": "soilmoisture1",
      "kind": "humidity",
      "name": "Garden Moisture",
      "batteryField": "batt_soil"
    }
  ]
}
```

**Key invariants:**

- A row's presence in `sensorMap` means the user has modified something. A row's absence means the plugin's default applies.
- Legacy 1.6.0 config fields (`temperatureSensors`, `excludeSensors`, `includeOnly`, `thresholds.*`, `units.*`, `extendedDisplayMode`, `embedNameUpdateMinIntervalMinutes`) continue to work — see [compat layer](#6-compat-layer).
- New installs use `sensorMap` exclusively.

## 5. Default sensor map

The plugin ships an internal default map covering every AWN field currently exposed in v1.6.0. Each entry produces exactly the same HAP accessory shape v1.6.0 would produce for that field — preserving zero-migration.

The full canonical table lives in `src/defaultSensorMap.ts` (new file created in step 3 of the implementation). Below is the representative subset showing all patterns:

| dataPoint | kind | name | threshold | unit | batteryField | notes |
|---|---|---|---|---|---|---|
| `tempf` | temperature | Outdoor Temperature | — | °F | battout | canonical for battout |
| `tempinf` | temperature | Indoor Temperature | — | °F | battin | canonical for battin |
| `feelsLike` | temperature | Outdoor Feels Like | — | °F | battout | non-canonical (no Battery sub-service) |
| `dewPoint` | temperature | Outdoor Dew Point | — | °F | battout | non-canonical |
| `humidity` | humidity | Outdoor Humidity | — | % | battout | non-canonical |
| `humidityin` | humidity | Indoor Humidity | — | % | battin | non-canonical |
| `solarradiation` | light | Solar Radiation | — | lux | battout | W/m² → lux at 127× |
| `uv` | motion | UV Index | 3 | index | battout | triggerDirection: above |
| `windspeedmph` | motion | Wind Speed | 25 | mph | battout | triggerDirection: above |
| `windgustmph` | motion | Wind Gust | 35 | mph | battout | triggerDirection: above |
| `maxdailygust` | motion | Max Daily Gust | 35 | mph | battout | triggerDirection: above |
| `winddir` | motion | Wind Direction | Infinity | ° | battout | never triggers; informational |
| `winddir_avg10m` | motion | Wind Direction 10m Avg | Infinity | ° | battout | never triggers |
| `hourlyrainin` | motion | Rain Rate | 0.01 | in/hr | battout | any measurable rain |
| `eventrainin` | motion | Rain Event | 0.01 | in | battout | accumulation |
| `dailyrainin` | motion | Rain Daily | 0.01 | in | battout | accumulation |
| `weeklyrainin` | motion | Rain Weekly | 0.01 | in | battout | accumulation |
| `monthlyrainin` | motion | Rain Monthly | 0.01 | in | battout | accumulation |
| `yearlyrainin` | motion | Rain Yearly | 0.01 | in | battout | accumulation |
| `lastRain` | motion | Last Rain | Infinity | timestamp | battout | never triggers |
| `baromrelin` | motion | Pressure Sea Level | 29.5 | inHg | battin | triggerDirection: below |
| `baromabsin` | motion | Pressure Station | 29.5 | inHg | battin | triggerDirection: below |
| `lightning_day` | motion | Lightning Strikes Today | 1 | count | batt_lightning | canonical for batt_lightning |
| `lightning_hour` | motion | Lightning Strikes This Hour | 1 | count | batt_lightning | non-canonical |
| `lightning_distance` | motion | Lightning Distance | 10 | mi | batt_lightning | triggerDirection: below |
| `lightning_time` | motion | Last Lightning Strike | Infinity | timestamp | batt_lightning | never triggers |
| `co2` | co2 | CO2 | 1000 | ppm | batt_co2 | threshold flips CarbonDioxideDetected |
| `co2_in_aqin` | co2 | Indoor CO2 | 1000 | ppm | batt_co2 | canonical for batt_co2 |
| `pm25` | air-quality-pm25 | Outdoor PM2.5 | — | µg/m³ | (none) | outdoor PM has no batt* field |
| `pm25_in_aqin` | air-quality-pm25 | Indoor PM2.5 | — | µg/m³ | batt_co2 | non-canonical for batt_co2 |
| `pm10_in_aqin` | air-quality-pm10 | Indoor PM10 | — | µg/m³ | batt_co2 | non-canonical |
| `pm_in_temp_aqin` | temperature | AQIN Temperature | — | °F | batt_co2 | non-canonical |
| `pm_in_humidity_aqin` | humidity | AQIN Humidity | — | % | batt_co2 | non-canonical |
| `temp{1..10}f` | temperature | Temperature N | — | °F | batt{N} | canonical for batt{N} |
| `humidity{1..10}` | humidity | Humidity N | — | % | batt{N} | non-canonical |
| `feelsLike{1..4}` | temperature | Feels Like N | — | °F | batt{N} | non-canonical |
| `dewPoint{1..4}` | temperature | Dew Point N | — | °F | batt{N} | non-canonical |

**Enabled by default:** every default row's `enabled` defaults to `true` at the map level, but the compat layer (§6) applies category gating for existing 1.6.0 users. New 2.0 users get category-based defaults preserved via the same rules.

**Canonical battery sensor per field:** the current v1.6.0 `batteryFields.CANONICAL_SENSOR_FOR_BATTERY` mapping stays as-is. Non-canonical rows have `batteryField: <field>` recorded (so they know their parent probe's battery for logging purposes) but do NOT attach a Battery sub-service — `batteryService.setupBatteryService` continues to check canonicality.

## 6. Compat layer

Legacy 1.6.0 config fields translate to internal sensor-map state at plugin startup. The translation is one-shot per boot, produces the same runtime behavior 1.6.0 users see today, and is invisible in `config.json` (nothing is written back).

Translation rules:

| 1.6.0 field | Value | Effect on runtime sensor map |
|---|---|---|
| `temperatureSensors` | `true` | All rows with `kind: temperature` → `enabled: true` |
| `temperatureSensors` | `false` or absent | All rows with `kind: temperature` → `enabled: false` (v1.6.0 default was false) |
| `humiditySensors` | `true` / `false` | Same, for `kind: humidity` |
| `solarRadiationSensors` | … | Same, for `kind: light` (solar-only, doesn't affect a hypothetical future user-added light kind) |
| `co2Sensors` | … | Same, for `kind: co2` |
| `airQualitySensors` | … | Same, for `kind: air-quality-pm25` AND `kind: air-quality-pm10` |
| `extendedSensors` | `false` | All Motion-kind rows for extended sensor sensorKeys → `enabled: false`, regardless of below toggles |
| `extendedSensors` | `true` | Move to the sub-category checks below |
| `windSensors` | `true` (with extendedSensors on) | wind* rows → `enabled: true` |
| `windSensors` | `false` | wind* rows → `enabled: false` |
| `rainSensors` | … | Same, for rain sensors |
| `pressureSensors` | … | Same, for pressure sensors |
| `uvSensors` | … | Same, for `uv` |
| `lightningSensors` | … | Same, for lightning sensors |
| `thresholds.<foo>Enabled: false` | | Corresponding row → `enabled: false` |
| `thresholds.<foo>Mph` / `.<foo>InHr` / `.uv` / `.lightningDistanceMi` / `.pressureInHg` | numeric | Corresponding row's `threshold` set to this value |
| `units.windSpeed` / `.rain` / `.pressure` / `.distance` | e.g. `kph` | Corresponding wind / rain / pressure / lightning-distance rows' `unit` set |
| `extendedDisplayMode: embed` | | All Motion-kind rows → `embedName: true` |
| `embedNameUpdateMinIntervalMinutes: N` | | Global setting stays; applied per-row at render time |
| `excludeSensors: ["Foo"]` | | Row(s) whose friendly name or sensorKey matches → `enabled: false`. The `-batt` suffix and raw battery-field-name matching from 1.6.0-beta.24 continues to work: matches set the row's `batteryField` to `null`. |
| `includeOnly: [...]` | | Rows NOT matching any allowlist entry → `enabled: false`. Applied AFTER `excludeSensors`. |
| `stationFilter: [...]` | | Not sensor-map related; stays as a top-level field |
| `dataSource` | `polling` / `realtime` | Not sensor-map related; stays as a top-level field |

The user's `sensorMap: []` entries are applied AFTER the compat translation, on a per-row per-field basis. Explicit user overrides always win.

Legacy fields remain readable indefinitely. There is no plan to remove them or emit deprecation warnings. Users who never open the plugin config in HB UI continue to use the legacy shape forever; users who open the config once and save get their config auto-migrated to the new shape by the UI.

## 7. Auto-discovery

On each successful AWN poll, the plugin builds the runtime sensor map by:

1. Starting from the built-in `DEFAULT_SENSOR_MAP` (§5)
2. Applying the compat layer (§6) to translate any legacy 1.6.0 config fields into row state
3. Applying user overrides from `config.sensorMap`
4. For each sensorKey present in AWN's response that isn't already a row: adding a new row with `kind: unrecognized`, `name: <sensorKey>`, no other fields set

Rows with `kind: unrecognized` do NOT produce HomeKit accessories. They exist in the runtime map so the config UI can surface them to the user with a "Kind required" badge.

Users assign a kind through the UI. Once assigned, the row moves to the user's `sensorMap` in `config.json` and produces a HomeKit accessory on the next restart.

**Rows for AWN fields that used to be present but no longer are:** kept in the accessory cache indefinitely so user customizations survive. The cache-level presence is Homebridge's responsibility (via `cachedAccessories.*`), not ours. If a user removes hardware and wants to clean up stale rows, they use the "Remove stale sensors" action in the UI (§9.4).

## 8. Persistence

Two persistence layers, following hjdhjd's UniFi Protect pattern:

### 8.1 Homebridge accessory cache

Managed by Homebridge itself. Each accessory the plugin registers via `registerPlatformAccessories()` gets serialized to `cachedAccessories.*` in the Homebridge config directory. On restart, Homebridge calls the plugin's `configureAccessory(accessory)` for each cached accessory, and the plugin restores runtime state from `accessory.context.device`.

For sensor-map, `accessory.context.device` records:

- `uniqueId`: `${macAddress}-${sensorKey}` — stable across restarts, unchanged from v1.6.0
- `displayName`: the current name (comes from sensorMap or default)
- `type`: legacy 1.6.0 type field, kept for compat during transition (removed in a future release)
- `kind`: NEW in 2.0 — the SensorKind assigned to this accessory. Used for kind-change detection.
- `value`: last-known reading
- `batteryLow`: last-known battery state (undefined if no battery sub-service)

The accessory cache is what makes the plugin robust to AWN being offline at startup — cached accessories show their last-known values until AWN comes back.

### 8.2 User customizations in config.json

Only the `sensorMap: []` array. Sparse — one entry per user-modified row. See §4.

### 8.3 What is NOT persisted

- The default sensor map (lives in code)
- Auto-discovered rows with `kind: unrecognized` — reconstructed on each poll from the AWN response
- Compat-layer translations (recomputed each restart from the legacy fields)

## 9. Kind change semantics

HAP does not allow an accessory's service type to change once registered. Changing a row's `kind` therefore requires **deregistering the old accessory and registering a new one**, which loses HomeKit-side state: room assignment, automations targeting that accessory, and any user rename in the Home app.

### 9.1 Detection

On restart, `discoverDevices()` compares each accessory's cached `context.device.kind` against the effective sensorMap's kind for that sensorKey. If they differ:

1. Log a warn line: `Kind changed for <sensorKey> from <oldKind> to <newKind>; re-registering the accessory. HomeKit room assignment, automations, and custom name will be lost.`
2. Call `api.unregisterPlatformAccessories(...)` with the old accessory
3. Remove it from the plugin's `this.accessories` array
4. Fall through to the standard "add new accessory" path with the new kind

### 9.2 UI-side confirmation

When the user changes a kind in the Angular UI, the form displays a confirmation dialog before saving:

> Changing the Kind of "Wind Speed" from Motion to Humidity will remove the current HomeKit accessory and create a new one. Any room assignment, custom name, or automations targeting this accessory will be lost. Proceed?

This makes the trade-off explicit at the point of decision rather than after the restart.

### 9.3 Persistent notification

After a kind-change re-registration completes, the plugin emits an info-level log line: `Kind change complete for <sensorKey>. Re-add the new "<name>" tile to your Apple Home room and re-target any automations.` The Angular UI displays a persistent banner listing recently re-registered accessories until the user dismisses it.

### 9.4 Stale-row cleanup

Separate concern from kind changes: if a user removes hardware (e.g., their WH31L lightning add-on) and wants to clean up the corresponding accessories, the UI provides a "Remove stale sensors" action that lists rows whose AWN field hasn't been reported in the last N polls (configurable, default 7 days). Selecting rows and confirming triggers explicit deregistration.

## 10. Custom Angular UI

The plugin ships a `homebridge-ui/` directory containing an Angular-based custom configuration UI. Homebridge UI X loads this in place of the schema-driven form when the plugin's config panel is opened.

### 10.1 Directory structure

```
homebridge-ambient-weather-sensors/
├── homebridge-ui/
│   ├── public/                    # Angular front-end
│   │   ├── index.html
│   │   ├── app/
│   │   │   ├── sensor-map/         # Sensor-map form components
│   │   │   ├── station-filter/     # Include Only These Stations form
│   │   │   ├── general/            # API keys, dataSource
│   │   │   └── ...
│   │   ├── assets/
│   │   └── styles.css
│   └── server.ts                   # Node bridge for HB UI ↔ plugin
├── src/
├── config.schema.json              # Still ships, minimal fallback
└── package.json
```

### 10.2 Server responsibilities

`homebridge-ui/server.ts` uses `@homebridge/plugin-ui-utils` to:

- Read the plugin's current config
- Write updated config (which the HB UI framework then persists to `config.json`)
- Expose an RPC method for the Angular front-end to request a live AWN poll — the server calls the AWN REST API with the user's apiKey/applicationKey and returns the current `lastData` payload
- Expose an RPC method returning the plugin's `DEFAULT_SENSOR_MAP` (so the UI can merge with the user's overrides and render the effective view)

### 10.3 Angular front-end responsibilities

- Render the sensor-map table with the grouped-row layout (unmodified defaults collapsed, edited / disabled / additional / needs-attention groups visible)
- Handle row expansion for editing, kind dropdown, unit dropdown, embed toggle
- Confirmation dialog for kind changes
- "Remove stale sensors" action
- On save: produce a sparse sensorMap array containing only user-modified rows, write back via the server bridge

### 10.4 Fallback

`config.schema.json` continues to ship in the npm tarball. If a user has custom-UI disabled in HB UI X preferences (an option that exists), they see a minimal schema-driven form that lets them edit the raw sensorMap as an array of objects. Not the polished UX, but always available.

## 11. Migration semantics

The plugin's default sensor map for v2.0 is constructed so that **every AWN sensorKey v1.6.0 currently exposes produces the same HAP service type in v2.0**. Users' HomeKit accessories on upgrade continue to work — same UUIDs, same service types, same characteristics, same room assignments, same automations.

### 11.1 The audit table

Before shipping 2.0.0-beta.0, the default sensor map (§5) is verified against v1.6.0's runtime behavior for every sensorKey. For each row in the audit table below, the expected HAP service after upgrade must be identical to what v1.6.0 currently produces:

| sensorKey | v1.6.0 service | v2.0 default kind | Resulting service | Match |
|---|---|---|---|---|
| `tempf` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `tempinf` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `feelsLike` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `dewPoint` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `humidity` | HumiditySensor | humidity | HumiditySensor | ✓ |
| `humidityin` | HumiditySensor | humidity | HumiditySensor | ✓ |
| `solarradiation` | LightSensor | light | LightSensor | ✓ |
| `co2` | CarbonDioxideSensor | co2 | CarbonDioxideSensor | ✓ |
| `co2_in_aqin` | CarbonDioxideSensor | co2 | CarbonDioxideSensor | ✓ |
| `pm25` | AirQualitySensor | air-quality-pm25 | AirQualitySensor | ✓ |
| `pm25_in_aqin` | AirQualitySensor | air-quality-pm25 | AirQualitySensor | ✓ |
| `pm10_in_aqin` | AirQualitySensor | air-quality-pm10 | AirQualitySensor | ✓ |
| `pm_in_temp_aqin` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `pm_in_humidity_aqin` | HumiditySensor | humidity | HumiditySensor | ✓ |
| `uv` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `windspeedmph` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `windgustmph` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `maxdailygust` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `winddir` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `winddir_avg10m` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `hourlyrainin` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `eventrainin` .. `yearlyrainin` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `lastRain` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `baromrelin` / `baromabsin` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `lightning_*` | MotionSensor + custom chars | motion | MotionSensor + custom chars | ✓ |
| `temp{N}f` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `humidity{N}` | HumiditySensor | humidity | HumiditySensor | ✓ |
| `feelsLike{N}` | TemperatureSensor | temperature | TemperatureSensor | ✓ |
| `dewPoint{N}` | TemperatureSensor | temperature | TemperatureSensor | ✓ |

All ✓ by construction. Any future change to a default row's kind is a deliberate migration event, documented in CHANGELOG.md and (if it affects existing users) accompanied by a kind-change UI notification (§9).

### 11.2 Guarantees for existing users on upgrade

- Zero HomeKit accessory changes on upgrade from any v1.6.x version to v2.0.0
- Zero user action required — existing `config.json` continues to work indefinitely via the compat layer
- Room assignments, automations, custom names in Home.app preserved
- Battery sub-services in the same places (canonical sensor per probe)

### 11.3 What DOES change on upgrade

- Users who open the plugin config in HB UI see the new Angular UI instead of the schema-driven form
- Auto-discovered rows appear for AWN fields the plugin doesn't have defaults for — these are informational only (they don't create accessories) unless the user assigns a kind
- The 1.6.0 `[embed-diag]` debug log lines continue to exist but are subsumed by richer per-sensor logging

## 12. Testing plan

### 12.1 Existing test coverage

The current 385-test suite (from the automated-test-suite PR, merged in v1.6.0-post-GA) covers:

- Unit tests for pure functions (sensorNames, batteryFields, unitConversions, intensityBuckets, nameComposer, platform.ts helpers)
- Wrapper tests for every accessory class
- Integration tests for `parseDevices()` with fixture payloads
- Regression tests for beta.5, beta.16, beta.23 bugs

Some tests become obsolete or need re-shaping:

- `parseDevices.test.ts` — will be substantially rewritten around the new sensor-map data model
- Existing filter-behavior tests (`excludeSensors`, `includeOnly`, per-category toggles) become **compat-layer tests** — same assertions, different mechanism
- Wrapper tests stay mostly intact — the accessory classes themselves don't change, only the code that constructs them

### 12.2 New tests required

- Default sensor map: every row in the audit table (§11.1) has an explicit test pinning its kind, threshold, unit, batteryField. Prevents accidental drift that would break migration.
- Compat layer: for every legacy field, a test pinning its translation to sensor-map state. Prevents regression as we refactor.
- Auto-discovery: unrecognized-sensor path, unrecognized→configured transition, stale-row detection.
- Kind change: force re-registration path exercised with mock cached accessory.
- User override precedence: user's sensorMap entry wins over compat-layer translation wins over default.

Estimate: 200-400 new tests. Total suite grows to ~600-800.

### 12.3 Test suite refactor timing

Per the plan: test refactor happens **before 2.0.0 GA, not before 2.0.0-beta.0**. Betas can ship with partially-broken tests during the transition; the release workflow does not currently gate on `npm test`. GA does not ship until:

1. All existing tests pass (adapted or replaced as needed)
2. New tests cover the sensor map, compat layer, auto-discovery, kind changes
3. `npm test` is added to `prepublishOnly` (previously deferred; now the natural time to enable it)

## 13. Rollout plan

### 13.1 Beta cycle (Step 3 of the four-step plan)

Following the 1.5.0-beta cycle pattern:

1. **2.0.0-beta.0**: default sensor map (§5) + `sensorMap` config field parsing + compat layer + kind-change detection + `enabled` semantics. Angular UI NOT included; users edit `sensorMap` via HB UI's JSON Config. Enough to prove the core data model against real user configs.
2. **2.0.0-beta.1..N**: Angular UI implementation, incrementally. Sensor-map table view, then row edit, then auto-discovery integration, then kind-change dialog, then stale-row cleanup.
3. **2.0.0-beta.N**: End-to-end user testing. maintainer + solmssen (per the memory notes) exercise every path.
4. **2.0.0-beta.N+1**: docs polished. README, UPGRADING.md, config.schema.json all describe the new shape.

Publish under `@beta` npm dist-tag only. Existing users on `@latest` stay on v1.6.0.

### 13.2 GA criteria

Before promoting to `@latest`:

- Test-suite refactor complete (§12.3)
- Zero-migration audit re-verified against the shipped default map (§11.1)
- Both testers running 2.0-beta.N successfully for at least a week without regressions
- Custom Angular UI validated in HB UI X versions the plugin supports
- CHANGELOG, README, UPGRADING.md all reflect final shape

### 13.3 Post-GA

- Deferred: multi-Home tabbed UI (`docs/future/tabbed-config-ui.md`). Now cheap since Angular infrastructure exists — likely a v2.1 feature if there's user demand.
- Deferred: removing legacy 1.6.0 config fields. No plan; the compat layer stays permanently.

## 14. Open questions

Answered up front (via prior conversation):

- **Custom UI or schema-driven?** — Custom (Angular). Rationale: auto-discovery in the form needs it; multi-Home tabs will need it later; hjdhjd's plugin proves the pattern works.
- **Where do auto-discovered rows persist?** — Homebridge's `cachedAccessories.*` file, per hjdhjd's pattern. User customizations in `config.json` as sparse sensorMap entries.
- **Kind change UX?** — Notify + force re-registration. Confirmation dialog in the UI + warn log at re-registration time.
- **Migration for existing users?** — Zero-migration by construction (§11.1). Default sensor map produces same HAP services as v1.6.0.
- **Test suite refactor?** — Required before GA, not before beta.

Still open:

- **Do we ship v2.0-beta.0 without the Angular UI, or wait until the UI exists?** Argument for early beta.0: the data model + compat layer can be tested against real 1.6.0 configs immediately, catching migration bugs before the UI adds complexity. Argument for waiting: users testing the beta without a UI have to hand-edit `config.json`, which is painful. Lean is: **ship beta.0 without UI** to prove data-model migration; UI arrives in beta.1+.
- **Node/Homebridge version bumps?** No plan to bump. v2.0 stays on the same `engines` range as v1.6.0.
- **What happens to `docs/future/tabbed-config-ui.md`?** Superseded by this document's Angular UI decision. Referenced from this doc as the eventual multi-Home tabs use case.

## 15. Decision log

- **2026-07-08**: Design approved for implementation. Straight to 2.0.0 (no 1.7 intermediate). Compat layer preserved indefinitely. Custom Angular UI adopted. Zero-migration by construction. Beta cycle begins in step 3 of the four-step plan.

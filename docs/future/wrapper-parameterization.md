# Wrapper parameterization — v2.0 GA blocker

Design for fixing review finding #4 (P0) before the v2.0.0 GA flag flip.

## Problem

Every accessory wrapper class shipped in v1.6.0 hardcodes the AWN key,
sensor label, default threshold, unit choice, display mode, and (for
extended sensors) the intensity-bucket function and reading formatter.
Instantiation reads those hardcoded values from `this` and from
`platform.config.*` globals:

```typescript
// src/extendedSensors/windAccessory.ts
export class WindSpeedAccessory extends WindSpeedLikeAccessory {
  constructor(platform, accessory) {
    const raw = platform.config.thresholds?.windSpeedMph;
    const threshold = typeof raw === 'number' ? raw : Infinity;
    super(platform, accessory, 'Wind Speed', 'windspeedmph', threshold);
  }
}

// src/temperatureAccessory.ts
export class TemperatureAccessory implements SensorAccessory {
  constructor(platform, accessory) {
    // Reads accessory.context.device.uniqueId for serial;
    // no per-row threshold / unit / label — the class name IS the identity.
  }
}
```

For v1.6.0 this is fine — the class-name-as-identity model is a 1:1 map
to AWN's fixed vocabulary. For v2 it fails: the sensor-map's
`WRAPPER_FOR_KIND_AND_MEASUREMENT` resolves a **custom** row (e.g. a
user-declared `{ kind: 'motion', measurement: 'wind-speed',
dataPoint: 'my_barn_wind', threshold: 40 }`) to `WIND_SPEED_WRAPPER`,
whose constructor then instantiates the wrapper against the string
`'windspeedmph'` and the config key `windSpeedMph`. The custom row's
own dataPoint, threshold, and (when we get to it) name never reach the
runtime object. The same pattern exists across wind, rain, pressure,
UV, lightning, PM2.5, and PM10 wrappers.

Acceptance criterion §17.1 in the sensor-map design ("canonical
wrappers are generic — a custom `(kind, measurement)` row instantiates
the same class with different runtime knobs") is therefore false on
the shipping code. Until this fix lands, `WRAPPER_FOR_KIND_AND_MEASUREMENT`
promises a capability the codebase can't honor.

## Non-goals

- No new wrappers. Kinds without a concrete class today (co, leak,
  contact, occupancy) stay out of the lookup table.
- No consolidation. The 25 shipping descriptors remain 1:1 with their
  class. This design touches how those classes take input, not how
  many there are.
- No UI. Custom sensors are v2-mode-only for now; the v1.6.0 config
  UI surface does not need to grow.
- No change to `structuralSignature` or cache-invalidation semantics.
  Only inputs shift; the HAP service graph a wrapper produces stays
  identical when the inputs match today's hardcoded values.

## Proposal

### The row IS the wrapper input

Every wrapper accepts an already-resolved `EffectiveSensorRow` in
addition to `(platform, accessory)`. The row supplies everything the
constructor previously pulled from class-local constants or from
`platform.config.*`:

- `dataPoint` (AWN key) — replaces the hardcoded string in every
  extended-sensor subclass;
- `name` — replaces the hardcoded sensor label; already flows into
  `accessory.context.device.displayName` for native wrappers, so the
  behavior change is mostly for extended sensors;
- `threshold` — replaces the `platform.config.thresholds.*` lookups;
- `triggerDirection` — replaces the hardcoded 'above' / 'below' in
  pressure and lightning-distance subclasses;
- `displayUnit` (numeric rows) — replaces the
  `platform.config.units.*` lookups;
- `embedName` — replaces the module-scope
  `platform.config.extendedDisplayMode === 'embed'` check;
- `batteryField` / `hasBatterySubService` — already resolved on the
  row; wrappers use them instead of calling `setupBatteryService`
  with its internal probe-lookup.

The `EffectiveSensorRow` union is already the source of truth for
these values in the v2 pipeline. The change is: constructors READ
from it instead of re-resolving them.

### Concrete shape

Two constructor styles today; both keep their existing shape and grow
one parameter:

```typescript
// Native wrappers (Temperature, Humidity, SolarRadiation, Co2, AirQuality)
class TemperatureAccessory implements SensorAccessory {
  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    row: NumericSensorRow,          // <-- new
  ) { ... }
}

// Extended wrappers (Wind, Rain, Pressure, UV, Lightning)
class WindSpeedAccessory extends WindSpeedLikeAccessory {
  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    row: NumericSensorRow | TimestampSensorRow,   // <-- new; type per wrapper
  ) {
    super(platform, accessory, {
      sensorLabel: row.name,
      awnKey: row.dataPoint,
      threshold: row.threshold ?? Infinity,
      triggerDirection: row.triggerDirection ?? 'above',
      displayMode: row.embedName ? 'embed' : 'static',
      displayUnit: row.measurement === 'boolean' ? undefined : row.displayUnit,
    });
  }
}
```

`ExtendedSensorOptions` (the `super()` input on the extended base)
grows one field:

```typescript
export interface ExtendedSensorOptions {
  sensorLabel: string;
  awnKey: string;
  threshold: number;
  triggerDirection?: 'above' | 'below';
  displayMode: ExtendedDisplayMode;
  displayUnit?: SensorUnit;   // <-- new; undefined for boolean rows
}
```

The unit-conversion + intensity-bucket functions currently sit at the
subclass level (e.g. `beaufort` on wind speed, `bucketRainRate` on
rain rate). These are wrapper-family constants, not per-row inputs —
they stay in the subclass. Only the *unit choice* (mph vs kph)
becomes row-driven, not the bucket scale.

### One factory, one call site

Wrappers are instantiated from exactly one place: platform's
accessory-registration loop. Today that loop resolves a
`SensorAccessory` constructor from a `type` string and calls
`new Ctor(platform, accessory)`. It becomes:

```typescript
// pseudocode of the target platform.ts call site
const row = effectiveRowFor(uniqueId);          // from buildEffectiveSensorMap
const Ctor = row.wrapper.constructor;
new Ctor(platform, accessory, row);
```

The shadow-mode flag stays: the v1.6.0 code path continues to
instantiate the same wrapper classes; passing the row through is
purely additive (v1's row IS the v2-projected row from compat, so the
values match what v1 pulled from `platform.config` before).

### Migration order (staged, one wrapper family at a time)

Each stage lands as its own PR. Failing tests in a stage block that
stage's merge; the flag flip (task #65) blocks until the last stage
merges.

- **Stage A — extended base + wind family.** Grow
  `ExtendedSensorOptions`; parameterize `WindSpeedLikeAccessory` +
  the five wind subclasses. Add synthetic `test_custom_wind`
  fixtures for each `(motion, wind-speed)` and `(motion, direction)`
  entry.
- **Stage B — rain family.** RainRate, RainEvent, RainDaily,
  RainWeekly, RainMonthly, RainYearly, LastRain. Rain-accumulation
  wrappers currently hardcode the accumulation-period label; this
  becomes row-driven.
- **Stage C — pressure + UV + lightning.** PressureRelative,
  PressureAbsolute, UvAccessory, LightningDay, LightningHour,
  LightningDistance, LightningLastStrike. Includes the
  `triggerDirection` handling that pressure and lightning-distance
  need.
- **Stage D — native wrappers.** Temperature, Humidity,
  SolarRadiation, Co2, AirQuality (PM2.5 + PM10). Smallest surface
  because these have no threshold / unit knobs today — the
  parameterization mostly plumbs `row.name` and `row.dataPoint`
  through instead of leaning on `accessory.context.device`.
- **Stage E — call sites.** Convert both v1 and v2 platform paths to
  pass the row. Remove the last hardcoded string / class-name
  fallbacks.

Stages A–D can land in any order after Stage 0 (below).

### Stage 0 — interim safety

Between now and the merge of the last stage, the sensor-map layer
promises functionality the runtime can't yet deliver — a custom row
resolving to `WIND_SPEED_WRAPPER` will silently produce a wrapper
tied to `windspeedmph` and `platform.config.thresholds.windSpeedMph`,
not the row's own values.

Per the reviewer's suggested fix, `WRAPPER_FOR_KIND_AND_MEASUREMENT`
becomes empty (all entries removed) until Stage E ships. `wrapperFor`
returns undefined for every custom `(kind, measurement)`, and
`buildEffectiveSensorMap` emits its existing "no wrapper for (kind,
measurement)" error. Users can't yet declare custom sensors; the
compat-generated overrides that hit known dataPoints still work
because those rows resolve via `defaultMap.wrapper` (direct reference
to the descriptor), not through the resolution table.

Stage 0 lands in the same PR as this design doc's merge. It is
reverted incrementally: each family's stage-A/B/C PR restores that
family's `WRAPPER_FOR_KIND_AND_MEASUREMENT` entries as its tests
pass.

## Testing

The reviewer's mandate is "a synthetic `test_custom` for every
canonical entry." Concretely, for each of the 15 entries in
`WRAPPER_FOR_KIND_AND_MEASUREMENT`:

1. Build an `EffectiveSensorRow` matching the resolution key (kind +
   measurement + a custom dataPoint like `test_custom_wind_speed`,
   plus a non-default threshold, non-default displayUnit where
   applicable, and a non-default name).
2. Instantiate the resolved wrapper with a mock `PlatformAccessory`.
3. Assert that the resulting HAP service graph:
   - Reads its raw value from the row's `dataPoint`, not the
     wrapper family's default AWN key.
   - Uses the row's threshold for MotionDetected transitions (extended
     wrappers).
   - Uses the row's `displayUnit` for the formatted value string
     (numeric extended wrappers).
   - Uses the row's `name` as the `Name` characteristic.
   - Attaches or omits the Battery sub-service based on the row's
     `hasBatterySubService`.

The existing per-wrapper unit tests cover the "wrapper works when
called with defaults" case. The new `test_custom_*` suite covers the
"wrapper works when called with non-default row values" case. Both
suites run per-stage; a stage merges only when both pass.

Migration equivalence (§13, Group 2) already spot-checks that a v1
config produces the same `(threshold, displayUnit, embedName,
batteryField)` as v2 for the default map. That test is a
*compat-produces-same-inputs* check. The new test_custom suite is a
*wrapper-consumes-inputs* check. Together they close the loop the
review flagged.

## Rollout

The design doc merges first (this PR). Stage 0 (empty
resolution table + regression test) lands with the merge. Stages A–D
open in parallel; Stage E follows once A–D are green. Task #65's
flag-flip gate does not lift until Stage E's PR merges and the
`WRAPPER_FOR_KIND_AND_MEASUREMENT` table is fully restored with
passing `test_custom_*` coverage.

No user-visible change lands until Stage E. Shadow mode continues to
run over compat-generated overrides, which target known dataPoints
and resolve via the default map's direct descriptor references —
those paths never touch the table Stage 0 empties.

## Alternatives considered

- **Refactor the wrappers into one generic class parameterized by a
  descriptor.** Attractive but hits the review's "no consolidation"
  non-goal and forces a cache-invalidation event (structural
  signature changes when a wrapper's identity changes). Deferred to
  post-2.0.
- **Emit static overrides from compat that give each custom row a
  known-dataPoint alias.** Would sidestep the wrapper generic-ness
  question by never routing through the resolution table. Rejected
  because users setting custom sensors are exactly the population
  the resolution table exists for.
- **Ship v2.0 GA with the resolution table permanently empty.**
  Would meet §17.1 vacuously by refusing to instantiate custom
  wrappers at all. Rejected: task #62 (co / leak / contact /
  occupancy wrappers) and any future extension of the vocabulary
  depend on the machinery working.

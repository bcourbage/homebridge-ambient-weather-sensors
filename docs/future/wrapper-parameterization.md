# Wrapper parameterization — v2.0 GA blocker

Design for fixing review finding #4 (P0) before the v2.0.0 GA flag flip.

## Problem

Every accessory wrapper class shipped in v1.6.0 hardcodes the AWN key,
sensor label, default threshold, unit choice, display mode, source-unit
conversion, and (for extended sensors) the intensity-bucket function.
Native wrappers additionally hardcode structurally important choices:
`TemperatureAccessory` always converts F → C, `SolarRadiationAccessory`
always converts W/m² → lux, and `AirQualityAccessory` chooses its
PM2.5-vs-PM10 characteristic set from `accessory.context.device.type`.

For v1.6.0 this is fine — the class-name-as-identity model is a 1:1 map
to AWN's fixed vocabulary. For v2 it fails: the sensor-map's
`WRAPPER_FOR_KIND_AND_MEASUREMENT` promises that a user-declared
`{ kind: 'motion', measurement: 'wind-speed', dataPoint:
'my_barn_wind', threshold: 40, sourceUnit: 'kph' }` will run through
`WIND_SPEED_WRAPPER` and honor those non-default inputs. Today the
resolved constructor throws away the row entirely and pulls
`platform.config.thresholds.windSpeedMph` / hardcoded `'windspeedmph'` /
`platform.config.units.windSpeed`. The custom row's dataPoint,
threshold, source unit, and (when named) label never reach the runtime
object. The same pattern exists across wind, rain, pressure, UV,
lightning, and both PM particulate wrappers.

Value routing compounds the problem. Wrappers do not fetch their value
from AWN; the platform's `parseDevices` + `distribute` pipeline reads
`(stationMac, dataPoint)` off AWN's payload and calls
`wrapper.setValue(number)`. Parameterizing `options.awnKey` inside a
wrapper only changes what appears in its debug logs — it does NOT
make a custom dataPoint route to that wrapper. Custom-sensor support
therefore needs BOTH:

1. Wrappers consume the effective row so they interpret the value they
   receive correctly (unit conversion, threshold, name, battery).
2. The platform's distribute pipeline builds a `(stationMac,
   dataPoint) → wrapper instance` lookup from the effective map, so
   custom rows actually receive their AWN values in the first place.

Acceptance criterion §17.1 in the sensor-map design ("canonical
wrappers are generic — a custom `(kind, measurement)` row instantiates
the same class with different runtime knobs, and its AWN values reach
that instance") is false on the shipping code. Until this fix lands,
`WRAPPER_FOR_KIND_AND_MEASUREMENT` promises a capability the codebase
cannot honor.

## Non-goals

- No new wrappers. Kinds without a concrete class today (co, leak,
  contact, occupancy) stay out of the lookup table.
- No consolidation. The 25 shipping descriptors remain 1:1 with their
  class. This design touches how those classes take input, not how
  many there are.
- No UI. Custom sensors are v2-mode-only for now; the v1.6.0 config UI
  surface does not need to grow.
- No `structuralSignature` change for existing default-map rows. When
  the row values match what the class hardcodes today, the produced
  HAP service graph must be byte-identical to v1.6.0's — this is what
  graph-parity fixtures (below) enforce.
- No custom-row battery-collision resolution. Two custom rows naming
  the same `batteryField` on the same station is a v2.1 problem; for
  2.0 GA the second row's battery ownership loses deterministically
  (first-write-wins by iteration order) and emits a validation
  warning.

## Proposal

### The row IS the wrapper input — but the platform owns the wiring

Wrappers are input consumers. The platform is the input router.

**Wrappers** — every constructor grows one parameter (the resolved row)
and reads every runtime knob from it, replacing:
- module-level `platform.config.thresholds.*` lookups (extended
  wrappers);
- module-level `platform.config.units.*` lookups (wind, rain,
  pressure, distance);
- module-level `platform.config.extendedDisplayMode` check;
- hardcoded AWN key (`'windspeedmph'`) — kept for log labels;
- hardcoded source unit (F for temperature, W/m² for solar, mph for
  wind, in/hr for rain rate, inHg for pressure, mi for distance);
- hardcoded sensor label (`'Wind Speed'`, `'Outdoor Temperature'`);
- hardcoded trigger direction (`'below'` for pressure and lightning
  distance);
- hardcoded PM variant (`AirQualityAccessory` looks at
  `context.device.type`).

**Platform** — the `distribute` pipeline replaces its
`uniqueId → SensorAccessory` map with an `(stationMac|dataPoint) →
wrapper instance` map built from the effective sensor map at
registration time. When AWN reports a value under
`stations[i].lastData[dp]`, the platform looks up the wrapper for that
(mac, dp) pair. This is what makes a custom dataPoint receive its
readings; the wrapper's `options.awnKey` never enters routing.

### Row → constructor: measurement-specific factories

`WrapperDescriptor.constructor` is currently typed `unknown` and every
wrapper family has different constructor arguments and different valid
row shapes (`NumericSensorRow` for temperature / wind, `TimestampSensorRow`
for last-rain / lightning-last-strike, `BooleanSensorRow` reserved for
future kinds). A single generic constructor type therefore doesn't
type-check.

Solution: a typed factory registry keyed by `WrapperId`, where each
factory's parameter type narrows to the measurement it serves.
Wrappers themselves keep their classes; the factories are tiny
adapters that assert the row type and instantiate.

```typescript
// src/sensorMap/wrapperFactories.ts (new)

// A compile-time mapping from wrapper id to the concrete row shape
// that wrapper's constructor accepts. Every mapped-type entry
// narrows to a measurement literal, so `Factory<RowForWrapperId[K]>`
// below refuses to accept a factory whose row type is broader than
// its wrapper.
type RowForWrapperId = {
  'temperature':           NumericSensorRow & { measurement: 'temperature' };
  'humidity':              NumericSensorRow & { measurement: 'humidity' };
  'solar-radiation':       NumericSensorRow & { measurement: 'illuminance' };
  'co2':                   NumericSensorRow & { measurement: 'co2' };
  'air-quality-pm25':      NumericSensorRow & { measurement: 'pm25' };
  'air-quality-pm10':      NumericSensorRow & { measurement: 'pm10' };
  'uv':                    NumericSensorRow & { measurement: 'uv-index' };
  'wind-speed':            NumericSensorRow & { measurement: 'wind-speed' };
  'wind-gust':             NumericSensorRow & { measurement: 'wind-speed' };
  'wind-max-daily-gust':   NumericSensorRow & { measurement: 'wind-speed' };
  'wind-direction':        NumericSensorRow & { measurement: 'direction' };
  'wind-direction-10m':    NumericSensorRow & { measurement: 'direction' };
  'pressure-relative':     NumericSensorRow & { measurement: 'pressure' };
  'pressure-absolute':     NumericSensorRow & { measurement: 'pressure' };
  'rain-rate':             NumericSensorRow & { measurement: 'rain-rate' };
  'rain-event':            NumericSensorRow & { measurement: 'rain-accumulation' };
  'rain-daily':            NumericSensorRow & { measurement: 'rain-accumulation' };
  'rain-weekly':           NumericSensorRow & { measurement: 'rain-accumulation' };
  'rain-monthly':          NumericSensorRow & { measurement: 'rain-accumulation' };
  'rain-yearly':           NumericSensorRow & { measurement: 'rain-accumulation' };
  'last-rain':             TimestampSensorRow;
  'lightning-day':         NumericSensorRow & { measurement: 'count' };
  'lightning-hour':        NumericSensorRow & { measurement: 'count' };
  'lightning-distance':    NumericSensorRow & { measurement: 'distance' };
  'lightning-last-strike': TimestampSensorRow;
};

type Factory<R> = (
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  row: R,
) => SensorAccessory;

// The registry itself is a MAPPED type. Each entry's factory is
// obligated to accept exactly the row shape declared above — nothing
// broader, nothing narrower. A wind factory typed against
// NumericSensorRow (not narrowed to wind-speed) fails to type-check.
export const FACTORIES: { [K in WrapperId]: Factory<RowForWrapperId[K]> } = {
  'temperature':        (p, a, r) => new TemperatureAccessory(p, a, r),
  'wind-speed':         (p, a, r) => new WindSpeedAccessory(p, a, r),
  'last-rain':          (p, a, r) => new LastRainAccessory(p, a, r),
  // ...one entry per WrapperId; TypeScript enforces exhaustive coverage.
};

// The dispatch boundary is where the compile-time <K, RowForWrapperId[K]>
// correlation gets erased by the `EffectiveSensorRow` we happen to be
// holding. Runtime asserts that the row's `wrapperId` matches its
// `kind × measurement` shape before calling the factory.
export function instantiateWrapper(
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  row: EffectiveSensorRow,
): SensorAccessory {
  if (row.kind === 'unrecognized') {
    throw new Error(`Cannot instantiate wrapper for unrecognized row ${row.dataPoint}`);
  }
  assertRowMatchesWrapperId(row);  // throws if measurement drifted from wrapperId
  const factory = FACTORIES[row.wrapperId] as Factory<EffectiveSensorRow>;
  return factory(platform, accessory, row);
}
```

The compile-time `RowForWrapperId` table has a runtime twin that
enforces the full `kind × measurement` contract for every wrapper
id, not just the measurement (kind matters because two rows with
the same measurement but different kinds — e.g. a hypothetical
`(motion, timestamp)` vs the `(unrecognized, timestamp)` branch —
must not both route to the same timestamp factory):

```typescript
// src/sensorMap/wrapperFactories.ts (same file)
// The single specification the type table + runtime check both
// derive from. `as const` keeps the literals narrow.
export const WRAPPER_SPEC = {
  'temperature':           { kind: 'temperature',       measurement: 'temperature'       },
  'humidity':              { kind: 'humidity',          measurement: 'humidity'          },
  'solar-radiation':       { kind: 'light',             measurement: 'illuminance'       },
  'co2':                   { kind: 'co2',               measurement: 'co2'               },
  'air-quality-pm25':      { kind: 'air-quality-pm25',  measurement: 'pm25'              },
  'air-quality-pm10':      { kind: 'air-quality-pm10',  measurement: 'pm10'              },
  'uv':                    { kind: 'motion',            measurement: 'uv-index'          },
  'wind-speed':            { kind: 'motion',            measurement: 'wind-speed'        },
  // ... entry per WrapperId ...
} as const satisfies Record<WrapperId, { kind: SensorKind; measurement: Measurement }>;

// `RowForWrapperId` is derived FROM this spec so the two can't drift.
export type RowForWrapperId = {
  [K in WrapperId]: EffectiveSensorRow & {
    kind: typeof WRAPPER_SPEC[K]['kind'];
    measurement: typeof WRAPPER_SPEC[K]['measurement'];
  };
};

export function assertRowMatchesWrapperId(row: EffectiveSensorRow): void {
  if (row.kind === 'unrecognized') { return; }
  const spec = WRAPPER_SPEC[row.wrapperId];
  if (row.kind !== spec.kind || row.measurement !== spec.measurement) {
    throw new Error(
      `Wrapper ${row.wrapperId} expects (${spec.kind}, ${spec.measurement}); ` +
      `row for ${row.stationMac}|${row.dataPoint} has (${row.kind}, ${row.measurement}).`,
    );
  }
}
```

Enforcement runs at TWO points, defense-in-depth:

- **In `buildEffectiveSensorMap`**: right after `wrapperId` is assigned
  to a row, the resolver calls `assertRowMatchesWrapperId`. On
  mismatch the row is dropped and a `wrapper-mismatch` error is
  added to `EffectiveSensorMap.errors` (using the existing
  RowValidationError channel). This is the first line of defense
  and catches every drift between the default map / resolution
  table and the wrapper spec at map-build time, without ever
  reaching the platform.

- **In `instantiateWrapper`**: same call runs defensively at
  registration. If it throws here (which it shouldn't if
  buildEffectiveSensorMap did its job), the caller in `platform.ts`
  catches the exception, logs an error naming the row, drops that
  wrapper from the routing map, and continues registering the
  rest. Startup does not crash.

Registration-time throw handling is a general contract, not just
for this check — a wrapper constructor throwing for any reason
(bad accessory context, HAP init failure) must be isolated to that
row. Every registration site catches.

`air-quality-pm25` and `air-quality-pm10` are the reason we need
distinct `WrapperId`s that share a class — the factory names the
variant explicitly. The wrapper receives the variant as an implicit
input via which factory instantiated it, not from
`accessory.context.device.type`.

Every entry in `WRAPPER_FOR_KIND_AND_MEASUREMENT` requires a matching
`FACTORIES` entry; the snapshot test locks both.

### Constructor shape and unit routing

```typescript
// Extended-family constructor (wind speed shown; every extended
// wrapper follows this pattern).
class WindSpeedAccessory extends WindSpeedLikeAccessory {
  constructor(
    platform: AmbientWeatherSensorsPlatform,
    accessory: PlatformAccessory,
    row: NumericSensorRow,   // narrowed by the wrapper's WrapperId
  ) {
    super(platform, accessory, {
      sensorLabel: row.name,
      awnKey: row.dataPoint,          // logging only
      threshold: row.triggerEnabled === false
        ? Infinity                     // triggerEnabled: false → no motion event
        : row.threshold ?? Infinity,   // blank threshold in v1 = Infinity sentinel
      triggerDirection: row.triggerDirection ?? 'above',
      displayMode: row.embedName ? 'embed' : 'static',
      sourceUnit: row.sourceUnit,     // AWN's native unit for this row's data
      displayUnit: row.displayUnit,   // what the user sees
    });
  }
}
```

`ExtendedSensorOptions` splits into discriminated numeric vs
timestamp shapes. `TimestampSensorRow` has no `displayUnit` and
`sourceUnit` is always `'ms'` by contract, so bundling everything
into one interface would either lie about the timestamp shape or
force stringly-typed defaults. Numeric options also need
`measurement` because that's what `toCanonical` dispatches on:

```typescript
interface CommonOptions {
  sensorLabel: string;
  awnKey: string;
  displayMode: ExtendedDisplayMode;
  triggerEnabled: boolean;
  triggerDirection: 'above' | 'below';
  threshold: number;              // in sourceUnit for numeric; ms for timestamp
}

export interface NumericExtendedOptions extends CommonOptions {
  variant: 'numeric';
  measurement: Exclude<Measurement, 'timestamp' | 'boolean'>;
  sourceUnit: SensorUnit;
  displayUnit: SensorUnit;
}

export interface TimestampExtendedOptions extends CommonOptions {
  variant: 'timestamp';
  // measurement is implied ('timestamp'); sourceUnit is always 'ms'.
  // No displayUnit — timestamps render as relative time via a
  // wrapper-owned formatter, no unit knob.
}

export type ExtendedSensorOptions =
  | NumericExtendedOptions
  | TimestampExtendedOptions;
```

The base class dispatches on `options.variant`. `toCanonical` sees
the concrete `measurement` for numeric variants and the fixed
`'ms'` implicit unit for timestamps. Callers construct one variant
or the other — TypeScript rejects a timestamp options value with
`displayUnit` set.

**Unit conversion chain**. AWN reports a raw number at
`stations[i].lastData[dataPoint]`. Its unit is the row's `sourceUnit`
(not necessarily AWN's default — a custom sensor reporting temperature
in Celsius has `sourceUnit: 'celsius'` even though every AWN-native
temperature row is Fahrenheit). Every wrapper family has one canonical
unit for its internal comparisons (thresholding, intensity bucketing):

| family | canonical unit | reason |
|---|---|---|
| temperature | celsius | HAP's `CurrentTemperature` characteristic |
| humidity | percent | no ambiguity |
| illuminance | lux | HAP's `CurrentAmbientLightLevel` |
| co2 | ppm | HAP's `CarbonDioxideLevel` |
| pm25 / pm10 | ugm3 | HAP's `PM2_5Density` / `PM10Density` |
| wind speed / gust | mph | Beaufort scale is defined in mph |
| rain rate | in/hr | matches AWN + hardcoded bucket labels today |
| rain accumulation | in | ditto |
| pressure | inHg | matches AWN + threshold semantics |
| distance | mi | lightning-distance bucket labels |
| uv-index | index | dimensionless |
| direction | degrees | 0–360 |
| count | count | integer |
| timestamp | ms | Unix ms; wrapper renders relative |

The chain is:

```
raw AWN value      (in row.sourceUnit)  ─┐
                                          ├─→ toCanonical(measurement, sourceUnit, x)
row.threshold      (in row.sourceUnit)  ─┘        │
                                                  ▼
                                    canonical value + canonical threshold
                                                  │
                                                  ├─→ formatIntensity(canonical)   // scale-anchored buckets
                                                  ├─→ compareThreshold(canonical)  // MotionDetected transition
                                                  │
     ┌────────────────────────────────────────────┼──────────────────────────────────────────────┐
     │ native HAP wrappers                        │ extended (motion-family) wrappers            │
     │                                             │                                              │
     │ canonical value                             │ canonical value                              │
     │      │                                      │      │                                       │
     │      └─→ HAP characteristic                 │      └─→ toDisplayUnit(canonical,            │
     │            in the characteristic's          │              row.displayUnit)                │
     │            HAP-fixed unit                   │            │                                 │
     │            (CurrentTemperature = °C,        │            └─→ formatValue(displayValue)     │
     │             CurrentAmbientLightLevel        │                  → wrapper's custom string   │
     │             = lux, PM2_5Density = μg/m³)    │                    characteristic            │
     │                                             │                                              │
     │ row.displayUnit is IGNORED here;            │ MotionDetected characteristic is             │
     │ the HAP characteristic's unit is fixed.     │ separately driven by compareThreshold.       │
     └────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

`row.displayUnit` is presentation-only. Its ONLY consumer is the
extended wrappers' custom-string characteristic (the label users see
in Eve / Home / Controller for HomeKit). Native HAP wrappers write
canonical into a fixed-unit characteristic and never touch
`displayUnit` — attempting to would corrupt HAP's interpretation
(writing `68 fahrenheit` into `CurrentTemperature` makes HomeKit
report 68°C). Validation still accepts `displayUnit` on native rows
(it's a legal SensorMapOverride field), but the wrapper drops it on
the floor with a debug log; a Group-3 refinement could tighten
validation to warn on `displayUnit` set for a native row, but that's
out of scope for v2.0 wrapper parameterization.

Two units-related invariants:

1. `row.threshold` is stored in `row.sourceUnit`, matching the schema
   frozen in `docs/future/sensor-map.md` §3.7 and `types.ts` — the
   existing contract validation and the UI currently enforce. A row
   `{ sourceUnit: 'kph', threshold: 40 }` means "40 kph." The wrapper
   converts BOTH the incoming raw value AND the threshold to canonical
   via the same `toCanonical(measurement, sourceUnit, x)` helper
   before comparing. That way the comparison always happens in the
   family's canonical unit — needed because the intensity-bucket
   functions (`beaufort`, `bucketRainRate`, etc.) are scale-anchored
   there — without ever asking validation to guess "what unit is this
   bare number written in?"

2. `row.sourceUnit` may be any legal unit for the row's measurement
   (per `LEGAL_UNITS_FOR_MEASUREMENT` in `units.ts`). The wrapper
   converts to canonical on every read via `toCanonical`; the
   identity case (`sourceUnit === canonical`) is a no-op. Non-identity
   cases are real conversions: `kph → mph` for a custom wind sensor
   reporting in kph, `celsius → fahrenheit`… no, wait: because
   canonical for temperature is Celsius, an AWN-native
   `sourceUnit: 'fahrenheit'` gets converted to Celsius at the
   boundary, not the other way around. This is a departure from
   today's code (which does the F→C conversion inside
   TemperatureAccessory) but the ARITHMETIC is identical — only the
   layer that owns the conversion moves.

   Compat produces overrides whose `threshold` field matches the
   legacy `platform.config.thresholds.*` values verbatim, in whatever
   unit the user had them in (v1.6.0's config schema stored them in
   AWN-native units — mph, in/hr, inHg, mi). The corresponding
   `sourceUnit` on the emitted row is the AWN-native unit for that
   measurement, so the pair is self-consistent.

### Native wrappers are NOT the small case

The prior draft called native wrappers "smallest surface." That was
wrong. Every native wrapper hardcodes structural or unit choices:

- `TemperatureAccessory`: always converts `°F → °C` before writing
  the HAP characteristic. Under the row model, if `row.sourceUnit ===
  'celsius'` (custom sensor) the conversion is skipped.
- `SolarRadiationAccessory`: always converts `W/m² → lux` (via a
  hardcoded multiplier). Under the row model, if `row.sourceUnit ===
  'lux'` the conversion is skipped.
- `Co2Accessory`: fixed unit + fixed 1000-ppm alert threshold. The
  threshold stays hardcoded in the wrapper for v2.0 — CO₂ isn't a
  motion kind, and `row.threshold` is contractually motion-only per
  the sensor-map v2.0 schema (validation strips it from non-motion
  rows; `resolveRow` only carries it when `kind === 'motion'`).
  Making CO₂'s trigger point row-driven is a schema change (touching
  types, validation, sensor-map.md, and migration tests) that we
  deliberately defer to post-2.0. Same applies to any other native
  wrapper that today hardcodes an alert threshold outside the motion
  family — it stays hardcoded.
- `AirQualityAccessory`: today reads
  `accessory.context.device.type === 'PM25'` vs `'PM10'` to decide
  which characteristic to attach. Under the row model, the factory
  entry (`'air-quality-pm25'` vs `'air-quality-pm10'`) already names
  the variant — the wrapper accepts the variant as a constructor arg
  and never looks at `context.device.type`. This removes a
  cross-source-of-truth (row says one thing, cache context says
  another) that has bitten upgrades before.
- `HumidityAccessory`: no unit variance; still takes the row for name
  + battery.

All five native wrappers therefore need row-driven parameterization
with the same rigor as extended wrappers.

### Custom-row battery attachment — full lifecycle

Current effective-map resolution sets `hasBatterySubService = batteryField !== null && (defaultRow?.canonicalForBattery ?? false)`.
For a custom row there is no `defaultRow`, so `hasBatterySubService`
is always `false` and `batteryField` might be truthy but is never
consumed. That means the current design's "custom row Battery
sub-service" is unreachable end-to-end. Fixing it requires changes
at four points:

**1. Effective-map resolution.** Ownership is a two-tier rule that
preserves v1.6.0 behavior EXACTLY for default-map rows and only
introduces new logic for user-authored custom rows:

- **Reserved owner** — every AWN battery field is contractually
  owned by the default-map row with `canonicalForBattery: true`
  for that field (battout → tempf, batt_co2 → co2_in_aqin, and so
  on, per `DEFAULT_SENSOR_MAP`). This is the v1.6.0 rule and it
  stays authoritative when the reserved row is present AND
  enabled. Non-canonical default rows that name the same
  batteryField (intentional plugin-side sharing — e.g. every
  outdoor sensor references `battout`) get `hasBatterySubService:
  false` without warning; the sharing is by design and users
  shouldn't see noise about it.

- **Custom claimants** — a user-authored row (not in the default
  map) may claim a batteryField ONLY when there's no reserved
  owner for that (station, batteryField) pair — either the field
  is outside AWN's vocabulary (`my_barn_batt`), or the canonical
  owner is absent because the station doesn't report the
  canonical row (rare but possible with partial-hardware
  stations). If two user rows claim the same field, the earliest
  by resolution metadata (see below) wins and a
  `duplicate-battery-owner` warning surfaces naming the winner so
  the UI can present the choice. Warnings fire ONLY on
  user-authored conflicts — never on the default-map sharing.

- **Disabled rows** — disabled rows do not participate in
  ownership. Disabling the reserved canonical owner does NOT roll
  ownership to the next default-map candidate (structural
  signatures would drift as users toggle enable state) and does
  not promote a user row to owner. The battery field simply gets
  no HAP sub-service on that station until the reserved owner is
  re-enabled. `buildEffectiveSensorMap` emits an
  `orphan-battery-field` info-level note when a user disables the
  reserved owner while other rows still reference the field, so
  users understand why the sub-service went away.

The pass runs BEFORE `structuralSignature` is computed on the row,
so signature stability is a function of resolved ownership, not the
order signature-vs-ownership happens in. Ownership is a pure
function of `(enabled rows in effective map, resolution metadata,
DEFAULT_SENSOR_MAP)`; identical inputs across restarts produce
identical ownership, so signatures don't drift.

**Resolution metadata (internal, not on the public row schema).**
Override provenance today is threaded to error/warning attribution
only — it is NOT carried on `EffectiveSensorRow`, and it must not
be (the frozen schema is a public surface). buildEffectiveSensorMap
grows an internal side table:

```typescript
// Internal to buildEffectiveSensorMap; NOT exported on
// EffectiveSensorMap. Keyed by (stationMac, dataPoint).
interface RowResolutionMeta {
  earliestOverrideIndex: number | undefined; // undefined if row came only from defaults
}
type ResolutionMetaMap = Map<string, RowResolutionMeta>;
```

The ownership pass reads `earliestOverrideIndex` off this map for
user-row ordering. Ties (two custom rows tied on `overrideIndex`)
resolve deterministically on `(stationMac, dataPoint)`
lexicographic order — never on discovery iteration order, which
would depend on observation history.

**2. Platform parse pipeline** (unchanged for known dataPoints,
extended for custom). Today's `parseDevices` calls
`batteryFieldForSensor(sensorKey)` to look up which AWN battery
field goes with a known sensor and reads that field off
`station.lastData`. For custom rows the answer isn't in the built-in
map — instead, parseDevices reads `row.batteryField` from the
effective-map entry for the (station, dataPoint) pair. `batteryLow`
is derived the same way (`readBatteryLow`); the resulting boolean
is stamped into `accessory.context.device.batteryLow` BEFORE the
wrapper constructor runs, so `setupBatteryService`'s existing
initial-value seeding still works.

**3. Wrapper construction.** `setupBatteryService` today attaches
the BatteryService when `context.device.batteryLow !== undefined`.
Under the row model that gate becomes explicit: attach iff
`row.hasBatterySubService`. This decouples "we saw a battery value"
from "this wrapper OWNS the sub-service" — a non-owner row can
have `batteryField` set (for reading) and correctly NOT get the
sub-service.

**4. Runtime updates.** Polling and realtime are TWO independent
sources today and neither goes through a single shared reader.
Polling calls `batteryFieldForSensor(sensorKey)` inside
`parseDevices`; `RealtimeSource` (in `src/realtime/*.ts`)
independently calls the same helper. A custom `batteryField` fixes
polling if we swap that one lookup for `row.batteryField`, but
realtime would still miss the field. Both need the fix.

The proposed change:

- Introduce a shared row-aware battery-field resolver:
  `resolveBatteryField(effectiveMap, stationMac, dataPoint) →
  string | null`. Prefers the row's `batteryField` when present;
  falls back to `batteryFieldForSensor(dataPoint)` for
  legacy-flag-off paths that don't yet have an effective map.
- Polling (`parseDevices`) calls the shared resolver.
- Realtime does one of the following (Stage 2 picks whichever is
  smaller):
  - refactor `RealtimeSource` to deliver its raw station payloads
    to a platform-owned handler that runs the same reader as
    polling; OR
  - inject the shared resolver into `RealtimeSource` at
    construction, replacing its direct `batteryFieldForSensor`
    call.

Both replacements keep the existing "0 means low" semantics AWN
uses on its battery fields — the plugin's `readBatteryLow` helper
converts that to a boolean and the wrapper's `setBatteryLow`
consumes the boolean. No change to that reading.

Stage 2's battery-family PR includes two integration tests, one per
transport:

- Polling test: seeds a custom row with `batteryField:
  'my_barn_batt'`, feeds a polled AWN payload where
  `my_barn_batt === 0`, asserts `setBatteryLow(true)` fired on
  the wrapper AND `context.device.batteryLow` was seeded before
  the constructor ran (sub-service exists on first tick).
- Realtime test: same setup but the payload arrives via
  `RealtimeSource`'s subscription callback, asserts the same
  outcome. This is the test that would have caught the current
  gap where realtime uses its own reader.

### Value distribution — the routing that makes custom sensors receive readings

Platform's `parseDevices` today builds a `Devices[]` list keyed by
`uniqueId` (`MAC-sensorKey`). `distribute` iterates AWN payloads,
looks up the wrapper for each entry via that uniqueId, and calls
`wrapper.setValue(value)`.

Under v2, `uniqueId` is still `MAC-dataPoint` — but for a custom row
the dataPoint is `my_barn_wind` rather than an AWN-vocabulary key.
Nothing in `parseDevices`'s current `determineSensorType`-based
matching would recognize `my_barn_wind`; the value gets dropped.

The fix: `distribute` reads its routing from the effective sensor map
directly. The pipeline becomes:

```typescript
// After buildEffectiveSensorMap in the v2 path (already run at boot).
// Register each row's wrapper instance under (mac, dataPoint).
for (const row of enabledConfiguredRowsIn(effectiveMap)) {
  const uid = `${row.stationMac}-${row.dataPoint}`;
  const accessory = accessoryForUid(uid);
  const wrapper = instantiateWrapper(platform, accessory, row);
  routing.set(`${row.stationMac.toUpperCase()}|${row.dataPoint}`, wrapper);
}

// distribute (renamed / rewritten in stage E)
for (const station of stations) {
  for (const [dp, value] of Object.entries(station.lastData)) {
    const key = `${station.macAddress.toUpperCase()}|${dp}`;
    routing.get(key)?.setValue(coerceValue(value));
  }
}
```

Custom dataPoints receive updates because the routing map includes
them. Known dataPoints keep working because compat rows produce the
same `(mac, dp)` keys.

This is the load-bearing change that makes the resolution table
useful; parameterizing wrapper constructors without this is
window-dressing.

### Migration order (staged, with the call site done FIRST)

Design (this PR, #19) is docs-only. Every following stage is its own
code PR, blocking the next one until it merges green.

- **Stage 0 — Interim safety.** Empty the 15 entries in
  `WRAPPER_FOR_KIND_AND_MEASUREMENT` and add a regression test
  proving the table is empty (so a future well-meaning restore
  without the underlying wiring can't slip in unnoticed). Every
  custom `(kind, measurement)` row starts failing
  buildEffectiveSensorMap validation with "no wrapper for (kind,
  measurement)." Compat-generated overrides against known
  dataPoints keep working because those route via
  `defaultMap.wrapper` (direct reference), not through the
  resolution table.

  This stage lands as a follow-up PR immediately after PR #19
  merges. The design doc itself does not empty the table — a
  docs-only PR would leave the promised safety measure unshipped.
  Any Group-3 code PR that would restore an entry earlier is
  blocked on Stage 4.

- **Stage 1 — Factory registry + platform routing (adapter form).**
  Adds the typed `FACTORIES: { [K in WrapperId]: Factory<RowForWrapperId[K]> }`
  registry AND the platform-side `(mac, dp) → wrapper` routing map.
  Existing wrapper constructors are UNCHANGED — they still take
  `(platform, accessory)` only. Each factory entry is an ADAPTER
  that accepts the row and DISCARDS it, then invokes the legacy
  two-argument constructor:

  ```typescript
  // Stage 1 factories — every entry looks like this.
  'wind-speed': (p, a, _row) => new WindSpeedAccessory(p, a),
  ```

  This keeps every existing test and the v1.6.0 code path green
  while giving the platform something to call with a row. No
  behavioral change. No table restoration.

- **Stage 2 — Family-by-family constructor migration.** Each of the
  ten wrapper families (temperature; humidity; solar; co2; air
  quality; wind; rain; pressure; UV; lightning) lands as its own
  PR. That PR:
  - Adds a third parameter (the family-specific row) to the
    wrapper's constructor(s) and reads every runtime knob from the
    row.
  - Replaces that family's Stage-1 adapter with the row-aware form:
    `'wind-speed': (p, a, r) => new WindSpeedAccessory(p, a, r)`.
  - Ships `test_custom_<family>` covering every measurement variant
    in the family with non-default row values (name, threshold,
    sourceUnit, displayUnit, triggerDirection, triggerEnabled:
    false, embedName, batteryField where applicable). These tests
    call `wrapper.setValue(raw)` directly with an
    EXPLICITLY-CONSTRUCTED row; they do NOT go through
    buildEffectiveSensorMap (the resolution table is still empty).
  - Ships graph-parity fixtures for every WrapperId in the family
    (see Testing below).
  - Does NOT restore any resolution-table entry.

- **Stage 3 — Value routing goes live (adapter-boundary test).**
  Platform's `distribute` routes via the `(mac, dp) → wrapper` map
  built from the effective map. Ships a platform-boundary
  integration test that constructs an `EffectiveSensorRow`
  explicitly (bypassing buildEffectiveSensorMap so the still-empty
  resolution table doesn't reject the custom row), registers it in
  the routing map, feeds an AWN payload containing its
  `dataPoint`, and asserts `wrapper.setValue(expected)` fired.

  This is deliberately a boundary test: it proves the
  `station.lastData → routing map → wrapper.setValue` wire, not
  the `config.sensorMap → buildEffectiveSensorMap → row → routing
  map` flow. The full config-to-value integration is Stage 4's job
  because only Stage 4 restores the table entries that let a
  custom row survive validation.

- **Stage 4 — Restore `WRAPPER_FOR_KIND_AND_MEASUREMENT` +
  full-flow integration tests.** Only after Stages 1–3 all merge
  and go green in CI. Restoration is ALL-OR-NOTHING: the entire
  15-entry table comes back in one PR alongside:
  - `test_custom_<entry>` for all 15 entries, this time going
    through the full `config.sensorMap → buildEffectiveSensorMap →
    routing → wrapper` pipeline;
  - platform-integration test proving each custom row actually
    routes end-to-end from raw AWN payload to HAP characteristic
    value.

- **Stage 5 — Retire the Stage-1 adapter form.** Every factory
  entry is now row-aware, so the "Stage 1 adapter" description in
  the code comments gets tightened and any unused legacy fallback
  paths (a compat helper still reading from `platform.config.*`
  where the row already carries the answer) get removed. Mostly
  documentation + dead-code cleanup at this point.

Task #65's flag-flip gate does not lift until Stage 4's PR merges
with `WRAPPER_FOR_KIND_AND_MEASUREMENT` fully populated and
`test_custom_*` + graph-parity + platform-integration all green.
Stage 5 is optional cleanup and does not block the flag flip.

## Testing

### Graph-parity fixtures (Stage 2 gate)

Before Stage 2 begins, capture a normalized snapshot of every
WrapperId's HAP service graph against a canonical default-row input.
The snapshot must cover every field that can change HomeKit behavior
on a client, not just the field names — the earlier draft's format
missed characteristic props, permissions, ranges, and primary/hidden
flags, all of which can shift accessory behavior invisibly.

Normalized snapshot shape. The `CharSnapshot` fields mirror
HAP-NodeJS's `CharacteristicProps` interface directly — same field
names (`unit`, not `units`; `validValueRanges` is a single tuple,
not an array), same types, so any behavior-affecting prop HAP ships
today is captured. If HAP-NodeJS's `CharacteristicProps` evolves,
the serializer implementation regenerates from that interface via
a small type-import script (documented at the top of
`tests/helpers/graphSnapshot.ts`) so the two stay in sync:

```typescript
interface GraphSnapshot {
  wrapperId: WrapperId;
  services: Array<{
    uuid: string;
    subtype?: string;
    isPrimary: boolean;
    isHidden: boolean;
    linkedTo: string[];                 // subtypes of linked services, sorted
    characteristics: CharSnapshot[];    // sorted by UUID
    optionalCharacteristics: string[];  // UUIDs actually attached, sorted
  }>;
}

// One-to-one with HAP-NodeJS's CharacteristicProps as of the
// pinned homebridge peerDep major. Serialize every field HAP
// itself exposes on the characteristic; add new fields here when
// the peerDep bumps and CharacteristicProps grows.
interface CharSnapshot {
  uuid: string;                          // HAP characteristic UUID
  format: string;                        // Formats: bool/int/uint8/float/string/tlv8/…
  perms: string[];                       // Perms: pr/pw/ev/aa/tw/hd/wr, sorted
  unit?: string;                         // Units: celsius/percentage/lux/…
  minValue?: number;
  maxValue?: number;
  minStep?: number;
  validValues?: number[];                // enum characteristics; sorted
  validValueRanges?: [number, number];   // HAP: a SINGLE tuple, not an array
  maxLen?: number;                       // string format
  maxDataLen?: number;                   // data format
  adminOnlyAccess?: string[];            // sorted
  initialValue: unknown;                 // seeded value; volatile list below
}
```

Excluded from the snapshot as EXPLICITLY VOLATILE:

- Any characteristic value that reflects live sensor state
  (`CurrentTemperature`, `MotionDetected`, `StatusLowBattery`, etc.)
  once the wrapper has been fed a value. `initialValue` captures the
  seeded value at construction time — the same "0" or default the
  wrapper writes before any AWN payload arrives — but not later
  updates.
- HAP UUIDs generated per-boot (accessory `UUID`, `iid`s). Every
  characteristic and service in the snapshot is keyed by its HAP
  type UUID (stable) plus subtype (also stable), never `iid`.
- Presentation strings that Homebridge itself owns (e.g.
  Manufacturer / Model / SerialNumber under
  `AccessoryInformation`). The snapshot pins the presence of those
  characteristics on the AccessoryInformation service but not their
  string contents, which are already row-driven (`row.name` etc.)
  and covered by `test_custom_*`.

Serializer implementation lives in
`tests/helpers/graphSnapshot.ts`. It runs against Homebridge's mock
HAP objects (already used by the existing wrapper tests). Both the
"before Stage 2" baseline and each family's post-refactor assertions
call the same serializer — the two snapshots are then compared with
strict deep equality.

Every Stage-2 family PR asserts byte-identical output against its
wrappers when instantiated with a row matching today's defaults. A
diff is a bug — either the refactor changed the graph
unintentionally, or the change was intentional and requires a
`schemaVersion` bump on the affected `WrapperDescriptor` with a
migration note (which itself invalidates caches — a real event, not
a snapshot update).

### `test_custom_*` per resolution-table entry (Stage 4 gate)

For each of the 15 entries in `WRAPPER_FOR_KIND_AND_MEASUREMENT`,
one test with a non-default row. The row varies:

- `dataPoint` to something outside the AWN vocabulary
  (`test_custom_<family>`);
- `name` to a distinctive string ("Barn Wind Speed");
- `threshold` to a non-default value in the row's `sourceUnit`
  (per the frozen schema — threshold is authored in sourceUnit, not
  canonical; the wrapper converts to canonical on the read side);
- `sourceUnit` to a non-default legal choice (per
  `LEGAL_UNITS_FOR_MEASUREMENT` in `units.ts` — check the actual
  literal values there; e.g. `celsius` for temperature, `kph` for
  wind speed, `lux` for illuminance, `mm_per_hr` for rain rate,
  `hPa` for pressure, `km` for distance);
- `displayUnit` to yet a different legal choice, exercising a
  two-step conversion (sourceUnit → canonical → displayUnit) for
  the extended wrappers' formatted string characteristic. Native
  HAP wrappers ignore `displayUnit` per §"HAP unit chain" above; a
  native-wrapper test asserts the HAP characteristic value stays
  in the characteristic's fixed unit regardless of what
  `displayUnit` says;
- `triggerDirection` to `'below'` on a family that normally uses
  `'above'` and vice versa;
- `triggerEnabled: false` combined with a finite threshold to prove
  no motion event fires;
- `embedName: true` on non-motion kinds (must be stripped by
  validation before reaching the wrapper — negative test);
- `batteryField: 'my_barn_batt'` to prove custom battery attachment
  (uses AWN's `0 = low` on the field to trigger `setBatteryLow(true)`).

Assertions run at TWO layers, matching Stage 3's boundary test and
Stage 4's full-flow test:

- **Stage 3 (boundary)** — construct the `EffectiveSensorRow`
  EXPLICITLY (bypassing buildEffectiveSensorMap, whose resolution
  table is still empty at that stage), register it in the routing
  map, feed a station payload containing the custom `dataPoint`,
  assert `wrapper.setValue(expected)` fired. This proves the
  `station.lastData → routing map → wrapper.setValue` wire without
  requiring the table restoration.
- **Stage 4 (full flow)** — with the resolution table restored,
  load the custom row through `config.sensorMap →
  buildEffectiveSensorMap → routing`, feed the same payload,
  assert the same outcome. Same row, same expected value, but now
  end-to-end.

### Regressions to lock in

- `triggerEnabled: false` + finite threshold → no motion event
  (regression test for the P1 finding).
- PM2.5 wrapper attaches `PM2_5Density`, not `PM10Density`, when
  built from `'air-quality-pm25'` (proves the variant comes from
  wrapperId, not `context.device.type`).
- Two custom rows sharing a `batteryField` on the same station: only
  the first-resolved gets `hasBatterySubService: true`, and a
  `duplicate-battery-owner` warning surfaces.
- Legacy config with `platform.config.units.windSpeed: 'kph'` and no
  custom row → v2 wind wrappers still display in kph (compat sets
  `displayUnit: 'kph'`).
- Migration equivalence (Group 2 §13) grows a `sourceUnit + displayUnit`
  spot-check to catch any drift between compat's unit resolution and
  the wrapper's actual unit routing.

## Rollout

This PR (#19) is docs-only.

Stage 0 opens as a follow-up code PR immediately after this design
merges, emptying `WRAPPER_FOR_KIND_AND_MEASUREMENT` and adding the
regression test. Every subsequent stage's PR blocks its successor.
No user-visible change lands until Stage 4's resolution-table
restoration.

Shadow mode continues to run over compat-generated overrides during
every stage — those target known dataPoints and always resolve via
the default map's direct wrapper reference, never through the
resolution table Stage 0 empties.

## Alternatives considered

- **Refactor the wrappers into one generic class parameterized by a
  descriptor.** Attractive but hits the review's "no consolidation"
  non-goal and forces a cache-invalidation event
  (`structuralSignature` changes when a wrapper's identity changes).
  Deferred to post-2.0.
- **Emit static overrides from compat that alias every custom row to
  a known-dataPoint entry.** Would sidestep the wrapper generic-ness
  question by never routing through the resolution table. Rejected
  because users setting custom sensors are exactly the population
  the resolution table exists for.
- **Ship v2.0 GA with the resolution table permanently empty.**
  Would satisfy §17.1 vacuously by refusing to instantiate custom
  wrappers at all. Rejected: task #62 (co / leak / contact /
  occupancy wrappers) and any future extension depend on the
  machinery working. Also punishes the small early-adopter
  population who came to v2 for exactly this feature.
- **Wrapper constructors accept a plain options object rather than
  the row.** Considered; rejected because the row IS the options
  object, and threading it directly means one thing to keep in
  sync. Wrappers destructure what they need in the ctor body.

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
  the same `batteryField` on the same station is a v2.1 problem;
  for 2.0 GA the loser is determined by resolution metadata (earliest
  `overrideIndex` wins; ties break on `(stationMac, dataPoint)`
  lexicographic order — see the ownership-pass detail below) and
  the `duplicate-battery-owner` warning surfaces naming the winner.

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

// src/sensorMap/wrapperFactories.ts (new)
//
// WRAPPER_SPEC is the SINGLE source of truth for wrapper id →
// (kind, measurement). Both `RowForWrapperId` (the compile-time
// factory-parameter narrowing) and `assertRowMatchesWrapperId` (the
// runtime check) derive from it, so a drift between the two is a
// compile error, not a bug that ships.
export const WRAPPER_SPEC = {
  'temperature':           { kind: 'temperature',      measurement: 'temperature'       },
  'humidity':              { kind: 'humidity',         measurement: 'humidity'          },
  'solar-radiation':       { kind: 'light',            measurement: 'illuminance'       },
  'co2':                   { kind: 'co2',              measurement: 'co2'               },
  'air-quality-pm25':      { kind: 'air-quality-pm25', measurement: 'pm25'              },
  'air-quality-pm10':      { kind: 'air-quality-pm10', measurement: 'pm10'              },
  'uv':                    { kind: 'motion',           measurement: 'uv-index'          },
  'wind-speed':            { kind: 'motion',           measurement: 'wind-speed'        },
  'wind-gust':             { kind: 'motion',           measurement: 'wind-speed'        },
  'wind-max-daily-gust':   { kind: 'motion',           measurement: 'wind-speed'        },
  'wind-direction':        { kind: 'motion',           measurement: 'direction'         },
  'wind-direction-10m':    { kind: 'motion',           measurement: 'direction'         },
  'pressure-relative':     { kind: 'motion',           measurement: 'pressure'          },
  'pressure-absolute':     { kind: 'motion',           measurement: 'pressure'          },
  'rain-rate':             { kind: 'motion',           measurement: 'rain-rate'         },
  'rain-event':            { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-daily':            { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-weekly':           { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-monthly':          { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-yearly':           { kind: 'motion',           measurement: 'rain-accumulation' },
  'last-rain':             { kind: 'motion',           measurement: 'timestamp'         },
  'lightning-day':         { kind: 'motion',           measurement: 'count'             },
  'lightning-hour':        { kind: 'motion',           measurement: 'count'             },
  'lightning-distance':    { kind: 'motion',           measurement: 'distance'          },
  'lightning-last-strike': { kind: 'motion',           measurement: 'timestamp'         },
} as const satisfies Record<WrapperId, { kind: SensorKind; measurement: Measurement }>;

// The compile-time factory-parameter narrowing derives from
// WRAPPER_SPEC. TypeScript rejects any factory whose row parameter
// is broader than its wrapper's declared (kind, measurement).
export type RowForWrapperId = {
  [K in WrapperId]: EffectiveSensorRow & {
    kind: typeof WRAPPER_SPEC[K]['kind'];
    measurement: typeof WRAPPER_SPEC[K]['measurement'];
  };
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

The runtime twin uses the SAME `WRAPPER_SPEC` object. `kind` is
checked in addition to `measurement` because two rows with the same
measurement but different kinds — e.g. a hypothetical
`(motion, timestamp)` vs the `(unrecognized, timestamp)` branch —
must not both route to the same timestamp factory:

```typescript
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

Enforcement runs at TWO points, defense-in-depth. But routing the
diagnostic through the existing `EffectiveSensorMap.errors` channel
doesn't fit: `RowValidationError.overrideIndex` is required (frozen
in Group 1), and a wrapper mismatch caused by a bug in the built-in
default map has NO override to point at — inventing an index would
make the UI highlight an unrelated config entry the user didn't
write.

Solution — grow `EffectiveSensorMap` with a THIRD diagnostic
channel. `notes` is a MIXED channel distinguished by `source`: some
notes are genuinely attribution-free (`source: 'default-map'` —
internal invariants, plugin bugs, both-default collisions), while
others deliberately carry a real `overrideIndex`
(`source: 'override'` — the battery-ownership pass's
`duplicate-battery-owner` and `orphan-battery-field`, which point at
the fragment that lost the collision, disabled the owner, or rebound
its field). What unifies the channel is that entries are NOT row
rejections or field strips — they are ownership/health diagnostics —
and that `overrideIndex` is optional rather than required:

```typescript
export interface InternalInvariantNote {
  code: string;
  /** 'default-map' | 'override' — where the note originated. */
  source: 'default-map' | 'override';
  /** Only meaningful when source === 'override'. */
  overrideIndex?: number;
  dataPoint?: string;
  stationMac?: string;
  message: string;
}

export interface EffectiveSensorMap {
  rows: EffectiveSensorRow[];
  errors: RowValidationError[];       // config-attributable failures
  warnings: RowValidationWarning[];   // config-attributable warnings
  notes: InternalInvariantNote[];     // NEW — mixed diagnostics; attribution determined by `source`
}
```

Enforcement + routing:

- **`buildEffectiveSensorMap` — wrapper mismatch (default map)**:
  right after `wrapperId` is assigned to a row, the resolver calls
  `assertRowMatchesWrapperId`. On mismatch the row is dropped and a
  `wrapper-mismatch` note is pushed to `.notes` with
  `source: 'default-map'`. That's a plugin bug, not a user bug — the
  UI surfaces notes in a separate "plugin health" section and does
  NOT highlight any override row.

- **`buildEffectiveSensorMap` — wrapper mismatch (override)**: if a
  user override somehow produces a bad `wrapperId` (should be
  impossible if validation is correct — belt-and-suspenders), push a
  note with `source: 'override'` and the offending `overrideIndex`.
  The UI can attribute this one to a config entry.

- **`instantiateWrapper` — defense-in-depth**: same call runs at
  registration. If it throws (which it shouldn't if
  buildEffectiveSensorMap did its job), the caller in `platform.ts`
  catches the exception, logs an error naming the row, drops that
  wrapper from the routing map, and continues registering the rest.
  Startup does not crash.

- **`orphan-battery-field`** (from the battery-ownership pass):
  the user disabled a reserved canonical owner — or rebound it to a
  different batteryField, or both — while other enabled rows still
  reference the reserved field. Push a note with `source: 'override'`
  and the `overrideIndex` of the fragment that disabled the row (or,
  rebind-only, the fragment that authored the owner's new
  batteryField value, via the value-aware authorship table). The
  compound state names both causes and the FULL remedy (re-enable
  AND restore the field). If no override was involved (a plugin
  update disabled the row via defaults — hypothetical), fall back to
  `source: 'default-map'` with no index.

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
report 68°C).

Because a shipped SensorMapOverride schema that accepts a silently-
ineffective field is a footgun, Stage 2 also EXTENDS
`validateOverrideBody` to warn-and-strip `displayUnit` on rows
whose resolved wrapper is a native HAP wrapper (temperature,
humidity, illuminance, co2, pm25, pm10 kinds). The warning uses the
existing `RowValidationWarning` channel with code
`ignored-native-displayunit`; the field is removed from the
returned override before it reaches resolveRow, matching how
motion-only fields are handled today.

The same commit updates `docs/future/sensor-map.md` §3.5 and the
`SensorMapOverride.displayUnit` JSDoc to spell out the native-kind
carve-out: `displayUnit` is presentation-only for extended
motion-family kinds; on native kinds the field is warn-and-ignored.
That closes the loop with §3.7's "warn and ignore inapplicable
fields" philosophy — currently silent, contradicted a documented
promise, and would have shipped as a schema-frozen surprise.

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

An INTERIM subset of the effective-map ownership pass ships as part
of Group 4 (PR #20): custom rows with a novel `batteryField` now
get `hasBatterySubService: true` through a `resolveHasBatterySubService`
helper, `duplicate-battery-owner` warnings fire with real
`overrideIndex` attribution via a `batteryFieldProvenance`
side-table, and a startup invariant
(`assertCanonicalBatteryOwnersUnique`) guards the default map on
BOTH halves — no field with two canonical owners AND no referenced
field with zero canonical owner.

**PR #20 is not the final ownership contract.** The canonical-owner
invariant above is final (PR #20 ships both halves; Stage 2 keeps
it), but PR #20 still uses resolution iteration order (defaults ×
stations → discovery → station overrides → global custom) as its
custom-vs-custom tie-break, and routes warnings through the
RowValidationWarning channel. The Stage 2 replacement machinery,
described below in full, is a BEHAVIORAL CHANGE on top of PR #20:

- `earliestOverrideIndex` from `RowResolutionMeta` becomes the
  primary ordering, with `(stationMac, dataPoint)` lexicographic
  as the final tie-break — replacing the first-resolved rule.
- `duplicate-battery-owner` and `orphan-battery-field` route
  through `EffectiveSensorMap.notes` (`source: 'default-map' |
  'override'`) instead of the shipping RowValidationWarning
  channel — that channel keeps carrying config-attributable
  warnings; ownership/plugin-health diagnostics (attributed or
  attribution-free, per `source`) move to the new channel.
- Reserved-owner rows that are DISABLED or REBOUND away from their
  reserved field (or both) produce an `orphan-battery-field`
  info-level note when other enabled rows still reference the field
  (PR #20 leaves the field silently sub-serviceless).

Runtime-side work is additive to those effective-map changes:
wrappers consuming `row.batteryField` and `row.hasBatterySubService`,
the shared `resolveBatteryField(effectiveMap, mac, dp)` reader
plumbed through polling + realtime, and the
`setupBatteryService({ attach, initialLow })` contract change so
the HAP graph no longer depends on transient telemetry.

Full lifecycle spelled out below across four coordinated pieces
(each replaces or extends PR #20's interim implementation):

**1. Effective-map resolution.** Ownership is a two-tier rule that
preserves v1.6.0 behavior EXACTLY for unchanged default-map rows,
and introduces new logic for user-authored battery-field claims —
including both custom rows AND known rows whose `batteryField` was
overridden away from its default (see the "User claimants" bullet
for all three cases):

- **Reserved owner** — every AWN battery field is contractually
  owned by the default-map row with `canonicalForBattery: true`
  for that field (battout → tempf, batt_co2 → co2_in_aqin, and so
  on, per `DEFAULT_SENSOR_MAP`). Reservation is UNCONDITIONAL and
  static: `assertCanonicalBatteryOwnersUnique` at module load
  enforces that every distinct non-null default `batteryField` has
  EXACTLY ONE canonical owner — both no-more-than-one (two canonical
  owners is a bug) AND at-least-one (a field referenced by
  non-canonical rows with zero canonical owner is also a bug,
  since a runtime collision on those rows would have no honest
  fragment to attribute to). PR #20 ships BOTH halves; Stage 2
  preserves this invariant unchanged while it replaces the
  ordering and diagnostic machinery below. The "canonical" status
  applies only when the
  row's RESOLVED `batteryField` equals its `defaultRow.batteryField`
  — if the user overrides the field to a different value, the row
  loses canonical status for that field and enters the
  user-claimant path below (see next bullet). Non-canonical default
  rows that keep their default batteryField (intentional plugin-side
  sharing — most extended outdoor sensors reference their family's
  canonical field, e.g. `battout`) get `hasBatterySubService: false`
  without warning; the sharing is by design and users shouldn't see
  noise about it.

- **User claimants** — any row whose RESOLVED `batteryField` was
  authored or altered by a user override enters the claimant path.
  Three concrete cases, all handled the same way:

  1. A **custom row** (no `defaultRow`) with a novel `batteryField`.
  2. A **known row with an overridden `batteryField`** whose
     resolved value differs from `defaultRow.batteryField`. Example:
     `{ dataPoint: 'tempf', batteryField: 'my_barn_batt' }` — tempf
     loses canonical status because the resolved field ('my_barn_batt')
     doesn't match the default ('battout'), and enters claims like
     a custom row would.
  3. A **non-canonical known row whose `batteryField` was
     overridden away from its default value.** (Most non-canonical
     default rows DO carry a `batteryField` — they share their
     family's canonical field, e.g. every outdoor extended sensor
     references `battout`. The claimant case here is specifically
     when a user overrides that shared field to a different value,
     not the common shared-default state, which stays a reserved
     non-owner.)

  Eligibility is a STATIC test against `DEFAULT_SENSOR_MAP`: the
  claimant's resolved `batteryField` must NOT appear in the
  reserved set (any canonical default's `batteryField`). This
  protects users' muscle memory: `battout`, `batt_co2`, and every
  other reserved AWN field stays exclusively owned by its
  canonical default row. A claimant targeting a reserved field
  gets `hasBatterySubService: false` (the field is still read for
  battery-low display, just not attached).

  Making ownership depend on transient telemetry ("did this station
  report tempf this tick?") would let a signature flip the first
  time a field arrived; the static test rules that out.

  When two claimants target the same novel field on the same
  station, priority is `RowResolutionMeta.earliestOverrideIndex`
  (which fragment authored the batteryField first), with
  `(stationMac, dataPoint)` lexicographic order as the final
  tie-break. The `duplicate-battery-owner` warning surfaces naming
  the winner. Warnings fire ONLY on user-authored conflicts —
  never on default-map sharing.

- **Disabled or rebound owners** — disabled rows do not participate
  in ownership, and neither disabling the reserved canonical owner
  nor rebinding its batteryField to a novel value rolls ownership
  to the next default-map candidate (structural signatures would
  drift as users toggle state) or promotes a user row to owner —
  the reserved set statically blocks every other claimant. The
  battery field simply gets no HAP sub-service on that station
  until the owner is re-enabled and/or restored to the reserved
  field. `buildEffectiveSensorMap` emits an `orphan-battery-field`
  info-level note whenever an orphaning state exists while other
  enabled rows still reference the field — attributed to the
  disabling fragment, or (rebind-only) to the fragment that
  authored the new batteryField value; the compound
  disabled-and-rebound state names both causes and the full remedy.
  Ownership never rolling means no OTHER row's signature changes;
  the owner's own signature can change when its Battery sub-service
  is added or removed by the same edit.

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
That gate makes the HAP graph a function of transient telemetry —
a row whose structural signature says `battery:1` can end up with
NO Battery sub-service simply because AWN happened to omit the
field on the tick that ran discovery.

Two things move under the row model:

- **Gate decouples from telemetry.** Attach the sub-service iff
  `row.hasBatterySubService`. Structural ownership is a property
  of the effective map, not of any specific payload. Signature and
  service graph agree by construction.

- **Helper contract change.** `setupBatteryService` grows a new
  parameter shape:

  ```typescript
  setupBatteryService(platform, accessory, {
    attach: boolean,                            // = row.hasBatterySubService
    initialLow: boolean | 'unknown',            // seed value; see below
  });
  ```

  When `attach: true`, the sub-service is unconditionally attached
  and initialized to `initialLow`. The seed source, in order:

  1. `context.device.batteryLow` if defined (cached from prior boot);
  2. otherwise `'unknown'` — the helper writes HAP's
     `StatusLowBattery.NORMAL` (0) as a placeholder, matching the
     characteristic's default. Once the first real reading arrives,
     `setBatteryLow(low)` overrides it.

  `attach: false` means the sub-service is removed if present
  (accessory downgrade path) and not added if absent. This mirrors
  the existing removal path when the plugin decides a row no
  longer owns the field.

Stage 2's battery-family PR must include a test where the owned
`batteryField` is ABSENT from the first payload the platform hands
the wrapper: the sub-service still exists, `StatusLowBattery` reads
NORMAL initially, and the next tick's battery value flows through
`setBatteryLow` normally.

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

Stage 2's battery-family PR includes two integration tests, split
by which lifecycle stage each transport can actually exercise:

- **Polling / bootstrap test** — proves the *initial* seeding path.
  Seeds a custom row with `batteryField: 'my_barn_batt'`, runs the
  first REST discovery cycle with `my_barn_batt === 0` in the
  payload, and asserts:
  - `context.device.batteryLow` was populated by parseDevices
    BEFORE the constructor ran (so the Battery sub-service is
    attached on the first tick, not the second);
  - `wrapper.setBatteryLow(true)` fired.

- **Realtime test** — proves the *update* path only. `RealtimeSource`
  starts AFTER the initial REST discovery, so by the time its
  subscription callback fires the wrapper is already constructed
  and its sub-service already attached (or not) based on the
  polling seed. The realtime test therefore starts with a
  pre-constructed wrapper whose owner row's `batteryField` is
  `my_barn_batt`, delivers a realtime payload where
  `my_barn_batt === 0`, and asserts `setBatteryLow(true)` fired.
  This exercises the row-aware realtime reader without pretending
  realtime can seed a not-yet-existent wrapper.

The pre-first-payload "sub-service exists even when the field is
missing" test (from the setupBatteryService contract change above)
is a wrapper-unit test, not a transport-integration test — it
constructs the wrapper directly with `attach: true, initialLow:
'unknown'` and asserts the graph.

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
  for (const [dp, raw] of Object.entries(station.lastData)) {
    const key = `${station.macAddress.toUpperCase()}|${dp}`;
    const entry = routing.get(key);
    if (!entry) continue;
    const value = coerceValue(entry.row, raw);   // row-aware; see below
    if (value !== undefined) {
      entry.wrapper.setValue(value);
    }
  }
}
```

**`coerceValue(row, raw)`.** AWN's REST payload isn't uniformly
numeric: `lastRain` and any other `measurement: 'timestamp'` field
arrive as ISO-8601 strings (`"2026-04-21T22:19:00.000Z"`), while
`lightning_time` (a legacy motion-family field whose measurement is
`count`) arrives as a millisecond number even though its display
tells a temporal story. v1's `parseDevices` special-cases the ISO
form via `Date.parse` when the sensor is `LastRain`; the new
routing must preserve that.

The coercer dispatches on `row.measurement`:

- `'timestamp'` (`last-rain`, `lightning-last-strike`): if `raw` is
  a finite number, pass through. If `raw` is a string, `Date.parse`
  it; return the parsed ms on success and `undefined` on NaN (a
  malformed string logs at debug and drops that tick's value —
  matching v1's silent-skip behavior).
- `'boolean'` (reserved for future kinds; no current row uses it):
  coerce truthy/falsy per AWN's `0/1` semantics; wrapper receives
  a `0` or `1` number.
- everything else (numeric measurements): if `raw` is a finite
  number, pass through; otherwise return `undefined` (Stage 3's
  wrapper does NOT receive a string — the wrapper's `setValue`
  signature stays `number`).

Migration equivalence (Group 2 §13's harness) grows two new
regression cases: valid `lastRain` ISO string round-trips to a
finite `setValue(ms)`; invalid ISO string drops the tick without
throwing.

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

- **Stage 3 — Value routing MECHANISM (unit-tested only; NOT yet
  platform-wired).** Adds `coerceValue` and the `(mac, dp) → wrapper`
  routing functions (`buildWrapperRouting` / `distributeViaRouting`)
  and unit-tests them in isolation. **It does NOT wire routing into
  `platform.ts`** — there is no v2 construction branch yet
  (construction is always `createSensorWrapper`; shadow mode registers
  nothing), so the lifecycle boundary does not exist after Stage 3.
  The unit tests exercise the
  `station.lastData → routing map → coerceValue → wrapper.setValue`
  arithmetic directly (constructing an `EffectiveSensorRow` explicitly,
  bypassing buildEffectiveSensorMap), NOT the platform lifecycle.

  Do not restore the resolution table on the strength of Stage 3
  alone — the load-bearing platform connection is Stage 4's first
  commit (next).

- **Stage 4 — Wire the platform boundary, THEN restore
  `WRAPPER_FOR_KIND_AND_MEASUREMENT` + full-flow integration tests.**
  Only after Stages 1–3 all merge and go green in CI. Stage 4's FIRST
  commit wires routing into the flag-gated v2 construction/registration
  path in `platform.ts` and exercises it through the platform lifecycle
  (table still empty, known dataPoints only) — establishing the boundary
  the reviewer requires before any table entry comes back. THEN, in
  subsequent commits, restoration is ALL-OR-NOTHING: the entire 15-entry
  table comes back alongside:
  - `test_custom_<entry>` for all 15 entries, this time going
    through the full `config.sensorMap → buildEffectiveSensorMap →
    routing → wrapper` pipeline;
  - platform-integration test proving each custom row actually
    routes end-to-end from raw AWN payload to HAP characteristic
    value.
  - the battery-ownership ordering / orphan-note change and the shared
    polling/realtime `resolveBatteryField` reader (separate commits),
    plus the v1.7-downgrade-safety fixture — all land here where their
    full-flow behavior is testable.

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
- Two custom rows sharing a NOVEL `batteryField` on the same
  station: the row with the earliest `overrideIndex` (via
  `RowResolutionMeta`) gets `hasBatterySubService: true`; ties
  break on `(stationMac, dataPoint)` lexicographic order; the
  loser keeps `batteryField` for reading but `hasBatterySubService:
  false`; a `duplicate-battery-owner` warning surfaces naming the
  winner. Custom rows targeting a reserved default field
  (`battout`, `batt_co2`, ...) all get `hasBatterySubService: false`
  regardless of ordering — the reservation is unconditional.
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

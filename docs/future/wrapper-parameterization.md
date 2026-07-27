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

type NumericFactory = (
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  row: NumericSensorRow,
) => SensorAccessory;

type TimestampFactory = (
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  row: TimestampSensorRow,
) => SensorAccessory;

export type WrapperFactory = NumericFactory | TimestampFactory;

export const FACTORIES: Readonly<Record<WrapperId, WrapperFactory>> = {
  'temperature':           (p, a, r) => new TemperatureAccessory(p, a, r),
  'wind-speed':            (p, a, r) => new WindSpeedAccessory(p, a, r),
  'last-rain':             (p, a, r) => new LastRainAccessory(p, a, r),
  ...
};

export function instantiateWrapper(
  platform, accessory, row: EffectiveSensorRow,
): SensorAccessory {
  if (row.kind === 'unrecognized') { throw ... }  // guarded upstream
  const factory = FACTORIES[row.wrapperId];
  return factory(platform, accessory, row as never);  // narrowed by wrapperId
}
```

Type discipline: each factory's row parameter is the exact measurement
type the wrapper's `NumericSensorRow.measurement` union (or
`TimestampSensorRow`) narrows to. `air-quality-pm25` and
`air-quality-pm10` are the reason we need distinct `WrapperId`s that
share a class — the factory names the variant explicitly. The lookup
key IS the variant.

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

`ExtendedSensorOptions` grows both units:

```typescript
export interface ExtendedSensorOptions {
  sensorLabel: string;
  awnKey: string;
  threshold: number;
  triggerDirection?: 'above' | 'below';
  displayMode: ExtendedDisplayMode;
  sourceUnit: SensorUnit;      // <-- new
  displayUnit: SensorUnit;     // <-- new
}
```

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
AWN raw value (in row.sourceUnit)
  → wrapper.formatIntensity(canonical)  // needs canonical for scale-anchored buckets
  → wrapper.compareThreshold(canonical)  // threshold on the row is ALSO in canonical
  → wrapper.formatValue(canonical → row.displayUnit)  // user-facing string
  → HAP characteristic value (in the characteristic's fixed unit)
```

Two units-related invariants:

1. `row.threshold` is always in the family's canonical unit. Compat
   preserves this by not re-scaling legacy threshold values (they were
   already stored in canonical form under
   `platform.config.thresholds.windSpeedMph` etc.). Custom rows must
   supply thresholds in canonical too; validation rejects any
   `threshold` that isn't in the row's `sourceUnit`-vs-canonical
   compatibility set.

2. `row.sourceUnit` may be any legal unit for the row's measurement
   (per `LEGAL_UNITS_FOR_MEASUREMENT` in `units.ts`). The wrapper
   converts to canonical on receipt via a shared `toCanonical(measurement,
   sourceUnit, value)` helper that lives next to `LEGAL_UNITS_FOR_MEASUREMENT`;
   the identity case (sourceUnit === canonical) is a no-op. Non-identity
   cases: `celsius → fahrenheit` inside temperature is now moot because
   canonical is celsius; but `kph → mph` for a custom wind sensor
   reporting in kph is a real conversion at read time.

### Native wrappers are NOT the small case

The prior draft called native wrappers "smallest surface." That was
wrong. Every native wrapper hardcodes structural or unit choices:

- `TemperatureAccessory`: always converts `°F → °C` before writing
  the HAP characteristic. Under the row model, if `row.sourceUnit ===
  'celsius'` (custom sensor) the conversion is skipped.
- `SolarRadiationAccessory`: always converts `W/m² → lux` (via a
  hardcoded multiplier). Under the row model, if `row.sourceUnit ===
  'lux'` the conversion is skipped.
- `Co2Accessory`: fixed unit but a hardcoded 1000-ppm alert threshold;
  becomes `row.threshold` for custom sensors.
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

### Custom-row battery attachment

Current effective-map resolution sets `hasBatterySubService = batteryField !== null && (defaultRow?.canonicalForBattery ?? false)`.
For a custom row there is no `defaultRow`, so `hasBatterySubService`
is always `false` and `batteryField` might be truthy but is never
consumed. That means the current design's "custom row Battery
sub-service" is unreachable.

Change the resolver:

```typescript
// resolveBatteryField + resolveHasBatterySubService in buildEffectiveMap
if (isCustom) {
  const explicit = override?.batteryField ?? null;
  return {
    batteryField: explicit,
    hasBatterySubService: explicit !== null,   // custom row IS canonical for its own battery
  };
} else {
  // Existing known-row logic (default map's canonicalForBattery).
}
```

Collision (two rows on the same station sharing a batteryField): the
first row to resolve keeps `hasBatterySubService: true`; subsequent
rows keep `batteryField` for reading but get `hasBatterySubService:
false`. Order is default-map first (preserving v1 canonical
ownership), then user-declared rows in file order. `buildEffectiveSensorMap`
emits a `duplicate-battery-owner` warning on collisions.

`setupBatteryService` already reads
`accessory.context.device.batteryLow` and writes it through the HAP
BatteryService characteristic — no probe lookup involved. The
platform's parse pipeline is what fills
`accessory.context.device.batteryLow` from `stations[i].lastData[batteryField]`.
That path stays; parameterization only affects whether the wrapper
attaches the sub-service (`hasBatterySubService`) and which field the
platform reads (`row.batteryField`).

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

The previous draft had families landing before the platform passed
the row — that would break compilation (constructors gaining a
required argument that the call site doesn't supply). Reordered:

- **Stage 0 — Interim safety.** Empty `WRAPPER_FOR_KIND_AND_MEASUREMENT`
  entirely; every custom `(kind, measurement)` row fails
  buildEffectiveSensorMap validation. Adds a regression test proving
  the table is empty. Lands with the merge of this design doc.

- **Stage 1 — Factory registry + platform routing.** Adds the
  `FACTORIES` map (indexed by `WrapperId`) with entries for every
  wrapper. Adds the routing-map plumbing in platform. Existing
  wrapper constructors are UNCHANGED in this stage — the factory
  passes a `row` argument that the constructor accepts but
  DEFAULT-VALUES (via a shim that reads the same
  `platform.config.*` fields it always did if the row's field is
  undefined). This shim keeps every existing test and the v1.6.0
  code path green while giving the platform something to call with
  a row. No behavioral change. No table restoration.

- **Stage 2 — Native + extended family constructors, family by
  family.** Each family (temperature; humidity; solar; co2; air
  quality; wind; rain; pressure; UV; lightning) removes its
  `platform.config.*` fallbacks and reads exclusively from the row.
  Each family lands as its own PR with:
  - `test_custom_<family>` covering every measurement variant with
    non-default row values (name, threshold, sourceUnit, displayUnit,
    triggerDirection, triggerEnabled: false, embedName, batteryField).
  - HAP graph-parity fixture: default-row instantiation produces
    byte-identical services + characteristics + subtypes as the
    pre-refactor snapshot for every WrapperId in the family. This is
    what prevents constructor refactoring from silently changing the
    graph without a `structuralSignature` bump.
  - Fixture format: `{ serviceUuids: [...], characteristics:
    { <ServiceUuid>: [<CharUuid>, ...] }, subtypes: {...},
    initialValues: {...} }`, snapshotted once against main just
    before Stage 2 starts and asserted after each family's changes.
  - Zero table entries restored in this stage.

- **Stage 3 — Value routing goes live.** Platform's `distribute`
  routes via the `(mac, dp) → wrapper` map. Includes an integration
  test at the platform level that seeds a custom row, feeds an AWN
  payload containing its dataPoint, and asserts the wrapper's
  `setValue` was called with the expected number. This is where
  `test_custom_*`'s "reads from row.dataPoint" claim is actually
  validated — wrappers don't fetch, so the assertion has to sit at
  the platform layer.

- **Stage 4 — Restore `WRAPPER_FOR_KIND_AND_MEASUREMENT`.** Only
  after Stages 1–3 all merge and go green in CI. Restoration is
  ALL-OR-NOTHING: the entire table comes back in one PR alongside
  its `test_custom_<entry>` for all 15 entries plus a
  platform-integration test proving each custom row actually
  routes. No incremental restoration — the reviewer correctly
  flagged that as premature safety-defeat.

- **Stage 5 — Retire the Stage-1 shim.** With every family
  parameterized, remove the fallback-to-`platform.config` code paths
  the shim leaned on. This is the point where the
  `platform.config.thresholds.*` / `platform.config.units.*` fields
  become read-only inputs to compat — they still exist for legacy-
  config parsing but no wrapper reads them.

Task #65's flag-flip gate does not lift until Stage 5's PR merges
with `WRAPPER_FOR_KIND_AND_MEASUREMENT` fully populated and
`test_custom_*` + graph-parity + platform-integration all green.

## Testing

### Graph-parity fixtures (Stage 2 gate)

Before Stage 2 begins, snapshot the HAP service graph produced by
every WrapperId against a canonical default-row input. Format:

```typescript
interface GraphSnapshot {
  wrapperId: WrapperId;
  services: Array<{ uuid: string; subtype?: string; }>;
  characteristics: Record<string /* serviceUuid#subtype */, string[]>;
  initialValues: Record<string, number | string | boolean>;
}
```

Every Stage-2 family PR must produce a byte-identical snapshot
against its wrappers when instantiated with a row that matches
today's defaults. Any drift is a bug — either the refactor changed
the graph unintentionally, or the change was intentional and needs a
`schemaVersion` bump on the affected wrapper descriptor with a
migration note.

### `test_custom_*` per resolution-table entry (Stage 4 gate)

For each of the 15 entries in `WRAPPER_FOR_KIND_AND_MEASUREMENT`,
one test with a non-default row. The row varies:

- `dataPoint` to something outside the AWN vocabulary
  (`test_custom_<family>`);
- `name` to a distinctive string ("Barn Wind Speed");
- `threshold` to a non-default value in canonical units;
- `sourceUnit` to a non-default legal choice
  (`celsius` for temperature, `kph` for wind speed, `lux` for
  illuminance, `mm/hr` for rain rate, `hPa` for pressure, `km` for
  distance);
- `displayUnit` to yet a different legal choice, exercising a
  two-step conversion (sourceUnit → canonical → displayUnit);
- `triggerDirection` to `'below'` on a family that normally uses
  `'above'` and vice versa;
- `triggerEnabled: false` combined with a finite threshold to prove
  no motion event fires;
- `embedName: true` on non-motion kinds (must be stripped by
  validation before reaching the wrapper — negative test);
- `batteryField: 'my_barn_batt'` to prove custom battery attachment.

Assertions run at BOTH layers:
- wrapper-unit-test layer: `wrapper.setValue(rawSourceUnitValue)`
  produces the correct HAP characteristic value in the correct unit
  and the correct MotionDetected transition.
- platform-integration-test layer (Stage 3): with the custom row
  loaded into the effective map, an AWN payload containing the
  custom `dataPoint` reaches the wrapper's setValue.

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

Stage 0 lands with the merge of this design doc.

Stages 1–5 open in strict order (each stage's PR blocks its
successor). No user-visible change lands until Stage 4's resolution-
table restoration. Shadow mode continues to run over compat-generated
overrides — those target known dataPoints and always resolve via the
default map's direct wrapper reference, never through the resolution
table Stage 0 emptied.

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

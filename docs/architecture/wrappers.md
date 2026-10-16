# Wrapper and routing contracts

Wrappers translate resolved sensor rows and readings into HAP services. They do
not choose configuration scope or guess a custom field's meaning. See the
[sensor-map architecture](sensor-map.md) for resolution, catalog adoption,
canonicalization, and guarded saves.

## Construction and dispatch

`WRAPPER_SPEC` maps each stable wrapper ID to its kind and measurement.
`RowForWrapperId` and the factory table derive from that specification, keeping
compile-time and runtime dispatch checks aligned. `instantiateWrapper` checks
the row at the boundary before constructing its wrapper. Known fields may use
specialized variants; custom fields use the implemented pair mapping.

Existing wrappers accept an optional effective row. With a row they consume its
settings; without one they preserve legacy configuration behavior. New state
and generic wrappers require a row because they have no legacy construction
path. Wrappers never discard an effective row and then reread unrelated legacy
settings in its place.

The platform owns accessory registration and the routing map. Routing keys are
normalized station MAC plus data point, so custom fields receive readings in
the same way as built-in fields. A construction failure is isolated and logged
for that row rather than stopping the rest of the station.

## Unit conversion chain

`coerceValue` checks the input shape; it does not convert physical units. The
wrapper receives the reading in `row.sourceUnit`. Numeric wrappers convert both
that reading and the threshold to the measurement's canonical unit before
comparison. Native HAP values use their characteristic's fixed units. Extended
wrappers convert the canonical value to `displayUnit` only for presentation.

`units.ts` and `unitConversions.ts` are the unit authorities. Native temperature
is Celsius, illuminance is lux, and particulate density is µg/m³. Extended
thresholds remain authored in the source unit, not the chosen display unit.
Changing only a display unit therefore does not change a trigger condition.
Native display-unit overrides are warned about and stripped by validation.

The numeric `raw` carrier has identity conversion. A `unitLabel` is literal
text, not a conversion request or a claim that the quantity is dimensionless.

## Extended sensor surface

The extended shell uses a MotionSensor with custom Value and Last Updated
characteristics. Intensity is attached only when a wrapper implements a
meaningful formatter; generic numeric has none. Stock Home shows the motion
representation, while compatible controllers can display the additional value.

Thresholds are inclusive level conditions: above means at-or-above and below
means at-or-below. A first reading already beyond the threshold can be active.
Triggering is separate from enabled state. Missing or unusable numeric input
does not fabricate zero, refresh the timestamp, or clear a prior motion state.
Timestamps and direction are non-triggering measurements.

## Input and transport boundary

- Finite numbers pass for numeric measurements; numeric strings and other
  non-numeric values are dropped.
- Timestamps accept finite millisecond numbers or parseable date strings.
- Boolean measurements translate true/false to 1/0 and forward finite numbers.
  Other present values become an invalid-state marker, not a dropped observation.
- State wrappers decode exactly 0/1. Invalid present input faults and clears the
  alert; missing input retains the previous state and fault. Valid input clears
  the fault. Contact 1 means open, not closed.

Polling and realtime reach the same row-aware boundary. Reconstructed realtime
records have null prototypes, and battery readers require own properties.
The flag-off legacy path drops an entire non-numeric sensor update before both
value and battery callbacks.

## Custom-row battery attachment

The effective map adjudicates ownership before structural signatures are
computed. The original default map reserves each historical battery field for
its canonical row. Other default rows may reference that field without owning a
Battery subservice. Disabling or rebinding the reserved owner does not transfer
its reservation to another row.

Custom rows and rows rebound to non-reserved fields can claim a battery.
Competing claims on one station use earliest override order, then a stable
station/data-point tie-break. Only enabled rows participate. Collision losers
have no Battery subservice; a reference to a battery field is not ownership.
Catalog additions use this claims machinery without expanding the frozen
historical reservation set.

`resolveBatteryField` returns a row's field only when it owns a Battery
subservice. With an effective map, missing or suppressed ownership does not fall
back to legacy lookup. Without a map the legacy static lookup remains available.
Attachment follows resolved ownership, not whether a battery happened to report
on this tick. Unknown readings preserve retained characteristics rather than
overwriting a low state with healthy.

Battery polarity follows the active runtime and adopted support version, using
the same policy as the preview. The vendor correction for lightning and leak
batteries requires catalog 3. Flag-off and protective mode retain historical
decoding. See [battery polarity](sensor-map.md#196-battery-polarity).

## Internal invariant checks

An effective row must match the selected factory's kind and measurement.
Stable wrapper ID and schema version, not class names, enter the structural
signature alongside kind, measurement, and Battery-subservice presence.
Graph changes require a schema-version decision; a class rename does not.
Source units, display units, names, thresholds, and labels can change in place,
but still need correct resolution and preview consequences.

## Verification

Tests exercise factories, raw-to-wrapper value routing, source/display
conversions, inclusive triggering, boolean faults and recovery, battery ownership
and restart retention, and actual HAP graphs. Historical graph fixtures remain
frozen. New wrapper families have separate fixtures; changing an expected graph
must not erase evidence of an unintended legacy change.

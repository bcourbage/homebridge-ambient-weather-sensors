# Sensor-map architecture

This document describes the shipped sensor-map engine and its save boundary.
For operating instructions, see [the settings page](../plugin-ui.md),
[upgrading](../../UPGRADING.md), and [rollback](../../README.md#rollback).
The implementation is authoritative for field vocabularies and validation
codes. Section identifiers used by source comments remain stable.

## 1. Responsibilities

The engine resolves station fields into effective sensor rows. The platform
uses those rows to reconcile HomeKit accessories and route values. The editor
displays server-produced rows and consequences; it does not independently
reconstruct the effective map. Runtime discovery never rewrites config.json.

Input meaning, available output representations, and whether a row is enabled
are separate decisions. Recognition alone does not imply registration.

## 2. Code boundaries

- `src/sensorMap/defaultMap.ts` supplies built-in and shared legacy
  compatibility identities. `catalogVersion.ts` controls versioned visibility.
- `validation.ts` and `buildEffectiveMap.ts` validate and resolve authored layers.
- `wrappers.ts` and `wrapperFactories.ts` select and construct output wrappers.
- `canonicalizeSensorMap.ts` serializes authored intent without changing its
  effective meaning or erasing explicit identities.
- `homebridge-ui/handlers.ts` runs the authoritative preview and save pipeline.
  `saveOrchestrator.ts` coordinates that pipeline with Homebridge UI persistence.
- `catalog/awnCatalog.ts` and `catalog/capabilities.ts` are executable
  specifications checked by tests, not runtime recognition tables.

## 3. Row contract

### 3.1 Vocabulary

`types.ts` defines the closed `SensorKind`, `Measurement`, and `Unit` unions.
`units.ts` defines compatible kinds and units. A kind is not necessarily an
implemented output: the native `co` kind is reserved and has no wrapper.
The wrapper registry, not the presence of a type name, determines support.

### 3.2 Keys and identities

A row key is a normalized station MAC plus a case-sensitive AWN `dataPoint`.
An authored identity consists of kind, measurement, and the applicable source
unit. An accessory's structural identity is a different concept (§9): source
unit changes can alter readings without requiring a replacement accessory.

### 3.3 Authored layers

`sensorMap` is an array of fragments. A fragment without `stationMac` applies
globally to its data point; a station fragment overrides only that station.
Presence matters: explicit false, null, and an empty numeric label are not
equivalent to omission.

#### 3.3.1 Station scope

Station MACs use colon-separated hexadecimal octets and normalize to uppercase.
Global settings continue to apply to offline and subsequently discovered
stations. A station-scoped custom identity does not create an identity elsewhere.

#### 3.3.2 Merge order

Duplicate fragments merge field by field, with later authored values winning.
The resolver applies defaults, then the global layer, then the station layer.
Validation retains enough raw authorship to prevent a rejected identity from
silently becoming a guessed default in the same scope (§18.4).

### 3.4 Source units

`sourceUnit` describes the incoming reading. Wrappers convert readings and
thresholds from that unit through the same canonical-unit conversion. Timestamp
and boolean identities have fixed source policies. No unit is inferred from a
presentation label. See [unit conversion](wrappers.md#unit-conversion-chain).

### 3.5 Display units

Extended sensors use `displayUnit` for their custom text value. Native HAP
characteristics have fixed units, so inapplicable native display-unit overrides
are warned about and stripped. `unitVocabulary.ts` supplies source choices,
display choices, and family selectors, including the combined Rainfall control.
The generic `numeric` measurement uses only `raw`; its optional label does not
select a converter (§19.9).

### 3.6 Settings

Rows can carry enabled state, name, units, a battery-field override, and
motion-display/trigger settings. `threshold` is finite and expressed in the
source unit. `triggerEnabled: false` disables triggering independently of the
accessory's enabled state. Null battery fields suppress battery attachment.
Inapplicable fields are handled by validation rather than becoming silent knobs.

### 3.7 Validation

Malformed shapes and incompatible identities produce attributed diagnostics.
Historical built-in fields retain their fixed-meaning validation rules. Later
definitions distinguish inherited identity, a complete explicit identity, and a
partial invalid identity (§18.4). Public fragments cannot choose `wrapperId`.
Display-unit legality is checked against the identity actually resolved after
layering. Invalid rows refuse an editor save; warnings and ignored fields remain
visible in the preview. Unknown or withheld authored content must not be lost
through an editor reconstruction.

### 3.8 Representations

Temperature, humidity, light, CO₂, and particulate density use native services.
Weather quantities without a native representation use the extended motion
shell. Boolean leak, contact, occupancy, smoke, and motion use explicit state
decoders, not numeric threshold heuristics. Timestamp and direction measurements
do not offer threshold triggering. AQI is a numeric index, not an inferred health
category. The exact supported pairs and catalog gates are in `wrappers.ts`.

### 3.9 Wrapper descriptors

Stable wrapper IDs and schema versions describe HAP graphs independently of
TypeScript class names. Known fields can select a specialized wrapper; custom
assignments select the implemented kind/measurement pair. Factories check the
pair again at dispatch. See [wrapper contracts](wrappers.md).

## 4. Defaults and inventory

The row universe combines catalog definitions with reported, cached, and
authored fields. An enabled, recognized row still needs a supported wrapper and
a reported field before normal registration. The editor may therefore display
supported rows for which no accessory exists. Catalog enumeration is not a claim
that every displayed sensor is physically attached.

## 5. Modes, saving, and recovery records

The v2 runtime is on by default. Explicit opt-out retains the legacy path.
Legacy-shaped configurations use compatibility translation without an automatic
disk conversion. `configVersion: 2` selects authored sensor-map configuration.
Invalid configuration shapes or catalog stamps enter protective mode (§17.2).
Opting out alone is not a safe downgrade for a converted configuration.

The custom page owns the enabled Save action; Homebridge's native Save remains
disabled. The preview is the confirmation, not a separate confirmation modal.

1. `/preview-save` computes consequences without durable writes.
2. `/compose-save` repeats validation against disk and issues a validation token
   binding the validated input, proposal, form copy, consequences, output, and
   prospective recovery-record outcome. It does not write recovery records.
3. The client checks its frozen configuration copy before `/commit-save`.
4. `/commit-save` reruns the pipeline and verifies the token before writing any
   required snapshot or journal record. It then returns the persistable block.
5. The client passes that block verbatim to Homebridge UI's update/save APIs,
   reloads authoritative state, and checks the receipt.

Stale bases, stale confirmations, invalid rows, unsafe reconstruction, and
multiple plugin blocks refuse rather than selecting a convenient write target.
The full-map digest binds the normalized visible consequences, setting names,
and catalog transition. Observation timestamps are excluded. The settings-only
digest also binds the destination stamps, not merely the running binary version.
Proposed credential values are not exposed in preview DTOs or visible summaries.

The final Homebridge persistence call is not a filesystem compare-and-swap or a
cross-process configuration lock. The transaction's checks must not be described
as protection against every external writer racing after the commit response.
Uncertain persistence or failed recovery locks the editor until reload.

Connection-only saves, excluding station-filter changes, have a settings-only
path. A fresh block is born with the running catalog pair; an existing block's
stamps are preserved. A full sensor-map save or explicit conversion translates
legacy settings. Adoption is a separate operation.

### 5.1 Snapshot and journal

Before the first conversion is persisted, the server writes an immutable
`legacy-config-snapshot.json` containing only `LEGACY_SENSOR_FIELDS`. An existing
matching snapshot is reused. A different pre-conversion baseline is recorded in
`legacy-conversion-journal/entry-NNNNNN.json` before config persistence. Deduplication
compares the latest entry, not every historical baseline.

Entries use exclusive creation, with collision losers rereading and retrying.
This is cross-process safe: Homebridge UI can create separate server processes
for different clients. An in-process mutex is only a retry optimization. Existing
audit records are not replaced; corrupt or unexpected journal content fails
closed. Credentials never belong in snapshots or journal entries.

### 5.2 Legacy mirror and rollback limits

Saves also produce the legacy mirror and `_legacyMirror` verification marker.
Verification establishes synchronization, not lossless downgrade behavior.
The mirror cannot preserve every v2 identity or setting, including threshold
direction and trigger-enabled choices. Motion triggers can become active again.

Representability is per station. A mixed data point uses station-scoped
exclusions for unrepresentable rows; an all-custom data point may need a bare
exclusion so the legacy recognizer cannot misinterpret a future station's field.
Generic numeric assignments are not legacy-representable.

The [README rollback recipes](../../README.md#rollback) are the operational
authority. They distinguish verified current-state rollback, original snapshot
restoration, and journal-baseline restoration. Preserve a full v2 backup:
reconversion is not recovery of settings that the mirror could not represent.
Lowering catalog stamps is not a rollback procedure.

## 6. Compatibility conversion

`compat.ts` translates legacy toggles, filters, units, thresholds, names, and
other supported settings into granular fragments for the real identities in the
conversion universe. It does not retain an unbounded category or matcher rule.
Known temperature-family sensors disabled by the legacy category remain
disabled. A field first reported after conversion follows normal granular
resolution and may register; it can then be disabled individually (§21).

## 7. Resolution

Resolution validates fragments, determines each row's identity and inherited
settings, selects a supported wrapper, adjudicates battery ownership, and then
computes structural signatures. Station inventory and discovery establish which
keys can be considered, but cannot override explicit authored identity.
Equivalent inputs produce equivalent per-key decisions regardless of enumeration
order. The client consumes those decisions rather than reproducing them.

## 8. Persistence and inventory

### 8.1 Configuration ownership

Homebridge owns config.json. Runtime discovery reads it through the platform's
configuration; editor persistence goes through the guarded UI transaction. A
successful save takes runtime effect on restart, not by mutating live wrappers.

### 8.2 Plugin data

Stores live below Homebridge's plugin-data directory. Recovery records are audit
data; discovery, notices, and UI state have separate ownership and error policies.
Missing optional state starts empty. That is not evidence that a cache lookup
failed safely with an empty result: a failed cache read means unknown.

### 8.3 Discovery

`discoveryStore.ts` retains observed station fields and observation history.
An `everReported` true result can come from discovery or an existing accessory.
False requires observed station history plus a complete cache read confirming
absence. Without sufficient evidence the result is unknown, not false.

### 8.4 Notices

`noticesStore.ts` retains structural-change notices. Row-specific diagnostics
render with their rows; rowless notes and recent changes have separate displays.

### 8.5 UI state

The UI server writes `ui-state.json`; the platform reads it. A missing file is a
normal empty initial state. Viewer preferences such as hiding no-data rows use
fail-soft browser storage and do not change sensor configuration.

### 8.6 Atomic writes

`persistence/atomicWrite.ts` supplies the store write primitive. Immutable
snapshot and journal creation have additional exclusive-create and read-back
requirements (§5.1); ordinary replacement-store behavior is not an audit-record
overwrite policy.

### 8.7 Runtime consequences versus authoring universe

Validation, canonicalization, mirror construction, and divergence checks use the
unfiltered authoring universe. Runtime consequences use separate before/after
station-filtered row worlds. Excluding a station must not delete its authored
settings. Unknown station names make name-filter membership indeterminate and
refuse a consequential save; a MAC filter or completed discovery resolves it.
Crossing the single/multiple-station boundary also previews composed name changes.

## 9. Accessory reconciliation

The structural signature includes kind, measurement, battery-subservice presence,
stable wrapper ID, and wrapper schema version. Matching signatures allow in-place
updates. Changed signatures require unregister/register and may affect Home
rooms or automations. Names, source/display units, thresholds, and labels are
not structural, but their effective consequences still belong in the preview.

The consequence model is conservative for enabled rows that have never reported:
disabling one can appear as a structural removal even though no accessory exists
yet. The editor qualifies this case rather than promising a visible removal.

Battery ownership is decided before signatures. Reserved owners do not migrate
to another row just because a field was absent from one payload or its owner was
disabled. User-claimed non-reserved batteries have deterministic ownership.

### 9.4 Cache retention

Disabled supported rows are removed during ordinary reconciliation. Unsupported
or uncertain legacy cache identities can instead be retained without updates
until they can be resolved safely. Protective mode never reconciles (§17.2).
These are separate cases from a normal recognized row becoming disabled.

## 10. Build and UI boundary

The runtime and UI server are compiled TypeScript. The Angular editor uses DTOs,
not runtime engine imports, to obtain rows, vocabulary, diagnostics, and
consequences. Committed generated artifacts are part of the test and package
contract. Rebuild before tests that import compiled handlers; source and stale
dist are not interchangeable evidence. `verify:app` compares cold builds and
committed output. `verify:package` checks the production tarball in isolation.

## 11. Migration and canonical serialization

### 11.1 Frozen defaults

The original `DEFAULT_SENSOR_MAP` remains the historical fixed-meaning set and
battery reservation authority. Later catalog definitions live outside it.
Compatibility recognition shares the legacy matcher for its accepted families;
it is suppressed by scoped authored identity, including rejected identity.

### 11.2 Cache bootstrap

Legacy accessory contexts and HAP graphs provide conservative bootstrap
evidence. Inference uses the static catalog rather than guessing an arbitrary
custom identity from its field name. Positively v2-written measurement metadata
is trusted for v2 reconciliation, not for destructive compat-rollback removal.
Ambiguous legacy PM variants are resolved from their density characteristics.
Uninferable custom accessories are preserved rather than silently replaced.

### 11.3 Canonicalization

Canonicalization preserves scope and explicit identity provenance, not just
current values. An inherited catalog identity stays inherited; a complete
authored assignment stays authored even when its values equal the catalog.
Station settings are minimized against the canonical global output resolved
with that station's own minimal identity (§22.4). A station entry can be
absorbed only into an actually authored, identical global identity with no
remaining settings difference. Equal values from catalog defaults are not an
authored template. Explicit false, null, and cleared labels survive when needed.

## 12. Proof boundaries

Tests cover pure resolution, validation, canonical idempotency, DTOs, real
component behavior, compiled save handlers, and actual HAP lifecycles. Graph
fixtures check services, characteristics, properties, values, and names.
Historical graph goldens remain frozen; new representations get their own
fixtures rather than rewriting old evidence.

### 12.7 Migration and downgrade proofs

The corpus compares legacy and byte-real converted configurations at the HAP
graph level, then passes legacy cached accessories into converted boots to check
same-object reuse with zero churn. Published 1.7.3 is exercised against v2-written
caches for both freeze and documented rollback. The custom-row loss boundary is
asserted exactly. Explicit malformed-unit deviations are bounded, not an excuse
to loosen graph equality. Future-field exposure follows §21 rather than
speculative v1 category parity.

## 17. Operational invariants

### 17.2 Protective mode

Invalid/future catalog stamps and unsafe configuration shapes preserve cached
accessories with zero registrations or unregistrations. Bind-existing updates
are limited to confidently recognized baseline-native accessories; adopted,
custom, and extended identities can retain frozen values. The editor is
read-only with a diagnostic. A newer catalog-aware configuration is never
silently capped to an older catalog. Pre-catalog binaries do not implement this
stamp protection and must not be assumed to provide it.

### 17.3 Preserve-cached mode

When a legacy cached identity cannot be inferred safely, retain the accessory
and its last-known values rather than inventing a wrapper or deleting it.
This conservative per-accessory policy is distinct from whole-platform safe
mode and from ordinary v2 reconciliation of supported, disabled rows.

### 17.4 Stable serialization

Canonical entries sort by data point, global before station, then normalized
MAC. Fields use `FIELD_ORDER`. Canonicalization compares against the output
global layer, because that is what a reload will inherit. Byte-stable subsequent
saves and an effective-map divergence check guard this boundary.

## 18. Catalog and assignment preservation

### 18.1 Separate authorities

The executable AWN catalog records meaning, units, bounds, battery relationships,
evidence, and supported/gap dispositions. The capability specification records
the implemented kind/measurement-to-wrapper mappings. Runtime default tables and
pair registries implement those contracts, with coverage tests checking both
directions. Exposure is a per-row decision, not a second recognition heuristic.

### 18.2 Explicit identity

A later definition must not steal or erase an existing authored assignment,
including a value-equal one. Structural signatures alone cannot prove this:
source-unit changes can alter values without changing the HAP graph. Tests must
also check rendered readings and saved provenance.

### 18.3 Catalog stamps

`catalogBaseline` is the configuration's birth version and is preserved.
`catalogAdopted` is the newest explicitly adopted support version. Both absent
means the legacy pair `(1,1)`. Otherwise both must be positive integers with
baseline ≤ adopted ≤ the running catalog version. Partial, malformed, reversed,
or future pairs fail closed; none is capped or reset.

Definitions newer than adopted are unavailable as defaults. Newly exposed
definitions newer than baseline default to disabled when adopted; earlier
definitions use their own defaults. Catalog entries that anchor existing
compatibility recognition retain that compatibility behavior. Fresh blocks are
born at the current pair; pure conversion preserves an existing valid pair or
initializes a fully unstamped legacy block to `(1,1)`. No per-observed-station
stamp or speculative disable fragment is needed.

### 18.4 Validation and preservation rules

- **AP-1:** Later catalog definitions do not take authority over explicit identities.
- **AP-2:** The historical fixed-meaning clamp stays limited to the original
  static set. Later definitions supply inherited identity when no identity is
  authored. Complete authored identity uses custom validation. Partial identity
  is diagnosed and blocks the definition's default in that scope: global for a
  global fragment, one station for a station fragment. Station validation also
  accounts for applicable global identity authorship.
- **AP-3:** Per-key decisions derive from configuration and stamps, not cache
  presence or discovery ordering. Inventories can change the row universe, not
  the identity of a key present in both resolutions.
- **AP-4:** Preservation tests include value discriminators, canonical reload,
  provenance, and same-object cached lifecycles, not only signature comparisons.
- **AP-5:** Existing fallback-recognized behavior is grandfathered. Catalog
  growth alone does not change the identity of a compatibility-recognized field.
  Retirement of that fallback would require a separate compatibility design.

## 19. State and numeric capabilities

### 19.1 State decoding

Boolean inputs accept booleans and finite numbers. State wrappers interpret
exactly 0 and 1; every other present value faults and clears the alert. A missing
field retains state and fault. Valid input clears a retained fault. Contact 0 is
closed and 1 is open; leak, occupancy, smoke, and motion use 1 as active.
Both transports reach the same coercion boundary. Realtime reconstruction uses
null-prototype records, and battery reads require own properties. The legacy
transport still drops the entire non-numeric update, including battery effects.

### 19.2 Pair availability

Pairs have a required catalog version. Dormant assignments remain unavailable
until adoption; an adoption that enables an authored row previews its
registration. Five boolean pairs arrived with catalog 3, generic numeric with 4.

### 19.3 Native CO

The native CO kind remains reserved without a wrapper. The plugin does not
invent a CO alarm from a concentration threshold. A custom numeric reading is
not a certified detector or a `CarbonMonoxideDetected` representation.

### 19.4 Extended quantities

Soil moisture and leaf wetness use percent; soil tension uses centibar;
evapotranspiration supports inches/day and millimeters/day. AQI remains a plain
index because the firmware's index standard is not established. These use
extended value/threshold representations, not fabricated native categories.

### 19.5 Definitions and gaps

Catalog 3 adds declared soil, leaf, leak, evapotranspiration, and AQI fields as
disabled defaults. Soil battery associations stop at the four declared channels.
No battery association is invented for derived quantities. `gdd` remains a gap
because its declared unit is unresolved; relay control is unsupported and
`batt_25` remains unbound. The executable catalog records the exact key ranges.

### 19.6 Battery polarity

At adopted catalog 3 or later, the active v2 runtime decodes `batt_lightning`
and `batleak1..4` with the vendor's inverted convention. The same
`batteryDecoderPolicy` drives preview and runtime, including legacy-shaped
configurations using the v2 compat pipeline. Flag-off and protective modes keep
the historical decoder. Adoption previews and digest-binds polarity changes.
Unknown readings retain existing battery state; invalid input must not reseed
healthy over low. Meteobridge variants are recorded, not guessed at runtime.

### 19.9 Generic numeric

`motion|numeric` is authored-only and requires catalog 4. Its sole unit is the
opaque carrier `raw`, whose conversion is the identity. `unitLabel` is optional
presentation text, excluded from structural identity but included in resolution,
canonical serialization, DTOs, and confirmation consequences.

The label is trimmed and limited to 16 Unicode code points. Controls, Unicode
bidi controls, and line/paragraph separators are rejected. Omission inherits;
explicit empty clears; nonempty text labels the value. A numeric global label
cannot contaminate a station with a different resolved measurement.

Only finite numeric readings update Value and Last Updated. There is no
Intensity characteristic, forced precision, or label-driven conversion. Optional
thresholds are inclusive level conditions (`>=` or `<=`), not crossing detectors.
A dropped tick does not refresh the timestamp, clear motion, or become zero.

## 20. Capability-aware editor

`/vocabulary` negotiates protocol 2 to expose implemented pairs with their
required versions and source policies. No marker returns the legacy choices;
unknown protocols refuse. The client rejects incompatible responses. This
protects stale cached browser bundles after an in-place package upgrade, notably
against selecting Contact but dispatching the first boolean pair, Leak.

The picker selects pairs, never infers kind from measurement. Gated choices stay
visible but disabled. Assignment and adoption are separate operations. Conversion
omits a proposal to request server translation; adoption sends the faithfully
reconstructed authored map and target version. Both require clean drafts and
lock editing until saved or cancelled. Current no-wrapper diagnostics alone do
not prohibit adopting an otherwise valid dormant assignment.

The preview renders configuration transitions, disabled-row changes, accessory
changes, and battery polarity. The no-op message checks all these categories.
Settings-only creation has no full-map transition display. Numeric labels retain
the absence/empty/literal distinction through the editor. No-data filtering keeps
dirty, expanded, and noted rows visible, including global family drafts.

## 21. Pure sensor identities and upgrade proofs

V2 has no category-off or matcher exposure rule. Conversion materializes real
identities from catalog, reported/cached fields, and applicable authored input;
it does not create phantom rows from speculative exclusions. Known disabled
categories become disabled rows. A previously unseen field that later reports
can register under normal granular rules and can be disabled per accessory.

Install and upgrade proofs cover first-time settings creation, published 1.7.3,
earlier betas, converted configurations, custom assignments, adoption, and
documented rollback. Package installation alone does not rewrite configuration.
Production-package verification is distinct from running tests in a development
checkout, and bridge logs do not prove phone-side Apple Home responsiveness.

## 22. Change interpretation

Only recognized, saved custom rows with faithfully reconstructable authored
state are eligible. The operation keeps data point and scope fixed, requires
clean drafts, and uses the existing guarded preview/save path without per-row
Skip. Built-in rows and diagnosed assignments are not implicit remapping targets.

Changing pair or source unit clears the threshold without converting it. A
triggering target with no threshold explicitly disables triggering; recovery
requires an intentional finite threshold. Pair changes can replace accessories;
source-unit-only changes remain in place but alter readings. Cancellation is
read-only, disabled during persistence, and restores focus to the row's Edit
button. Repeated Save cannot start a second transaction.

### 22.4 Canonical station baseline

Custom station exceptions are compared with the canonical global output resolved
using their own minimal identity. A global humidity row's default false trigger
must not erase a station motion row's explicit false. Absorption additionally
requires exact kind, measurement, and source-unit agreement with an authored
global identity. Tests pin both retained settings and distinct-identity
preservation, including byte-stable reloads and subsequent saves.

# Changelog

All notable changes to `@bcourbage/homebridge-ambient-weather-sensors` are
documented here. The format is loosely based on [Keep a Changelog][kac];
versions follow [Semantic Versioning][semver]. This file is read by
`homebridge-config-ui-x` to show "What's new" notes after an update — keep
entries short and user-facing.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/

## [1.5.0-beta.13] — 2026-06-11

Acts on solmssen's beta.12 feedback. Becomes the new GA candidate.

### Changed

- **One Battery sub-service per physical probe, not one per
  accessory.** Previously every sensor whose probe reported a
  battery field got its own HomeKit Battery sub-service — a fully
  populated WS-2000 with 4 channels + AQIN + WH31L produced 30+
  battery tiles, which solmssen reasonably called "overwhelming."
  Each `batt*` field now attaches to exactly ONE canonical sensor:
    - `battout` → Outdoor Temperature
    - `battin` → Indoor Temperature
    - `batt1..10` → channel temperature for that channel
    - `batt_co2` → CO2 (AQIN)
    - `batt_lightning` → Lightning Strikes Today
  A typical fully-populated station now shows ~7 battery tiles
  instead of 30+, while still surfacing every physical probe's
  battery state to Apple Home automations.
  On upgrade, stale Battery sub-services attached to non-canonical
  accessories by beta.1 → beta.12 are removed automatically on the
  next plugin restart.

- **Renamed "WH57" → "WH31L" across docs and code comments.** AWN
  catalogs the lightning sensor as the WH31L; Ecowitt catalogs the
  same hardware as the WH57. Since this plugin is specifically for
  AWN users, use AWN's name as primary with the Ecowitt name as a
  cross-reference. Affects README, UPGRADING, schema helpvalue,
  and two code-comment files. CHANGELOG entries from prior betas
  retain the old "WH57" name as historical record.

### Added

- **FAQ entry documenting the AWN lightning-battery API quirk.**
  AWN's API has been observed to report `batt_lightning = 0`
  (which the plugin reads as "low") even when the WH31L has
  known-good batteries and AWN's own dashboard shows the sensor as
  healthy. The plugin reads what AWN's API returns; the
  discrepancy is upstream. UPGRADING's Troubleshooting / FAQ
  section now documents this so users hitting the same problem
  don't burn batteries trying to fix it. README also adds a short
  note in the Battery status section.

## [1.5.0-beta.12] — 2026-06-10

Branding + assets refresh. No code or behavior changes.

### Changed

- **New plugin icon** (`images/icon.png`). House outline with weather
  data flowing through plus a small sensor dot. Transparent
  background; pngquant-optimized to 72 KB. Replaces the four
  inherited upstream variants (`homebridge_ambient_weather*.png`).
- **Display name shortened** from "Homebridge Ambient Weather
  Sensors (bcourbage fork)" to **"Ambient Weather"**. Matches the
  Homebridge convention used by other plugins (Eve, Tado, Honeywell,
  UniFi Protect, etc.) of stripping "Homebridge" and generic suffix
  words. The npm scope `@bcourbage/...` continues to disambiguate
  from upstream.
- **README image URL switched to a relative path** (`images/icon.png`)
  so the icon renders correctly on GitHub branch views, npmjs.com,
  and local Markdown previews without depending on which branch the
  image happens to be on.

### Added

- **Trademark notice** in the README acknowledging "Ambient Weather"
  is a trademark of Ambient Weather, Inc. and that this plugin is an
  independent, unofficial integration (nominative fair use). Standard
  defensive practice for unofficial integration plugins.

## [1.5.0-beta.11] — 2026-06-09

Config-form-only patch — no code or behavior changes.

### Changed

- **extendedSensors master-toggle description** moved into a
  `<help>` block in the form array. This was the one I missed in
  beta.10's "move all field descriptions" pass — it was the master
  toggle description ("Adds wind, rain, barometric pressure...")
  that still rendered at the smaller schema-description font.
  Programmatically confirmed afterwards that no non-array property
  in the schema retains a `description` field: all explanatory
  text lives in form-array `<help>` blocks.

## [1.5.0-beta.10] — 2026-06-09

Config-form-only patch — no code or behavior changes. Completes the
font-size unification.

### Changed

- **All remaining field-level help text now renders in the larger
  helpvalue font.** Beta.9 caught the units + dataSource holdouts;
  beta.10 catches the rest: name, apiKey, applicationKey, co2Sensors,
  airQualitySensors, lightningSensors (WH57 caveat), and the
  multi-paragraph extendedDisplayMode walkthrough. All seven were
  schema-level descriptions rendering at the small caption size —
  now migrated to explicit `<help>` items in the form array,
  matching every other description in the form.

  The schema is now description-free for individual properties
  (other than the two array-typed fields where HB UI X auto-renders
  descriptions at the larger size anyway). All explanatory prose
  lives in the form array as `<help>` blocks.

## [1.5.0-beta.9] — 2026-06-09

Config-form-only patch — no code or behavior changes.

### Changed

- **Unit-field and Data Source descriptions render in the larger
  helpvalue font** instead of the smaller schema-description font.
  Beta.8 missed these on the cleanup pass — the per-unit "Selecting
  None uses the default (...)" notes and the Data Source polling vs
  realtime explanation were still using schema-level `description`,
  which HB UI X renders smaller than `helpvalue` blocks.

  Fix: removed the per-unit "Selecting None" lines entirely (the
  units section preamble already covers None behavior), and moved
  the Data Source description into a `<help>` block in the form
  array.

## [1.5.0-beta.8] — 2026-06-09

This release replaces the unreachable "blank threshold = hidden"
mechanic from beta.6 with explicit per-threshold enable checkboxes,
and unifies all extended-sensor help text to render at the larger
font size used elsewhere in the form. Becomes the new GA candidate.

### Changed

- **Per-threshold enable checkbox.** Each of the 6 user-configurable
  thresholds (controlling 8 accessories — wind speed, wind gust pair,
  rain rate, UV, lightning distance, pressure pair) now has a paired
  enable checkbox in the **Motion thresholds for extended sensors**
  section. When the checkbox is unchecked, the corresponding sensor
  accessory is hidden from HomeKit entirely and the threshold field
  is hidden from the form. Default is ON (checked) for all six, so
  upgrading from beta.6 → beta.8 produces no behavior change for
  users who hadn't tried to use the blank-threshold mechanic.

  This works around homebridge-config-ui-x re-injecting schema
  default values into number fields after save — the beta.6 "leave
  blank to hide" approach was non-functional because the form never
  let "blank" persist.

  Workaround for "show value without trigger" unchanged: keep the
  checkbox enabled, set the threshold to an unreachable value
  (99999 mph for wind, 99 for UV, 0 for inverted-direction pressure
  and lightning-distance sensors).

- **Consistent font sizes for help text.** Per-threshold descriptions
  ("Fires when sustained wind speed equals or exceeds this...") and
  the units section preamble now render in the larger `helpvalue`
  font instead of the smaller per-field-description font. Achieved
  by moving the descriptions out of the schema's individual
  property descriptions and into explicit `<help>` items in the
  form array. Matches the larger size that section preambles
  (Motion thresholds / Display units / Exclude Sensors / Include
  Only) already used.

### Implementation

- `config.schema.json` adds six new booleans inside the `thresholds`
  object: `windSpeedEnabled`, `windGustEnabled`, `rainRateEnabled`,
  `uvEnabled`, `lightningDistanceEnabled`, `pressureEnabled`. All
  default `true`. Each threshold value field has a
  `condition.functionBody` that hides it when its enable peer is
  explicitly false.
- `platform.ts#determineSensorType` checks each `*Enabled` flag and
  returns `NOT_SUPPORTED` when false, replacing the previous
  blank-threshold check. Default-true semantics: only an explicit
  `false` disables.
- Form array restructured: per-threshold sections now interleave
  enable checkbox → threshold field → help paragraph (all three
  hidden when the enable is unchecked).

## [1.5.0-beta.7] — 2026-06-09

Config-form-only fix. No code or behavior changes.

### Fixed

- **Exclude Sensors and Include Only These Sensors lists rendered
  with no input fields** in homebridge-config-ui-x. The custom
  `form` array added in beta.3 referenced these array-typed fields
  by string only; angular-schema-form's custom-layout mode requires
  an explicit `items` template to render the array's "Add" button
  and per-entry input row. Without it, only the title and
  description appeared — users couldn't add or edit allowlist /
  blocklist entries through the form (though the underlying
  config was still readable if edited by hand).

  Fix: replaced the bare string references in the form array with
  explicit array form objects containing `items: [{ key, type,
  placeholder }]` so the rendering re-finds its way to the
  per-entry input.

  Pre-existing entries are preserved — this is a render-side bug
  only; the schema and saved config were always intact.

## [1.5.0-beta.6] — 2026-06-09

This release refines the "blank threshold" semantics to match the
natural user intuition. Becomes the new GA candidate (supersedes
beta.5).

### Changed (behavior change for any user who set thresholds in beta.5)

- **Blank threshold field now hides the accessory from HomeKit
  entirely** instead of showing it with a permanently-false motion
  state. The previous behavior (introduced in beta.2) made it easy
  to disable a trigger but cluttered Apple Home with useless always-off
  tiles. The new behavior is what most users actually want when they
  blank a threshold: "I don't care about this sensor, please remove it."

  Affects the 6 user-configurable thresholds (8 accessories total):

  | Threshold | Sensors hidden when blank |
  |---|---|
  | `windSpeedMph` | Wind Speed |
  | `windGustMph` | Wind Gust, Max Daily Gust |
  | `rainRateInHr` | Rain Rate |
  | `uv` | UV Index |
  | `lightningDistanceMi` | Lightning Distance |
  | `pressureInHg` | Pressure Sea Level, Pressure Station |

  Sensors without a user-configurable threshold (wind direction +
  10-min avg, rain accumulation totals, time-since-event sensors,
  lightning strike counts) continue to appear when their category
  toggle is on — use `excludeSensors` to hide them individually.

  **Workaround for "show the value but don't trigger automations":**
  set the threshold to a value the sensor can never reach (e.g.
  `99999` for wind/rain, `99` for UV, `0` for the inverted-direction
  pressure and lightning-distance sensors since both are always
  positive). Schema and UPGRADING.md document this.

## [1.5.0-beta.5] — 2026-06-09

This release fixes a latent runtime bug that affected every Extended
Sensor accessory. Becomes the new GA candidate (supersedes beta.4
which had the same bug from beta.0).

### Fixed

- **"Cannot read properties of undefined (reading 'updateValue')"
  error when adding any Extended Sensor accessory.** ExtendedSensorBase
  called `service.updateCharacteristic(UUID_STRING, value)` to update
  the custom Value / Intensity / Last Updated characteristics on every
  poll tick. HAP-NodeJS's `Service#getCharacteristic(string)` overload
  matches by `displayName` only — *not* by UUID. Since our
  characteristics have displayNames like "Value" and "Last Updated"
  (not their UUIDs), the lookup returned undefined and then the
  internal `.updateValue()` call threw.

  Only manifested on Extended Sensors (wind / rain / pressure / UV /
  lightning) — native HAP services use the constructor-form lookup,
  which works correctly. The bug was latent from beta.0 because none
  of the betas were tested with an Extended Sensor enabled until now.

  Fix: cache the Characteristic instances at construction time (via
  the new `attachCustomCharacteristic` helper) and call
  `.updateValue()` directly on the cached refs, bypassing the
  string-lookup path entirely. The MotionDetected characteristic
  continues to use the standard service helper since
  constructor-form lookup works for stock HAP characteristics.

## [1.5.0-beta.4] — 2026-06-09

Housekeeping release — no code or behavior changes. This is the
release intended to roll forward to v1.5.0 GA once beta testing
completes; solmssen and other testers should validate this exact
build.

### Changed

- **Repo self-containment.** README header image URL switched from
  `raw.githubusercontent.com/peledies/...` to `.../bcourbage/...`
  Previously the README depended on upstream's repo staying online
  for its header image; now we serve our own copy from `images/`.
- **UPGRADING.md label parity.** The closing sentence of the "Pick
  a display mode" section used informal shorthand ("generic names"
  / "embed mode") instead of the actual dropdown labels. Updated
  to quote the labels verbatim so users skimming the doc can find
  the exact strings in the settings form.

### Removed (upstream-template vestiges)

- `README_DEV.md` — Generic "how to develop a Homebridge plugin"
  boilerplate inherited from the upstream template. Nothing
  project-specific; nothing else referenced it.
- `nodemon.json` + the `watch` npm script + the `nodemon`
  devDependency — Auto-restart dev loop that this project's
  edit-on-Heracles → push → CI workflow never used. Drops 18
  transitive packages from `npm install`.
- `.vscode/settings.json` `workbench.colorCustomizations` block —
  Upstream maintainer's personal terminal/title-bar colors. Kept
  the universally-useful editor settings (LF line endings,
  ESLint-on-save, 140-char ruler).
- `.DS_Store` — macOS Finder cache cleanup. Already in
  `.gitignore`; was never tracked.

## [1.5.0-beta.3] — 2026-06-09

Config-form-only release — no code or behavior changes. All fixes are
to how the settings form renders in homebridge-config-ui-x.

### Changed

- **Display-mode picker is a dropdown again.** Reverted from the
  radio-button widget tried in beta.2 — angular-schema-form's radio
  rendering left the unselected option indented and misaligned in
  HB UI X, which looked worse than the dropdown's "None" placeholder.
- **Description text now uses HTML line breaks.** Previously
  paragraph breaks in the extendedDisplayMode description were
  written as `\n\n` and rendered as a single run-on block. They're
  now `<br><br>` and render as actual paragraphs, matching the
  intended structure (generic-names paragraph / live-value paragraph
  / rename-and-log-note paragraph).
- **"Motion thresholds" and "Display units" section help text now
  appears at the top of each section** — directly under the section
  title rather than after all the fields. Achieved via a top-level
  `form` array with explicit `fieldset` blocks and `helpvalue`
  items so layout is deterministic instead of inferred from the
  schema.
- **Dropdown "None" placeholder documented.** Every `oneOf`
  dropdown (extendedDisplayMode, units.*, dataSource) now ends its
  description with "Selecting None uses the default (...)" so users
  who see the placeholder understand it's safe — picking None is
  equivalent to picking the default.

## [1.5.0-beta.2] — 2026-06-09

### Fixed

- **Plugin-name warning in Homebridge logs.** Every newly-registered
  accessory was logging *"A platform configured a new accessory under
  the plugin name 'homebridge-ambient-weather-sensors'. However no
  loaded plugin could be found for the name!"* The `PLUGIN_NAME`
  constant was inherited unchanged from upstream and pointed at the
  unscoped npm name. v1.5.0-beta.2 fixes it to match the scoped
  package name. On first restart Homebridge auto-migrates any
  cached accessories under the old name (one-time
  "Plugin association is now being transformed!" log line per
  accessory), then the warnings stop permanently. Latent bug since
  the v1.4.0 fork; surfaced by the new accessories in beta.0.

### Changed

- **Realtime reconnect logs are quiet during healthy operation.**
  AWN cycles long-lived websockets every 45m-3h as part of normal
  server-side grooming. Previously every cycle emitted 5 info-level
  log lines (~40/day on a healthy box). Now: clean disconnects
  (`transport close`, `ping timeout`, `io server disconnect`) and
  their follow-on reconnect cycle log at **debug** instead. Real
  anomalies (transport errors, connect errors, stalled subscriptions)
  still surface at warn/error. The first connect of a session always
  logs at info so users see realtime start. Net effect: typical day's
  log goes from ~40 reconnect lines to 0.
- **Threshold help text consolidation.** The "Motion thresholds for
  extended sensors" section header now covers the "blank = disabled"
  behavior in one place. Per-field descriptions are back to just
  describing each threshold and its default; no more repeated "Leave
  blank to disable..." line per field.

### Added

- **Blank threshold field disables the motion trigger entirely.**
  Previously a cleared threshold silently fell back to the schema
  default — same trigger, just at the default value. Now: clearing
  a field means no automation trigger at all (`MotionDetected`
  stays permanently false), but the accessory still exists so the
  reading remains visible in Eve / Controller for HomeKit. Useful
  for users who want to see a value without it driving automations.
  Applies to all 6 configurable thresholds (wind speed, wind gust,
  rain rate, UV, lightning distance, low pressure). Schema defaults
  unchanged — first-install behavior is identical to beta.1.

### Documented

- **`UPGRADING.md`** — full step-by-step upgrade guide from v1.4.x.
  Covers what appears automatically (battery sub-service, feels-like,
  dew point), how to opt into the Extended Sensors and pick a display
  mode, threshold tuning, example automations (close awning, skip
  sprinkler, lightning alert, low-battery reminder), the battery
  coverage table, and a troubleshooting / FAQ section.
- README adds a "What's New in v1.5.0" callout near the top pointing
  to UPGRADING.md.
- `excludeSensors` and `includeOnly` descriptions explicitly call out
  that they work on Extended Sensors too, with friendly-name and
  raw-AWN-field examples for both natives and extended.
- Display-mode dropdown switched to radio buttons (no spurious "None"
  option), and the description text uses the actual radio labels
  ("Show generic names" / "Show live value") rather than invented
  "Static mode" / "Embed mode" terms.
- Corrected wording about user-renamed tiles: the plugin already
  detects renames via `isUserRenamed()` and stops overwriting; the
  earlier "plugin will overwrite your custom name" copy was wrong.

## [1.5.0-beta.1] — 2026-06-09

### Added — Battery sub-service for low-battery automations

Every sensor accessory whose physical probe reports a battery in
AWN's payload now exposes a HomeKit `Battery` sub-service. Apple
Home and every third-party HomeKit client trigger their built-in
low-battery push notifications off this. The user-facing automation
*"When Outdoor Temperature battery is low, remind me to replace
it"* now works without any third-party app.

Per-probe coverage (driven by AWN's `batt*` fields):

| Probe | AWN field | Sensors affected |
|---|---|---|
| Outdoor base | `battout` | Outdoor temp/humidity, feels-like, dew point, solar, UV, wind, rain |
| Indoor display | `battin` | Indoor temp/humidity, feels-like, dew point, both pressures |
| WH31 probe 1..N | `batt1`..`battN` | Temp/humidity/feels-like/dew-point per channel |
| AQIN module | `batt_co2` | CO2, PM2.5, PM10, AQIN-housing temp/humidity |
| WH57 lightning | `batt_lightning` | Strike count, distance, time-since-last |

Probes that AWN doesn't report a battery for (e.g. outdoor PM2.5 on
some firmwares) get no Battery sub-service — better than showing a
misleading "battery normal" reading we can't actually confirm.

### Implementation notes

- `src/batteryFields.ts` maps each AWN sensor key to its battery
  field name (a 35-entry table + numbered-probe regex + AQIN suffix
  rule). Inverts AWN's 0=low/1=good polarity to HomeKit's
  true=low/false=normal at the data-source boundary.
- `src/batteryService.ts` exports a single `setupBatteryService`
  helper that the existing 5 native accessory classes and the
  ExtendedSensorBase all call from their constructor. Returns a
  setter callback or undefined; clean polymorphic shape.
- `DEVICE` type gains an optional `batteryLow?: boolean` field;
  presence on the cached accessory context drives whether to attach
  the sub-service after a Homebridge restart.
- `SensorAccessory` interface gains an optional `setBatteryLow`
  method. The distribute loop pushes both `setValue` and
  `setBatteryLow` per tick.
- Realtime path: `RealtimeUpdate` gains `batteryLow?: boolean`;
  realtimeSource looks up each sensor's battery field from the same
  lastData payload it's iterating, so realtime users see the same
  battery updates as polling users.
- HomeKit Battery service requires three characteristics; we set
  `ChargingState=NOT_CHARGEABLE` (correct — these are battery-only
  sensors), `BatteryLevel=5 or 100` (sentinel since AWN reports
  only low/good, not a percentage), and `StatusLowBattery`
  (the one that drives Apple Home's notifications).

## [1.5.0-beta.0] — 2026-06-09

First beta of v1.5.0. **Not the `latest` npm tag — install with
`npm install -g @bcourbage/homebridge-ambient-weather-sensors@beta` to
opt in.** Users on the `latest` tag stay on v1.4.x until v1.5.0 GA.

### Added — Extended Sensors (off by default)

Apple Home doesn't natively support wind, rain, barometric pressure,
UV, or lightning. v1.5.0 exposes them via the same pattern the
verified [homebridge-ecowitt-weather-sensors][ecowitt] plugin uses: a
`MotionSensor` per datapoint with three custom characteristics
(`Value`, `Intensity`, `Last Updated`). Apple Home users get on/off
motion tiles driven by configurable thresholds — useful for stock
Home automations like *"When Wind Speed motion detected, close the
awning"*. The live numeric value renders in Eve and Controller for
HomeKit.

- **Wind**: speed, gust, max-daily gust, direction (instantaneous +
  10-minute average)
- **Rain**: hourly rate, event/daily/weekly/monthly/yearly totals,
  time-since-last-rain
- **Barometric pressure**: relative (sea-level corrected) and
  absolute (raw at station altitude). Inverted threshold — low
  pressure triggers the motion event
- **UV index**: with EPA bucket label (Low / Moderate / High / Very
  High / Extreme)
- **Lightning**: today's strike count, this-hour's strike count,
  distance to last strike (inverted threshold — close strikes
  trigger), time since last strike. Requires a WH57-compatible
  sensor on the station

Configuration: master toggle "Enable Extended Sensors" (default off)
gates per-category sub-toggles (wind, rain, pressure, UV, lightning).
Display mode is selectable between **static names** (recommended —
"Wind Speed" tile with motion state, value visible in Eve) and
**embed live value in tile name** ("Wind Speed 14 mph" updating on
each reading). Per-sensor thresholds and display units (mph/kph/mps/
kts, in/mm, inHg/hPa, mi/km) all configurable.

### Added — Native bonus sensors

- **Feels-like** temperature (heat index / wind chill) per probe —
  AWN pre-calculates `feelsLike`, `feelsLike1..N`, `feelsLikein` and
  these now expose as standard `TemperatureSensor` accessories
  alongside the raw temperatures.
- **Dew point** per probe — same pattern, `dewPoint`,
  `dewPoint1..N`, `dewPointin` as `TemperatureSensor`.

### Implementation notes

- Custom HAP characteristics use fresh UUIDs owned by this plugin
  (not Eve's, not Ecowitt's) — third-party HomeKit apps render them
  via the characteristic display name.
- `Service#testCharacteristic` guard in the base class makes
  re-attachment idempotent across child-bridge restarts.
- Pre-conversion of `lastRain` ISO timestamps to Unix-ms in
  `parseDevices()` keeps the `SensorAccessory#setValue(raw: number)`
  interface uniform.
- Verified-plugin status preserved: extended sensors are off by
  default, so v1.4.x users see zero behavior change. Existing
  homebridge/plugins verification checks still pass.

### Want to test?

Issue [#1][issue1] is the live thread for v1.5.0 beta testing. If
you have a station with sensors this plugin previously skipped
(particularly lightning), help is welcome — install the beta tag
and report findings.

[ecowitt]: https://github.com/rhockenbury/homebridge-ecowitt-weather-sensors
[issue1]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/issues/1

## [1.4.3] — 2026-05-30

### Fixed
- **Empty "What's new" pane in homebridge-config-ui-x after an update.**
  This release introduces `CHANGELOG.md` (shipped in the npm tarball, read
  by the HB UI update dialog) and extends the GitHub Actions release
  pipeline to create a GitHub Release with the relevant changelog section
  on every `v*` tag push. From this version forward, the HB UI "What's
  new" pane will be populated.
- **Invalid JSON Schema** in `config.schema.json` — individual property
  schemas previously used `"required": true | false`, which is not valid
  JSON Schema (`required` must be an array of property names at the
  parent object level). Replaced with a top-level
  `"required": ["apiKey", "applicationKey"]` and removed the boolean
  `required` from every individual property. Flagged by the
  homebridge/plugins verification check.

### Changed
- Genericized the example station name in the config form placeholder
  and docstrings (`Backyard Station` instead of the original maintainer's
  personal weather station identifier). No functional change.
- **`package.json` metadata** improvements (flagged by the
  homebridge/plugins verification check): added a `homepage` field
  pointing to the GitHub README, and expanded `keywords` from
  `["homebridge-plugin"]` to nine relevant terms (ambient-weather,
  weather-station, homekit, awn, websocket, co2, air-quality, pm2.5) so
  the package surfaces correctly in npm and HB UI plugin search.

## [1.4.2] — 2026-05-30

First public release of the `@bcourbage` soft fork of
[`homebridge-ambient-weather-sensors`][upstream] by Deac Karns. This
release rolls up every change that accumulated since upstream v1.3.2 while
upstream pull requests [#21][pr21] (Homebridge 2.x compatibility) and
[#22][pr22] (cache validity bug fix) remain unmerged.

### Added
- **Homebridge 2.x / HAP 2.x compatibility.** Plugin now starts cleanly on
  Homebridge 2 with no "Name does not conform" warnings.
- **CO2 sensor** support for the AWN AQIN family (`co2_in_aqin` and
  standalone `co2` fields).
- **PM2.5 and PM10 air quality sensors** with EPA-bucket-derived
  AirQuality enum.
- **Opt-in WebSocket realtime data source** (`dataSource: "realtime"`)
  via `rt2.ambientweather.net` — sensor updates as the station reports
  them instead of every 2 minutes. Bounded exponential reconnect (1s→60s)
  with heartbeat logging. Polling remains the default.
- **Multi-station naming.** Accessory display names now use the station
  name set in the AWN account (`info.name`) instead of bare MAC, e.g.
  "Backyard Station Indoor Temperature" instead of `84F3EB66D267-tempinf`.
- **Allowlist (`includeOnly`)** companion to `excludeSensors`. Set it to
  expose only specific sensors / stations; everything else is hidden.
- **Human-readable filter matching.** `excludeSensors` and `includeOnly`
  accept friendly names ("Indoor Temperature"), station names, raw AWN
  fields, MAC addresses, or full uniqueIds — case-insensitive,
  whitespace-trimmed.
- **Password masking** on API key and application key fields in the
  homebridge-config-ui-x configuration form (`x-schema-form: password`).
- **Per-sensor-type toggles** in the config: `temperatureSensors`,
  `humiditySensors`, `solarRadiationSensors`, `co2Sensors`,
  `airQualitySensors`.
- **Automated release pipeline** — GitHub Actions publishes to npm with
  provenance attestations on every `v*` tag push.

### Changed
- **Polling refactor.** A single platform-owned timer now fans out to all
  accessory wrappers instead of N parallel timers per accessory —
  eliminates the parallel-fetch race against AWN's 1 req/s rate limit
  that occasionally caused the disk cache to flap.
- **Disk cache removed.** No longer needed after the polling refactor;
  fewer moving parts, no cache-validity edge cases.
- **Solar radiation sensor:** dropped the `ProductData` characteristic
  abuse that previously displayed W/m² as a string. HomeKit now shows the
  native lux value; the README documents the W/m²↔lux conversion factor
  for users who want exact W/m².
- **Display names** simplified to `<station name> <sensor>` —
  city/state are no longer interpolated since HomeKit's room/home
  hierarchy already expresses location.

### Fixed
- **Cache validity race** (independent of upstream PR #22) where
  `Cache.isValid()` read `this.valid` before the async `fs.access`
  finished, so the first read after startup occasionally hit a stale
  flag.
- **`deregisterAccessories`** now matches by `uniqueId` so that
  accessories whose display names changed across upgrades are still
  matched and not duplicated.
- **API key leak** prevention: keys no longer flow into log lines on
  request failure.

### Maintenance
- Migrated to ESLint flat config (v9) + typescript-eslint v8.
- ESM build (`type: module`, NodeNext, `.js` suffixes on imports).
- Node 22.12+ / Node 24 supported; CI matrix runs both.
- TypeScript 5.7.

[upstream]: https://github.com/peledies/homebridge-ambient-weather-sensors
[pr21]: https://github.com/peledies/homebridge-ambient-weather-sensors/pull/21
[pr22]: https://github.com/peledies/homebridge-ambient-weather-sensors/pull/22
[1.5.0-beta.13]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.13
[1.5.0-beta.12]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.12
[1.5.0-beta.11]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.11
[1.5.0-beta.10]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.10
[1.5.0-beta.9]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.9
[1.5.0-beta.8]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.8
[1.5.0-beta.7]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.7
[1.5.0-beta.6]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.6
[1.5.0-beta.5]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.5
[1.5.0-beta.4]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.4
[1.5.0-beta.3]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.3
[1.5.0-beta.2]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.2
[1.5.0-beta.1]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.1
[1.5.0-beta.0]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.0
[1.4.3]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.4.3
[1.4.2]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.4.2

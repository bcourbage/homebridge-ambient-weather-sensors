# Changelog

All notable changes to `@bcourbage/homebridge-ambient-weather-sensors` are
documented here. The format is loosely based on [Keep a Changelog][kac];
versions follow [Semantic Versioning][semver]. This file is read by
`homebridge-config-ui-x` to show "What's new" notes after an update — keep
entries short and user-facing.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/

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
[1.5.0-beta.1]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.1
[1.5.0-beta.0]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.5.0-beta.0
[1.4.3]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.4.3
[1.4.2]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.4.2

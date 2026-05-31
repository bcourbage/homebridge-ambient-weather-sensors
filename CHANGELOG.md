# Changelog

All notable changes to `@bcourbage/homebridge-ambient-weather-sensors` are
documented here. The format is loosely based on [Keep a Changelog][kac];
versions follow [Semantic Versioning][semver]. This file is read by
`homebridge-config-ui-x` to show "What's new" notes after an update — keep
entries short and user-facing.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/

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
[1.4.3]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.4.3
[1.4.2]: https://github.com/bcourbage/homebridge-ambient-weather-sensors/releases/tag/v1.4.2

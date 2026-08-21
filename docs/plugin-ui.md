# The plugin page (sensor-map v2 preview)

Opening the plugin's settings in Homebridge Config UI X shows two
areas: the v2 preview panels described here, and below them the
standard settings form (Name, API keys, sensor category toggles).
The form is unchanged from the 1.x line apart from the "Advanced
(v2.0 preview)" fieldset that holds the v2 opt-in flag. This page
documents the panels above the form.

## What the panels show

### Status

The plugin version, the configuration mode (`legacy` for a normal
1.x-style config, `v2` once the config carries `configVersion: 2`
and a `sensorMap`, or `safe-mode` when the config cannot be
interpreted safely), and whether the sensor-map v2 flag is on,
including where it was set (config field or the `SENSOR_MAP_V2`
environment variable).

### Discovered stations & datapoints

Every station and sensor field the plugin has observed in AWN
payloads. Populated by the first successful v2 discovery or poll
with the v2 flag on; empty until then.

### Notices

A record of structural changes: whenever the v2 path re-registers an
accessory because its structure changed (for example a battery
sub-service was added or removed), the event is recorded here.
Expected when the flag is on and the configuration changes. Existing
notices remain visible after the flag is turned off.

### Sensor map

A table of every sensor row the plugin resolves for each station,
grouped by station:

| Column | Meaning |
| --- | --- |
| Data point | The AWN field name (`tempf`, `windspeedmph`, ...) |
| Name | The accessory name this row produces |
| Kind | Sensor kind and measurement (`temperature · temperature`, `motion · wind-speed`) |
| Units | Source unit, and `source → display` when a conversion applies |
| Enabled | Whether the row registers an accessory |
| Layer | Which configuration layer authored the row (below) |
| Battery | The AWN battery field backing the row, when one exists |

The **Layer** badge tells you where a row's configuration comes from:

- **default**: the built-in default map; nothing in your config
  touches this row.
- **global**: a setting that applies to every station (for example a
  display-unit choice).
- **station**: an exception scoped to one station's MAC address.
- **unrecognized**: a field the station reports that the plugin has
  no built-in definition for. Shown for visibility; it registers
  nothing.

On a **legacy** configuration the table is a *migration preview*: it
shows the exact sensor map a conversion to the v2 format would
produce from your current settings, translated by the same machinery
the migration itself will use. Nothing is converted by viewing it.

Warnings, row-validation errors, and ownership notes (for example a
disabled sensor that owns a battery field other rows reference)
appear as banners above the table.

## Using the editor

The status, discovery, and notices panels are read-only observations.
The sensor map is the editor: Edit on any row opens its controls, and
changes are DRAFTS until saved. "Preview changes" dry-runs a draft
through the real save pipeline without writing anything, and shows
exactly which accessories would register, deregister, or re-register.
The page follows Homebridge UI X's light/dark theme, including live
theme switches.

The v2 opt-in switch lives in the form below the panels: **Advanced
(v2.0 preview) → Enable sensor-map v2 live path**, which selects the
live v2 pipeline and populates the discovery and sensor-map panels.
Saving from the editor requires the flag: with it off the table is a
preview only, and the page says so.
Hand-authoring `configVersion: 2` and a `sensorMap` array in
`config.json` remains possible (the table renders it, and validation
problems surface as banners), but the editor is the recommended path.

## How saving works

- **Per-row editing**: enable or disable a row, rename it, choose
  display units (matching AmbientWeather.net's unit choices), and set
  motion-trigger thresholds and direction.
- **Per-station exceptions**: override a setting for one station
  while a global choice keeps applying to the others, matching the
  layer model shown in the table today.
- **Guided migration**: on a legacy configuration, the first save
  converts the config to the v2 format. Your original settings are
  written to an immutable snapshot
  (`legacy-config-snapshot.json` in the plugin's data directory)
  **before** `config.json` changes, so a rollback path always
  exists.
- **Guarded saves**: every save is validated server-side against
  the same rules the runtime uses. Changes that would register,
  deregister, or re-register an accessory require explicit
  confirmation of a server-verified preview; a save whose
  consequences drifted since that preview is refused. Invalid rows
  are refused with the reason; nothing is written on any refusal.
- **Restart to apply structure**: the saved configuration takes full
  effect (registrations included) on the next Homebridge restart.

Assigning unrecognized fields to new custom sensors (declaring a
kind, measurement, and source unit) arrives in an upcoming beta.

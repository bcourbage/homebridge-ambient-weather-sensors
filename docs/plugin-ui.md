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
| (state icon) | Green check = the row registers an accessory; muted dash = disabled; blank = an unrecognized field |
| Data point | The AWN field name (`tempf`, `windspeedmph`, ...); its tooltip names the backing battery field when one exists, and a colored dot marks rows your configuration authors (see layers below) |
| Name | The accessory name this row produces |
| Kind | Sensor kind as an icon (thermometer, droplet, sun, motion wave) or a badge (CO₂, PM2.5, PM10, `?` for unrecognized); the tooltip carries the full kind and measurement |
| Units | The unit HomeKit displays; highlighted when it differs from what the station reports (the tooltip names the source unit) |

The provenance dot on the data point tells you where a row's
configuration comes from:

- **no dot (default)**: the built-in default map; nothing in your
  config touches this row.
- **green dot (global)**: a setting that applies to every station
  (for example a display-unit choice).
- **blue dot (station)**: an exception scoped to one station's MAC
  address.
- Unrecognized fields (a `?` in the Kind column) are shown for
  visibility; they register nothing.

Opening a row's editor shows the demoted facts in full: kind,
measurement, battery field, and layer.

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

With `configVersion: 2` and the v2 flag on, the settings form hides
the legacy controls the runtime no longer reads (sensor category
toggles, extended-sensor thresholds, display units): the plugin
maintains a dynamic form schema reflecting the configuration mode,
applied on the next full Homebridge restart after a mode change.
Those legacy config fields still exist in config.json - the rollback
mirror maintains them for 1.7.x downgrades.

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
- **Family units**: the Units selectors above the tables set the
  display unit for a whole category the way AmbientWeather.net does,
  including the single Rainfall choice that keeps rain rate and
  accumulation totals consistent. A selection drafts a global
  template per data point (so it also applies to stations added
  later) and clears per-station unit exceptions; everything else
  those exceptions set is untouched. One exception to "stations added
  later": a custom sensor defined for a single station changes its
  unit on that station's own entry only, because its identity does
  not exist globally. Single rows can still be changed in their row
  editor afterward; a family whose rows currently disagree shows
  Mixed.
- **Per-station exceptions**: override a setting for one station
  while a global choice keeps applying to the others, matching the
  layer model shown in the table today.
- **Guided migration**: on a legacy configuration, the first save
  converts the config to the v2 format. Your original settings are
  written to an immutable snapshot
  (`legacy-config-snapshot.json` in the plugin's data directory)
  **before** `config.json` changes, so a rollback path always
  exists. Converting again after a rollback also works: the
  rolled-back settings are recorded first in the append-only
  `legacy-conversion-journal` folder (one numbered entry file per
  baseline), so neither the original snapshot nor the rolled-back
  state is ever lost. A journal entry is restored with the same
  procedure as the snapshot, sourcing the fields from the chosen
  entry file's `legacy` object — see the README's rollback section
  for the exact steps.
- **Opting single rows out of a preview**: every modified row in the
  preview carries a Skip action. It pins that row's changed fields to
  their current values as an ordinary station-scoped draft (the
  preview re-runs by itself), so a broad change - a family unit, for
  example - can go ahead while one or two rows stay as they are.
- **Guarded saves**: every save is validated server-side against
  the same rules the runtime uses. Changes that would register,
  deregister, or re-register an accessory require explicit
  confirmation of a server-verified preview; a save whose
  consequences drifted since that preview is refused. Invalid rows
  are refused with the reason; nothing is written on any refusal.
- **Restart to apply structure**: the saved configuration takes full
  effect (registrations included) on the next Homebridge restart.
  Restart Homebridge itself, not just this plugin's child bridge — a
  child-bridge restart reuses the configuration the main Homebridge
  process already holds in memory and will not pick up the save.

Assigning unrecognized fields to new custom sensors (declaring a
kind, measurement, and source unit) arrives in an upcoming beta.

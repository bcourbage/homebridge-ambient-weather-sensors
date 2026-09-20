# The plugin settings page

Opening the plugin's settings in Homebridge Config UI X shows ONE
page: the sensor-map editor with its Connection section. Since
2.0.0-beta.17 the schema-generated settings form is retired — every
editable setting lives on this page — and the preview-era panels
(status table, discovered-datapoints dump, notices panel) are gone.

## One save path

The page's **Save** is the only functional save path. It runs the
guarded two-phase transaction: server-side validation against the
on-disk configuration, verification that the save matches the
consequences the preview showed (the preview, with its per-row Skip,
is the confirmation; there is no separate confirmation step), the
durable legacy snapshot/journal record, and a verbatim write of the
composed block.
The native Homebridge Save button at the bottom of the window is
disabled from the moment the page loads and never enabled: the Config
UI X SDK offers no way to hide it (an SDK addition is requested
upstream), so it remains visible but inert. Close never saves.

## Connection & polling

A collapsed section above the editor holds the plugin's live
settings: platform name, data source (polling or realtime), API key,
application key, the station filter, and the embed-name update
interval. Edits here count as drafts, appear in previews, and save
through the same guarded transaction as sensor-map edits.

Credentials are handled as secrets. A stored key renders as a fixed
run of mask dots (never its value): leaving the mask untouched means
the stored key is unchanged; focusing the pristine mask selects it,
so typing replaces the key; deleting the mask and leaving the field
empty requests clearing the stored key. Stored values never appear on
the page, in previews, in logs, or in the snapshot/journal records —
the page shows only whether a key is set.

## Applying a save

Configuration changes take effect on the next restart of this
plugin's bridge. Homebridge's **Restart Child Bridge** action is
sufficient — it re-reads the plugin's configuration from disk before
the bridge comes back (verified on Homebridge 2.4.0). The page cannot
trigger the restart itself; the saved banner names the action.
Killing the child process by hand does NOT re-read the configuration;
a full Homebridge restart also works.

## Structural-change history

Re-registrations caused by structural changes are recorded and shown
in a collapsed "Recent structural changes" disclosure at the bottom
of the page.

## Sensor map

A table of every sensor row the plugin resolves for each station,
grouped by station:

| Column | Meaning |
| --- | --- |
| (state icon) | Green check = the row registers an accessory; muted dash = disabled; blank = an unrecognized field |
| Data point | The AWN field name (`tempf`, `windspeedmph`, ...); its tooltip names the backing battery field when one exists, and a colored dot marks rows your configuration authors (see layers below) |
| Name | The accessory name this row produces |
| Kind | Sensor kind as an icon (thermometer, droplet, sun, motion wave) or a badge (CO₂, PM2.5, PM10, `?` for unrecognized); the tooltip carries the full kind and measurement |
| Units | For extended sensors, the unit HomeKit displays (highlighted when converted; the tooltip names the source unit). For natively displayed kinds (temperature, humidity, air quality), the unit the station reports; Apple Home chooses the display format on each device |

The provenance dot on the data point tells you where a row's
configuration comes from:

- **no dot (default)**: the built-in default map; nothing in your
  config touches this row.
- **green dot (global)**: a setting that applies to every station
  (for example a display-unit choice).
- **blue dot (station)**: an exception scoped to one station's MAC
  address.
- Unrecognized fields (a `?` in the Kind column) offer **Assign** —
  see "Assigning unrecognized fields" below.

On a **legacy** configuration the table renders the compat
translation of your current settings — the exact sensor map the
first save will write. Nothing is converted by viewing it; the
conversion happens only when you save.

Warnings, row-validation errors, and ownership notes (for example a
disabled sensor that owns a battery field other rows reference)
appear as banners above the table.

## Using the editor

The sensor map is the editor: Edit on any row opens its controls, and
changes are DRAFTS until saved. "Preview changes" dry-runs a draft
through the real save pipeline without writing anything, and shows
exactly which accessories would register, deregister, or re-register.
The page follows Homebridge UI X's light/dark theme, including live
theme switches.

Legacy config fields (sensor category toggles, extended-sensor
thresholds, display units, exclude/include filters) still exist in
config.json after a conversion - the rollback mirror maintains them
for 1.7.x downgrades. The page never renders controls for them.

The v2 pipeline is on by default. An installation that explicitly
opts out (`_sensorMapV2: false` or `SENSOR_MAP_V2=0`) sees the table
as a preview only, with saving disabled and a banner saying so.
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
  effect (registrations included) on the next restart. Restarting
  this plugin's child bridge from the Homebridge UI is enough — that
  action re-reads the plugin's configuration from disk before
  respawning (verified against Homebridge 2.4.0). Killing the child
  process directly does NOT pick up the save (the crash-respawn path
  reuses the parent's cached configuration); a full Homebridge
  restart also works.

## Assigning unrecognized fields

An unrecognized row (a `?` in the Kind column) offers **Assign**
instead of Edit: choosing a measurement and the unit the station
reports turns the field into a custom sensor. The measurement
determines the accessory kind (shown in the form), the choices offered
are exactly the combinations this plugin can build, and the assignment
drafts nothing until it is complete — an unfinished form never blocks
a save of other rows for missing identity fields, only for being open.
The new sensor applies to the one station whose row was assigned, is
enabled by default, and previews as a registration like any other
structural change. Display unit, threshold, and trigger direction can
be set in the same form or edited later like any row.

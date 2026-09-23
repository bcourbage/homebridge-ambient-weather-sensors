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
translation of your current settings. Nothing is converted by viewing
it. Saving an explicit conversion preview or a full sensor-map edit
converts the block. A Connection-only save without a station-filter change leaves
it unconverted; a station-filter change uses the sensor-map preview and can convert it.

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
- **Guided migration**: on a legacy configuration, an explicit
  conversion save or the first full sensor-map save converts the
  config to the v2 format. Connection-only saves without a station-filter change
  do not. Station-filter changes use the sensor-map preview and can convert it. Original settings are
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
- **Opting eligible rows out of a preview**: a modified row offers
  Skip only when its complete before-state can be represented by the
  supported station-scoped fields. Label changes, indirect ownership
  changes without a representable pin, and catalog operations do not
  offer Skip. The action pins that row's changed fields to
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
instead of Edit. Choose the sensor type and, where offered, the unit
the station reports. Each choice identifies a complete accessory-kind
and measurement pair. Leak, contact, occupancy, smoke, and direct
motion are separate choices even though all consume on/off readings.
Types requiring a newer adopted catalog remain visible but disabled;
**Review new sensor support** leads to the separate update workflow. An
incomplete assignment creates no partial identity and blocks Preview
until completed or cancelled. A diagnosed saved identity requires
repair in the JSON config editor, not an implicit reassignment.
The new sensor applies to the one station whose row was assigned, is
enabled by default, and previews as a registration like any other
structural change. Display unit, threshold, and trigger direction can
be set in the same form or edited later like any row.

State types accept numbers `0`/`1` or booleans `false`/`true`, with the
pair's exact meanings shown in the editor. Contact `0` means closed
and `1` means open. Other present values report a fault and clear the
alert; missing data retains the preceding state and fault. Reversed
encodings and text such as `"open"` are not supported. Smoke consumes
an existing detector state, not a concentration-derived alarm. Native
carbon monoxide remains unavailable.

### Generic numeric labels

**Numeric value** consumes a finite number unchanged. It uses a motion
tile in Apple Home; compatible controller apps can show its numeric
value and optional literal unit label. A label never converts a
reading. Optional thresholds use inclusive comparisons, at-or-above
or at-or-below, rather than detecting a crossing.

**Unit label** supports up to 16 Unicode code points after trimming.
Leaving an inherited label untouched preserves its absence in the
edited fragment. **Use no label**, or clearing an edited textbox,
authors an explicit empty label. **Use inherited label** removes only
the station-level label; **Use default label** does the same for a
global template. Identity and other settings are preserved. Invalid
labels are refused by the server, without truncation. The preview
separates authored-label intent from effective accessory changes.

### Conversion and catalog adoption

The **Sensor support** section offers **Review new sensor support**
when the installed plugin supports types and fields not yet available
in this configuration. Catalog version numbers remain available under
**Technical details**. A legacy-shaped block first offers **Preview conversion**.
This uses the server's legacy translation, preserving disabled
categories and existing birth stamps. No fake sensor edit is needed.
After saving and reloading the converted configuration, **Review new
sensor support** becomes available when a newer catalog exists.

Conversion and adoption require clean row and Connection drafts and
no invalid open editor. They do not save or discard drafts
automatically. Each operation locks editing until saved or cancelled.
Adoption is separate from assigning a sensor because it can affect
other rows and battery interpretation. The preview lists the actual
configuration transition, accessory and disabled-row changes, and
every reported battery-polarity change. No accessory changes does not
mean no configuration changes.

The **Sensor-support update** preview summarizes the server's consequences.
Newly available disabled rows are labelled **Available, switched off**;
these are supported sensor fields, not newly detected physical devices.
The summary promises unchanged accessories only when the preview reports
no accessory, setting, or battery-reporting changes. **Enable new sensor
support** saves through the same guarded pipeline; **Cancel preview** saves
nothing. After saving and reloading, the section reports when support is
up to date for the installed plugin.

The Units panel places measurement labels above their selectors so long
names remain readable on narrow screens. The **i** button beside the
evapotranspiration unit selector opens an in-page explanation for touch,
keyboard, and pointer users. It changes no unit or draft setting.

Saved assignments awaiting a newer catalog are preserved unchanged
for adoption preview, even if the current catalog diagnoses them as
unavailable. Withheld or unreconstructable saved content requires JSON
repair first. Neither operation lowers stamps or bypasses the normal
preview, validation, commit, and persistence pipeline.

An uncertain persistence result, failed authoritative reload, receipt
mismatch, or failed save-control restoration locks the page until
reload and inspection. Successfully saved settings still require the
plugin restart described above. Changing an already-saved custom
identity is not offered by this editor.

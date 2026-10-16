# Upgrading

Choose the section below for your installed version. It explains what changes
on upgrade, which choices remain yours, and how to apply or undo them. For the
changes in each release, see the [changelog](./CHANGELOG.md).

---

<a id="upgrading-to-v2"></a>

## v1.7.x → v2.0.0

Installing 2.0.0 leaves your configuration in place and does not automatically
enable newer sensor support. The plugin reads your legacy settings through a
compatibility layer, preserving valid existing sensor choices until you are
ready to convert them to the new format.

### Before upgrading

Back up your Homebridge configuration and check the requirements: Homebridge
1.9+ within 1.x, or Homebridge 2.x, with Node.js 22.13+ within 22.x or 24.x.
Your Node version must also be supported by Homebridge. In particular,
Homebridge 1.9.0 supports Node 22, not Node 24. This corrects the earlier
Homebridge 1.8 minimum, which had no supported Node version in common with
the plugin. The editor has been validated with Homebridge Config UI X 5.29.0.

After installing the update, restart Homebridge and open **Plugins → Ambient
Weather → gear icon**. The settings page brings Connection settings and sensor
controls together: rename readings, choose display units and supported
thresholds, disable unwanted rows, or assign a sensor type to an unrecognized
field. Use the page's own Save button after reviewing the preview; the standard
Homebridge Save button below it is intentionally disabled.

### Converting your sensor settings

Conversion writes your settings in the v2 sensor-map format. It happens when
you save an explicit conversion preview or a full sensor-map edit, not simply
when you install the plugin or open the editor. Connection-only saves do not
convert the configuration unless you change the station filter, which uses
the full sensor-map path and can convert it.

Before writing the converted configuration, the plugin preserves your original
1.x sensor settings in `legacy-config-snapshot.json` under
`<homebridge storage>/plugin-data/ambient-weather/`. This snapshot is a recovery
copy of the sensor settings, not a substitute for your full configuration backup.

An unconverted legacy configuration can still run on 1.7.3. Once converted,
however, returning to 1.7.3 requires the
[rollback procedure](https://github.com/bcourbage/homebridge-ambient-weather-sensors#rollback),
also linked from the page's Rollback status. Follow it before resuming operation
on 1.7.3, and do not simply turn off the v2 flag: the legacy path cannot read
the converted sensor map and may remove accessories.

Returning to 1.7.3 can remove unsupported sensors from Apple Home and change
the settings of those that remain. Motion sensors may trigger again or under
different conditions. Back up your full Homebridge configuration first, follow
the README's rollback instructions, and check your sensors and automations
after restarting. Reinstalling v2 alone will not restore lost settings.

### Managing sensors individually

Conversion keeps known disabled sensors disabled, but replaces category-wide
control with individual sensor choices. For example, converting with temperature
sensors off keeps the known temperature sensors off. If a different, recognized
temperature field starts reporting later, it can appear as a new accessory;
disable that row in the editor if you do not want it.

Legacy category-wide and sensor-name exclusions are not carried forward as rules
for future fields. An exclusion naming an otherwise unknown, never-observed
field therefore does not create a disabled placeholder during conversion.
The station filter still applies, unknown fields still require an assignment,
and newer sensor support still needs to be adopted and enabled as described below.

### New sensor support is a separate choice

After conversion, select **Review new sensor support** to see the capabilities
available in the installed plugin. This is separate from ordinary sensor edits
because it can also change how battery readings are interpreted. The preview
lists those effects before anything is saved, including the corrected lightning
and leak battery readings. Installing the plugin alone does not apply those
corrections.

Newly available sensor definitions stay disabled until you enable them
individually, and your saved custom assignments keep their interpretation.
There is one important distinction: an enabled custom assignment that was
waiting for an unavailable capability can become active when support is added.
Its accessory addition appears in the preview, so review that list as well as
the new disabled fields and battery changes.

### Understanding custom readings

For an unrecognized field, choose a supported sensor type and source unit.
The choices include separate leak, contact, occupancy, smoke, and on/off motion
types, plus a generic numeric option with a literal unit label and an optional
threshold. **Change interpretation** lets you revise a saved custom assignment;
if that requires replacing its Apple Home accessory, the preview says so.
Replacement may affect rooms and automations.

Extended numeric readings appear as motion accessories in Apple Home. Compatible
controller apps show the labelled value, while an optional threshold controls
the motion state. AQI readings are plain numbers, not inferred health categories.
Native carbon-monoxide detection is not included.

### Applying saved changes

After saving, use Homebridge's **Restart Child Bridge** action for this plugin,
verified on Homebridge 2.4.0, or restart Homebridge fully. Both reload the saved
configuration; killing the child process manually does not.

## v2.0.0 betas → v2.0.0

Back up your configuration, install the stable release, and restart Homebridge.
Your sensor maps, custom interpretations, and adopted support versions remain
in place, with no reconversion required and no automatic adoption of newer
support. If you are coming from an earlier beta, use **Review new sensor
support** on the settings page when ready.

If you use beta.19, your sensors will work as before. The editor now explains
what may change if you return to an older plugin version, and the upgrade
instructions and release notes have been updated for 2.0.0.

## First-time installation

Check the requirements above, then install the plugin through Homebridge UI
and open its settings page. Enter your Ambient Weather API and application keys
in Connection, review the preview, and save. You can do this before any station
data is available. After restarting Homebridge, return to the page once
discovery has populated the sensor rows and preview any changes you want to make.

A new installation starts with the current sensor-support version, so there is
no separate support update to adopt. That does not turn on every optional
sensor automatically; review and enable the readings you want.

If your configuration has multiple Ambient Weather platform blocks, the plugin
page is read-only for all of them. Make changes through the JSON config editor
using the [Multi-Home guide](https://github.com/bcourbage/homebridge-ambient-weather-sensors/blob/main/MultiHome.md).

## Earlier upgrades (historical)

For upgrades between older v1 releases, see the
[archived upgrade guides](./docs/archive/upgrading-v1.md). For an upgrade to v2,
use the instructions above.

## Where to get help

- File an issue: <https://github.com/bcourbage/homebridge-ambient-weather-sensors/issues>
- Existing v1.5.0-related discussion: [issue #1](https://github.com/bcourbage/homebridge-ambient-weather-sensors/issues/1)

# Upgrading

This document covers what to expect when upgrading your installation. For technical / per-version changes see [`CHANGELOG.md`](./CHANGELOG.md).

---

## v1.5.x → v1.6.0

v1.6.0 is a small but behavior-changing release. Two related changes around the **Extended Sensors display mode**:

### What changed

1. **Embed mode now forces the polling data source.** If your config has `extendedDisplayMode: "embed"` AND `dataSource: "realtime"`, the plugin will coerce the data source to `polling` at startup with a warning log:
   ```
   Embed display mode is incompatible with the realtime data source —
   the combination causes elevated iOS battery drain from HAP name-update
   notifications. Forcing polling for this run. To silence this warning,
   either switch the display mode to "Show generic names" or set the data
   source explicitly to "polling".
   ```

2. **A new `embedNameUpdateMinIntervalMinutes` setting** caps how often each tile's name can be rewritten in embed mode. Default is 2 minutes, matching the polling cadence — so it's effectively a no-op for new installs.

### Why

Late in the 1.5.0 test cycle (after GA), solmssen reported that his iPhone was draining 5-7% per hour while idle while embed mode was active, dropping back to ~1% per hour after switching to the recommended "Show generic names" mode. The mechanism: in embed mode the plugin rewrites the HAP `Name` characteristic on every value change, and each rewrite generates a notification forwarded to every paired iOS device. With realtime + ~15 extended sensors, that's many notifications per minute, each waking the phone's radio briefly.

The constraint cuts the worst case (realtime + embed) out of the available combinations; the throttle further bounds the rate even on polling.

### Who's affected

- **You're on static + anything** (most users, including the default): **nothing changes.** The constraint doesn't fire. The throttle has no effect because static mode never rewrites names.
- **You're on embed + polling**: **nothing changes.** Polling's natural 2-minute cadence is already below the throttle's default ceiling.
- **You're on embed + realtime**: **your data source gets coerced to polling.** Tile name updates will appear every 2 minutes instead of every ~30 seconds. To silence the warning, edit your config to set the data source explicitly to `polling`. If you want the realtime data source to feed the underlying value characteristics (visible in Eve / Controller for HomeKit), switch your display mode to "Show generic names" — that combination doesn't trigger the constraint.

### How to upgrade

Standard path:
```sh
sudo hb-service stop
sudo npm install -g @bcourbage/homebridge-ambient-weather-sensors
sudo hb-service start
```

Or via Homebridge UI's Update button on the Plugins page.

---

## v1.4.x → v1.5.0

v1.5.0 is the largest release of this plugin. It adds a sizable set of new sensors and a battery-status feature, but **nothing changes for existing users unless you opt in.** If you upgrade and don't touch any settings, your HomeKit experience is identical to v1.4.3 — plus one bonus: low-battery notifications on the sensors you already have.

### TL;DR

| What you get | Action required |
|---|---|
| **Low-battery notifications on every existing sensor** | None. Restart Homebridge, you're done. |
| **Feels-like + dew-point as new Temperature sensor accessories** | None (if `Temperature Sensors` is already on, these appear automatically). |
| **Wind, rain, barometric pressure, UV, and lightning sensors** | Opt in via plugin settings — see step 2 below. |

If you have a Homebridge instance you want to update right now, the steps are below. If you're cautious or want to read first, scroll to **What changes mean for you**.

---

## Step 1 — Update the plugin

If you previously installed v1.4.x via Homebridge UI:

1. Open Homebridge UI → **Plugins**
2. Find "Ambient Weather" (`@bcourbage/homebridge-ambient-weather-sensors`)
3. Click **Update** to take the latest stable (currently `1.4.3`)

If you want to test the **beta** (which is where v1.5.0 currently lives):

```sh
sudo hb-service stop
sudo npm install -g @bcourbage/homebridge-ambient-weather-sensors@beta
sudo hb-service start
```

Or via Homebridge UI's "Install a specific version" option, pick the latest `1.5.0-beta.x`.

> **Heads-up about beta releases:** beta versions are released on the `beta` npm tag, not `latest`. The Homebridge UI's "Update" button won't pick them up — that's intentional. You stay on the stable v1.4.x until v1.5.0 ships as GA, at which point the Update button surfaces it.

After the install completes, restart the child bridge (if you're using one): Homebridge UI → **Status** → click your child bridge → **Restart**.

## Step 2 — What appears automatically (no settings needed)

The moment v1.5.0 starts, two things happen:

### Battery sub-services

Every sensor accessory that comes from a probe AWN reports a battery for now exposes a **Battery sub-service**. Apple Home and Eve both surface this:

- In Apple Home: open a sensor tile → tap the gear icon → scroll down. You'll see a battery level indicator. Apple Home also begins firing its built-in low-battery push notifications when AWN reports a probe as low.
- In Eve / Controller for HomeKit: a battery percentage and indicator appear directly on the tile.

For your specific use case — **"replace the battery when low"** — you can now build:

```
Apple Home → Automation → ➕ "New Automation"
  • When:  An Accessory Triggers...
  • Pick:  e.g. "Backyard Outdoor Temperature"
  • Trigger: When the Sensor is "Low Battery"
  • Then:   Send notification "Replace the AA batteries in the outdoor unit"
```

This works for any sensor that has battery coverage. See **What changes mean for you** below for the full coverage table.

### Feels-like and dew-point temperatures

If you have `Temperature Sensors` enabled (you almost certainly do), AWN's pre-calculated feels-like (heat index / wind chill) and dew-point values appear as additional Temperature accessories per probe. These existed in AWN's API the whole time — v1.5.0 just stopped ignoring them.

For example, where v1.4.x gave you "Outdoor Temperature" and "Indoor Temperature", v1.5.0 also gives you "Outdoor Feels Like", "Outdoor Dew Point", "Indoor Feels Like", "Indoor Dew Point", plus the same four for any WH31 channel probes you have.

If you don't want them, you can hide them via the existing **Exclude Sensors** field — add their friendly names ("Outdoor Feels Like", etc.) to the list.

---

## Step 3 — Opt into Extended Sensors (optional)

Wind, rain, barometric pressure, UV, and lightning are all off by default. Apple Home has no native service for these data types, so they're exposed using a clever workaround documented in the README — the short version is that each datapoint becomes a HomeKit **Motion Sensor** whose state toggles when a threshold is crossed. The live numeric reading is visible in Eve or Controller for HomeKit but not in Apple Home directly (with one exception — see "Display mode" below).

### Enable the master toggle

1. Homebridge UI → **Plugins** → "Ambient Weather" → **Settings** (gear icon)
2. Scroll past the existing native-sensor checkboxes (Temperature, Humidity, etc.)
3. Find **Enable Extended Sensors** — check it
4. Five new checkboxes appear:
   - **Wind sensors** (speed, gust, direction)
   - **Rain sensors** (rate, daily, event totals)
   - **Barometric pressure** (relative + absolute)
   - **UV index**
   - **Lightning sensors** (count, distance, time-since-last)
5. Check the ones you want
6. **Save** and restart the child bridge

After the restart, the new accessories appear in Homebridge → **Accessories** and you can drag them into your Home app rooms via "Add Accessory" → look for the existing Homebridge bridge.

### Pick a display mode

Below the per-category checkboxes is a dropdown: **How should Apple Home display extended sensors?**

- **Show generic names (recommended)** — Tile shows just "Wind Speed" with an on/off motion indicator. Live numeric value visible only in Eve / Controller for HomeKit. Tile name stays stable.
- **Show live value in the tile name** — Tile shows "Wind Speed 14 mph" updating as readings change. Apple Home users see the value directly. Trade-offs:
  - Values are rounded to whole numbers
  - Tile name updates on every reading (~30s in realtime mode, every 2 minutes in polling)
  - If you rename a tile manually in Apple Home, the plugin detects this and stops overwriting it — your custom name wins from that point on
  - Some Homebridge log lines may mention the name change — informational, safe to ignore

If you're only ever going to use Eve or Controller for HomeKit, stick with "Show generic names (recommended)". If you want the value in Apple Home tiles, switch to "Show live value in the tile name".

### Adjust thresholds (optional)

Each extended sensor has a configurable threshold that controls when the Motion sensor triggers. Defaults are sensible:

| Sensor | Default | Meaning |
|---|---|---|
| Wind speed | 25 mph | Beaufort 6 — "strong breeze", loose objects start to blow |
| Wind gust | 35 mph | One step above sustained wind — for awning automations |
| Rain rate | 0.01 in/hr | "Any measurable rain" — skip the sprinkler if true |
| UV index | 3 | EPA "Moderate" — sun protection recommended |
| Lightning distance | 10 mi (inverted) | Triggers when a strike is **closer** than 10 miles |
| Pressure | 29.5 inHg (inverted) | Triggers when pressure drops **below** — low-pressure system incoming |

If you want different values, change them in the **Motion thresholds for extended sensors** section. They're in AWN's native units (mph, in/hr, inHg, mi) regardless of your display unit choice.

**Hiding a sensor entirely**: uncheck its enable checkbox in the **Motion thresholds for extended sensors** section. The accessory won't appear in HomeKit (or Eve, or any client). The threshold value is preserved in the form for if you re-enable later.

**Showing a sensor without an automation trigger** (the value's visible in Eve / Controller for HomeKit, but never fires a Home.app automation): keep the enable checkbox on but set the threshold to a value the sensor can never reach. Examples:
- Wind speed / gust: `99999` mph
- Rain rate: `99999` in/hr
- UV: `99`
- Lightning distance (inverted): `0` mi (never fires because distance is always positive)
- Pressure (inverted): `0` inHg (never fires because pressure is always positive)

Sensors without a configurable threshold (wind direction, rain accumulation totals, time-since sensors, lightning strike counts) have no enable checkbox; they always appear when their category is enabled. To hide one specifically, add its name to the **Exclude Sensors** list at the bottom of the form.

### Pick display units (optional)

If you're outside the US, change the display units in the **Display units for extended sensors** section: kph or m/s or kts for wind, mm for rain, hPa for pressure, km for lightning distance. Thresholds stay in AWN's native units — only the displayed number is converted.

---

## Step 4 — Example automations

Once enabled, these are the practical automations users actually build:

### Close the awning when it gets gusty

```
Home → Automations → ➕
  • When:  Wind Gust motion is detected
  • Then:  Awning shade scene → Closed
```

### Skip the sprinkler if it's raining

```
Home → Automations → ➕
  • When:  Rain Rate motion is detected
  • Then:  Sprinkler switch → Off
```

(Note: this requires you to have an existing sprinkler switch or shortcut in Home.)

### Push notification when lightning gets close

```
Home → Automations → ➕
  • When:  Lightning Distance motion is detected
  • Then:  Send notification "Lightning within 10 miles — bring in the kids"
```

### Low-battery reminder

```
Home → Automations → ➕
  • When:  [any sensor tile] → Battery is Low
  • Then:  Send notification "Replace batteries in [station]"
```

The battery automation works on any v1.5.0+ sensor; pick whichever tile corresponds to the probe you want to be reminded about.

---

## What changes mean for you

### Battery coverage by probe

| Probe | AWN battery field | Sensors that get a Battery sub-service |
|---|---|---|
| Outdoor combo array | `battout` | Outdoor temp/humidity, feels-like, dew point, solar, UV, wind (all), rain (all) |
| Indoor display console | `battin` | Indoor temp/humidity, feels-like, dew point, both barometric pressures |
| WH31 numbered probe 1-N | `batt1`–`battN` | Per-channel temp, humidity, feels-like, dew point |
| AQIN module | `batt_co2` | CO2, PM2.5, PM10, AQIN-housing temp/humidity |
| WH31L lightning (Ecowitt WH57) | `batt_lightning` | All four lightning sensors |

Probes AWN doesn't report a battery for get no Battery sub-service — better than misleading "battery normal" on something we can't actually confirm.

### Why MotionSensor for the extended sensors?

Apple Home has no native service for wind, rain, UV, pressure, or lightning. The other Homebridge weather plugins (`homebridge-weather-plus`, `homebridge-ecowitt-weather-sensors`, `homebridge-mqttthing`) all converged on the same workaround: use a MotionSensor service whose `MotionDetected` boolean toggles when a configurable threshold is crossed. That gives Apple Home users a real, automatable handle on the data; Eve / Controller for HomeKit users get the live numeric value via additional custom characteristics.

We deliberately mirror the verified `homebridge-ecowitt-weather-sensors` plugin's pattern so users running both side-by-side see consistent tile shapes.

### Why no native value in Apple Home tiles?

Apple's HomeKit Accessory Protocol doesn't have a service type for "arbitrary number." Custom characteristics work, but Apple's Home app silently ignores any characteristic it doesn't recognize. Third-party HomeKit apps like Eve and Controller for HomeKit render arbitrary custom characteristics by reading the characteristic's display name — that's why the value shows up there.

The **embed-value display mode** is a workaround that puts the value into the tile name so Apple Home displays it — at the cost of the tile name churning on every reading. Pick whichever trade-off works for you.

---

## Troubleshooting / FAQ

### "I enabled Extended Sensors but no new accessories appeared."

The child bridge needs a restart. Homebridge UI → **Status** → click your child bridge → **Restart**. Wait ~30 seconds, then check **Accessories**.

### "Will tiles appear for sensors my station doesn't have?"

No. The plugin only creates accessories for sensor fields actually present in your station's AWN payload. If you enable a category whose hardware you don't have — Lightning without a WH31L, Air Quality without an AQIN, CO2 without an AQIN, etc. — the relevant fields are absent from AWN's response, no accessory gets registered, and nothing appears in HomeKit. Enabling a category is a zero-cost no-op when the underlying hardware isn't installed. The reverse is also handled: if you previously had a probe that's now disconnected, the orphaned tile is cleaned up on the next plugin startup.

### "I see 'Wind Direction' but the motion indicator is always off."

That's intentional. Wind direction is informational only — there's no meaningful threshold for "direction is high." The Value characteristic carries the direction (e.g. "315° (NW)") for Eve users to see; MotionDetected stays false.

### "My lightning sensors don't appear."

Your station needs a WH31L lightning sensor (Ecowitt catalogs the same hardware as a WH57). If the AWN payload for your station doesn't include `lightning_day` / `lightning_distance` / `lightning_time` fields, this plugin has nothing to expose. Check the AWN dashboard — if you don't see lightning data there either, no plugin can fix that.

### "Apple Home shows 'battery 5%' but the batteries are brand new."

AWN reports only "low" or "good" — not an actual percentage. When AWN says "low," the plugin shows 5% as a sentinel value so Apple Home's tile shows an alarming indicator. When AWN says "good," the plugin shows 100%. There's no way to get the real percentage; AWN doesn't expose it.

### "My lightning sensor (WH31L) shows low battery in HomeKit but AWN's dashboard shows it as healthy. Replacing batteries didn't help."

This is an upstream AWN issue, not a plugin bug. AWN's API has been observed to report `batt_lightning = 0` (which the plugin interprets as low, consistent with every other batt* field) even when the WH31L's batteries are fresh and the AWN dashboard correctly shows the sensor as healthy. Suspected causes include an AWN API encoding bug for that specific field or a quirk of the WH31L's battery reporting that AWN's dashboard knows to ignore. Either way, the plugin reads what AWN's API returns — if your lightning Battery tile in HomeKit disagrees with the AWN dashboard, the discrepancy is at AWN's end. Replacing the batteries (with known-good ones) does not change the API value, so don't waste batteries trying to fix it.

**Suppressing the spurious low-battery notifications** (added in beta.24): add `batt_lightning` to the **Exclude Sensors** list. This hides the lightning sensor's Battery sub-service specifically — the lightning accessories themselves (Lightning Strikes Today, Lightning Distance, etc.) remain visible and functional. You can also write `Lightning Strikes Today-batt` or `lightning_distance-batt` if you'd rather identify the battery by its parent sensor than by the AWN field name. Same effect — both forms resolve to the same probe's Battery sub-service.

The general mechanism: any `excludeSensors` entry that's either a raw battery field name (`batt_lightning`, `batt_co2`, `battin`, `battout`, `batt1`..`batt10`) OR a sensor name with `-batt` suffix is interpreted as battery-only suppression rather than accessory removal. Useful for any future cases where AWN's API misreports a battery field.

### "I want one sensor from a category but not others (e.g. wind speed but not direction)."

Use the existing **Exclude Sensors** field at the bottom of the plugin settings. Add the friendly name of the sensor you want to hide ("Wind Direction", "Wind Direction 10m Avg", etc.). The per-category checkbox stays on, but the specific sensors you list get suppressed.

### "Will my existing automations break?"

No — v1.5.0 is fully additive. Every accessory you have today remains, with the same characteristics and same behavior. The only differences are: (a) some accessories now have a Battery sub-service, (b) new feels-like and dew-point accessories appear if `Temperature Sensors` is enabled, and (c) the Extended Sensors section is off by default so it has zero behavior until you opt in.

### "I'm running this plugin AND `homebridge-ecowitt-weather-sensors` side-by-side."

Both plugins now use the same MotionSensor + custom-characteristic pattern, so the tile shapes match. You can use `Exclude Sensors` (in this plugin) and the Ecowitt plugin's `customHidden` map to make sure neither plugin duplicates what the other exposes.

### "I have stations at multiple locations and want them in different Apple Home Homes."

Use the new `stationFilter` config field (added in v1.5.0-beta.18) with multiple platform instances, one per Home. Each instance gets its own Homebridge child bridge that pairs with one Home. Full walkthrough: [MultiHome.md](./MultiHome.md).

Quick version:
1. Open Homebridge UI → JSON Config
2. Duplicate the `AmbientWeatherSensors` platform entry, one per Home
3. Add `stationFilter` to each (array of station names or MACs)
4. Add a `_bridge` block to each with unique `username` and `port`
5. Save, restart Homebridge
6. Pair each child bridge with its target Home from the Status tab

Tile names are bare ("Outdoor Temperature") when an instance's filter resolves to one station, and prefixed ("Cabin Outdoor Temperature") when it resolves to multiple — so each Home gets clean naming automatically.

---

## Where to get help

- File an issue: <https://github.com/bcourbage/homebridge-ambient-weather-sensors/issues>
- Existing v1.5.0-related discussion: [issue #1](https://github.com/bcourbage/homebridge-ambient-weather-sensors/issues/1)

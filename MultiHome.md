# Multi-Station / Multi-Home Setups

This guide explains how to expose Ambient Weather stations in **different HomeKit Homes** when you have stations in physically separate places — a main house and a cabin, a primary residence and a vacation rental, a rooftop and a basement.

If you have a single station, or multiple stations all belonging to one Home, **you don't need this guide** — the plugin's defaults handle that out of the box.

> **Heads-up.** The Homebridge UI plugin configuration form was built around the "one plugin = one configuration" assumption. Multi-Home setups require a one-time edit to `config.json` to add a second platform instance. After that initial edit, you can manage each instance separately. A friendlier UI for this is in our [future-design backlog](./docs/future/tabbed-config-ui.md).

## Concepts

Three terms you need to keep straight:

| Term | What it is |
|---|---|
| **HomeKit Home** | The top-level container in Apple's Home app. Created in Settings → Home. Each Home has its own users, automations, and accessories. Typical user: 1 Home. Multi-property user: 2+ Homes. |
| **Homebridge bridge** | The HAP-protocol identity that pairs with a Home. A bridge has a unique MAC-style username, a port, and a setup PIN/QR code. **One bridge pairs with exactly one Home.** |
| **Homebridge child bridge** | A separate HAP bridge identity Homebridge can spin up for a single plugin platform instance — gives that platform its own pairing, its own QR code, and isolates it from the rest of Homebridge. Required for multi-Home setups. |
| **Platform instance** | One entry in your `config.json`'s `platforms[]` array. Each platform instance can have its own `_bridge` config, becoming its own child bridge. |

The constraint that drives everything in this guide: **one bridge → one Home**. If you want N Homes to each have their own subset of your AWN stations, you need N child bridges, which means N platform instances of this plugin.

## When you need this guide

You need this guide if **both** of these are true:

1. You have multiple physical AWN stations (separate base stations with their own MAC addresses), and
2. You want them to appear in **different HomeKit Homes** (not just different rooms in the same Home).

You do **not** need this guide if:

- You have one station (any number of probes/sensors hanging off it). Default behavior is correct.
- You have multiple stations, all in the same HomeKit Home. Default behavior is correct — the plugin automatically prefixes tile names with the station name to disambiguate (e.g. "Front Yard Outdoor Temperature" vs "Back Yard Outdoor Temperature").

## Step-by-step setup

### Step 1 — Get your existing setup working as a single-Home install first

Before splitting, confirm the plugin works correctly with all your stations in one Home. This catches credential issues, network issues, and station-discovery issues before they get mixed up with multi-bridge troubleshooting.

If you're not at that baseline yet, follow the [main upgrade guide](./UPGRADING.md) first.

### Step 2 — Identify each station

In your Homebridge log (or by checking the AWN dashboard at <https://ambientweather.net/dashboard>), note the **name** and **MAC address** for each physical station. You'll need one of these two values to filter for the station in the next step.

Example:

| Station name (AWN's `info.name`) | MAC address |
|---|---|
| `Main House WS-2000` | `AA:BB:CC:11:22:33` |
| `Cabin WS-5000` | `AA:BB:CC:44:55:66` |

The plugin's `stationFilter` field accepts either form. Names are easier to read; MACs are more stable (renaming a station in the AWN app doesn't break the filter).

### Step 3 — Open JSON Config

In the Homebridge UI, click the three-dot menu in the top right → **JSON Config**. This opens your full `config.json` as a text editor.

Find the existing `AmbientWeatherSensors` platform entry. It looks something like:

```jsonc
{
  "platform": "AmbientWeatherSensors",
  "name": "Ambient Weather",
  "apiKey": "abcdef...",
  "applicationKey": "ghijkl...",
  "temperatureSensors": true,
  // ... other settings
}
```

### Step 4 — Duplicate the platform entry, one per HomeKit Home

For each Home you want, create one platform entry. Add a `stationFilter` to each so it sees only the right station(s). Each entry needs its own `_bridge` config with a **unique** `username` and `port`.

```jsonc
{
  "platforms": [
    {
      "platform": "AmbientWeatherSensors",
      "name": "Main House Weather",
      "apiKey": "abcdef...",
      "applicationKey": "ghijkl...",
      "temperatureSensors": true,
      "humiditySensors": true,
      // ... your existing settings ...
      "stationFilter": ["Main House WS-2000"],
      "_bridge": {
        "username": "0E:D7:86:B0:05:A5",
        "port": 31564
      }
    },
    {
      "platform": "AmbientWeatherSensors",
      "name": "Cabin Weather",
      "apiKey": "abcdef...",
      "applicationKey": "ghijkl...",
      "temperatureSensors": true,
      "humiditySensors": true,
      // ... same sensor settings (or different — your choice) ...
      "stationFilter": ["Cabin WS-5000"],
      "_bridge": {
        "username": "0E:D7:86:B0:05:A6",
        "port": 31565
      }
    }
  ]
}
```

Notes on the new fields:

- **`"name"`**: distinct labels for the two instances. Used in Homebridge logs (each instance's log lines are prefixed with this name, e.g. `[Main House Weather]`).
- **`"stationFilter"`**: array of station names (or MAC addresses) to expose in this instance. Match is case-insensitive and whitespace-trimmed. Stations not in the list are dropped before any sensor processing.
- **`"_bridge.username"`**: must be **unique per instance** AND unique across all child bridges on this Homebridge install. Format is a MAC-like 6-byte hex string. Pick any locally-administered MAC; the value just needs to be distinct.
- **`"_bridge.port"`**: must be **unique per instance** AND not collide with any other Homebridge port. Typical range: 30000-40000.

> **Keep your API keys identical across instances.** Each platform instance independently hits AWN's API; the same `apiKey` + `applicationKey` pair will return all your stations and each instance's `stationFilter` will narrow it down. You don't need separate AWN accounts.

### Step 5 — Save and restart Homebridge

Save the JSON Config. The UI prompts you to restart Homebridge.

When Homebridge comes back up, each platform instance loads independently. Watch the log for lines like:

```
[Main House Weather] Station "Cabin WS-5000" (MAC: AA:BB:CC:44:55:66) filtered out by stationFilter
[Cabin Weather] Station "Main House WS-2000" (MAC: AA:BB:CC:11:22:33) filtered out by stationFilter
```

If you see those, the filter is working — each instance sees only its assigned station.

### Step 6 — Pair each child bridge with its HomeKit Home

Open the Homebridge UI → **Status** tab. You should see one row per child bridge, each with its own state and pairing controls.

For each child bridge in turn:

1. Click the child bridge row → **Settings** (or the bridge name)
2. The pairing dialog shows a **QR code** unique to that child bridge
3. On your iPhone/iPad, open the **Home app**
4. Make sure you're in the **target Home** (top-left corner shows the active Home — switch to the one this bridge should join)
5. Tap **+** → **Add Accessory**
6. Scan the QR code from the Homebridge UI
7. The Home app picks up the bridge and lists its accessories
8. Add them to rooms as you'd like

Repeat for each child bridge, each time making sure you're in the correct Home in the Apple Home app **before** scanning the QR code.

### Step 7 — Verify

After pairing, in each Home you should see:

- Only that Home's station's sensors as tiles
- Tile names without a station prefix (e.g. `Outdoor Temperature`, not `Cabin WS-5000 Outdoor Temperature`) — because with `stationFilter` reducing each instance to one station, the plugin's multi-station prefix logic correctly skips the prefix

If you see the prefix, double-check your `stationFilter` matched exactly one station for that instance.

## Variations

### Multiple stations in one Home, plus a station in another Home

Just include all the stations for the first Home in its filter:

```jsonc
{
  "platform": "AmbientWeatherSensors",
  "stationFilter": ["Front Yard WS-2000", "Back Yard WS-5000"],
  "_bridge": { "username": "0E:D7:86:B0:05:A5", "port": 31564 }
},
{
  "platform": "AmbientWeatherSensors",
  "stationFilter": ["Cabin WS-2000"],
  "_bridge": { "username": "0E:D7:86:B0:05:A6", "port": 31565 }
}
```

In the first instance (two stations), tile names get prefixed for disambiguation ("Front Yard Outdoor Temperature", "Back Yard Outdoor Temperature"). In the second (one station), tile names stay bare ("Outdoor Temperature").

### Filtering by MAC address instead of name

If you rename your stations in the AWN app sometimes, MAC addresses are more stable:

```jsonc
{
  "platform": "AmbientWeatherSensors",
  "stationFilter": ["AA:BB:CC:11:22:33"],
  "_bridge": { "username": "0E:D7:86:B0:05:A5", "port": 31564 }
}
```

You can mix names and MACs in the same filter — whichever matches wins.

## Troubleshooting

### "I added a second platform entry but it doesn't show up in the Homebridge UI Plugins page"

Expected. The Plugins page shows one card per installed npm package, not one card per platform instance. Look in the **Status** tab — each child bridge shows up there as its own row.

The Plugin Config form (the gear icon on the Plugins page) can only edit the **first** platform instance. The second and subsequent instances have to be edited via JSON Config.

### "Same QR code appears for both child bridges"

Check that each `_bridge.username` is unique. Homebridge derives the HAP identity from the username, so two instances with the same username pair as the same bridge.

### "Accessory appears in the wrong Home"

Check that the iPhone Home app was on the right Home when you scanned the QR code. To move an already-paired bridge between Homes: remove it from the wrong Home first (Home app → Home Settings → Hubs & Bridges → bridge → Remove Bridge), then re-pair from the correct Home.

### "No accessories appear for one of the bridges, and the log shows stationFilter is set but matched zero stations"

The filter values don't match any station in the AWN response for that instance. Check spelling (the match is case-insensitive but exact otherwise — `Cabin WS-5000` does not match `Cabin WS5000`). Verify the station name in AWN's dashboard or in the unfiltered Homebridge log of the first instance.

### "After splitting, my old accessories disappeared and new ones appeared in their place"

Each child bridge has its own HAP identity, so the accessories on it are technically new from HomeKit's perspective — even though the underlying AWN sensor is the same. Any automations you'd built against the old accessories need to be re-pointed at the new tiles. There's no migration path because HomeKit doesn't expose one; the bridge↔Home pairing is the unit of identity.

If this is unacceptable, the alternative is to keep all stations on one bridge and live with the station-prefix tile names. The trade-off is yours.

### "Can I have one bridge serve two Homes simultaneously?"

No. HomeKit's bridge-Home relationship is strictly 1:1. If you need accessories in two Homes, you need two bridges.

### "My Homebridge install was working fine before I added the second platform entry, now nothing works"

JSON syntax error in `config.json`, most likely. Open the JSON Config view in the UI — if the JSON is invalid, the UI flags the offending line. Common mistakes:

- Missing comma between platform entries
- Extra trailing comma after the last property in an object
- Mismatched braces or brackets
- Unescaped quotes inside strings

The Homebridge log usually says exactly which line is the problem.

## Reference

- **Homebridge child bridges**: <https://github.com/homebridge/homebridge/wiki/Child-Bridges> *(wiki URLs occasionally change — if the link 404s, search "homebridge child bridges" on the Homebridge wiki)*
- **HomeKit Homes** (Apple's docs): <https://support.apple.com/guide/iphone/share-the-controls-of-your-home-iph0c5126e36/ios>

## Limitations

- The Homebridge UI form only edits the first platform instance. Multi-instance management is JSON Config only. See [`docs/future/tabbed-config-ui.md`](./docs/future/tabbed-config-ui.md) for the proposed solution.
- HomeKit charges a one-time per-bridge pairing cost (the QR-code scan). You'll do it once per bridge during setup; it doesn't recur.
- Automations cannot span Homes. If you want "when wind speed at the cabin is high, turn on a fan in the main house," that's not possible through Apple Home alone — the Homes are independent.

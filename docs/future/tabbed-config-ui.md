# Future Design — Tabbed Multi-Home Config UI

**Status:** Deferred.
**Last reviewed:** 2026-06-13.

## Problem statement

Setting up multiple HomeKit Homes with this plugin currently requires users to edit `config.json` directly via the Homebridge UI's JSON Config menu. The standard plugin config form (the gear icon on the Plugins page) only manages a single platform instance, so any second or subsequent instance needed for a multi-Home setup is invisible to the form-driven UI.

This is fine for technically-confident users but creates friction for less-technical users who'd otherwise benefit from multi-Home support. See [`MultiHome.md`](../../MultiHome.md) for the current workflow.

## Proposed solution

Replace the auto-generated schema form with a **custom Angular-based UI** in a `homebridge-ui/` directory inside the plugin package. The custom UI would present tabs in the plugin configuration screen, one per HomeKit Home:

- A default install shows one tab.
- Users can add tabs (one per additional Home they want).
- Each tab configures: station filter, sensor toggles, child bridge identity, threshold values, display units.
- Save logic translates the tabbed UI state into multiple platform entries in `config.json`, each with its own `_bridge` config and `stationFilter`.

The user experience after deployment:

1. Plugin Config dialog opens to a tabs view.
2. First tab is labeled "Home 1" (or user-renameable).
3. Below the tabs, all the existing config fields apply to the current tab.
4. A `+ Add Home` button at the tabs row creates a new tab with its own `_bridge` and station filter.
5. On Save, `config.json` is updated with N platform entries (one per tab).
6. After save + Homebridge restart, the Status page shows N child bridges, each pairable to its respective Home via its own QR code.

## Technical approach

Homebridge UI X supports plugins shipping their own custom configuration UI through the `@homebridge/plugin-ui-utils` package. The path:

1. **Add `homebridge-ui/` directory** to the plugin package:
   - `homebridge-ui/public/` — Angular front-end source
   - `homebridge-ui/server.ts` — Node bridge between Angular UI and HB UI X's config API
2. **Build pipeline integration**:
   - Angular CLI for component compilation
   - Output bundles into `homebridge-ui/public/` for HB UI X to load
3. **API surface** (provided by `@homebridge/plugin-ui-utils`):
   - `getPluginConfig()` — read current config from HB UI X
   - `updatePluginConfig(config)` — write a new config array (one entry per tab on save)
   - `savePluginConfig()` — persist to disk
   - `homebridge.getMacAddresses()` — generate unique `_bridge.username` values per tab
4. **Angular components needed**:
   - `TabbedHomeContainerComponent` — root container with tab strip + add/remove tab logic
   - `HomeConfigComponent` — per-tab form (existing config schema, restructured as a reactive form)
   - `ChildBridgeConfigComponent` — inline display of `_bridge.username` + port + pairing status (currently a separate Homebridge dialog)
   - `StationPickerComponent` — read stations from AWN API via the plugin's `apiKey` + `applicationKey` and let users select-by-name rather than typing station names
5. **State management**: each tab is a reactive form group; the parent component tracks the array and emits the serialized config on save.

Reference plugins that have built custom UIs:
- `homebridge-camera-ffmpeg` — complex multi-camera config UI
- `homebridge-broadlink-rm` — device discovery and learning UI
- `homebridge-deebot` — vacuum config UI

All are non-trivial Angular codebases (multiple thousand LOC each) and represent a significant ongoing maintenance burden.

## Effort estimate

| Phase | Approx effort |
|---|---|
| Scaffold `homebridge-ui/` with Angular project + build pipeline | 1-2 days |
| Re-implement existing schema fields as Angular form components | 3-5 days |
| Build tabbed UI shell (add/remove tab, switch tabs, persist state) | 2-3 days |
| Config-read / config-write logic producing multi-instance `platforms[]` | 1-2 days |
| Inline child-bridge config + station-picker components | 2-3 days |
| HB UI X integration testing + iteration | 3-5 days |
| Update docs (`UPGRADING.md`, `README.md`, retire JSON-Config portion of `MultiHome.md`) | 1 day |
| **Total** | **~2-3 weeks of focused dev** |

For comparison, the entire v1.5.0 beta cycle (beta.0 → beta.17) took about 3 days of intermittent work across early June 2026. This project would be roughly 5-7× that effort and substantially shift the plugin's maintenance profile from "schema-driven, low-touch" to "Angular front-end, ongoing UI work."

## Triggers to revisit

Reconsider the deferral when **at least one** of these is true:

1. **Three or more separate users** have asked for better multi-Home UX (in issues, in Discord, in upstream commentary).
2. The plugin transitions from "soft fork bridging to upstream" to **de facto successor** — i.e. upstream has been confirmed dormant for 12+ months and the plugin is the maintained path forward for Homebridge 2.x users.
3. The plugin pursues **Homebridge verified plugin** status seriously and the verification reviewers raise multi-Home UX as a concern.
4. **HB UI X improves native multi-instance support** to the point where the custom-UI workaround becomes unnecessary. If that happens, this proposal is obsolete — switch to the native path.

If none of the four are true at next review, defer again.

## Alternatives considered

### Restructure the schema to expose a `stations[]` array within one platform instance

Trade-off: doesn't actually create multiple child bridges. All stations would still expose through a single HAP bridge, which pairs with a single HomeKit Home. Doesn't solve the multi-Home problem; it'd just be a more structured way to organize a single-Home multi-station setup.

### Use Homebridge external accessories instead of child bridges

External accessories pair separately from the main bridge and can each go to a different Home. Trade-off: typically used for accessories that exceed the per-bridge HAP limit, not for grouping. The pairing UX is awkward (separate QR code per accessory). Doesn't fit the multi-Home use case cleanly.

### Document the JSON Config workflow well (chosen path for v1.5.0)

Trade-off: usable but requires text-editor confidence. Lowest implementation cost, fastest to ship, no ongoing maintenance burden. The right path until demand emerges.

## Decision log

- **2026-06-13** — Deferred. Reasoning: zero confirmed multi-Home users in current test pool; current JSON Config workflow functional with new `stationFilter` field; soft-fork status makes large UI investments risky; ~2-3 weeks of dev effort better spent on smaller, more universal improvements at this stage. Shipping `stationFilter` field + `MultiHome.md` walkthrough in v1.5.0-beta.18 as the interim solution.

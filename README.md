# Homebridge Ambient Weather Sensor Plugin (bcourbage fork)

> **This is a soft fork** of [peledies/homebridge-ambient-weather-sensors](https://github.com/peledies/homebridge-ambient-weather-sensors) maintained at [@bcourbage/homebridge-ambient-weather-sensors](https://www.npmjs.com/package/@bcourbage/homebridge-ambient-weather-sensors). The original work, design, and most of the code are by [Deac Karns](https://github.com/peledies). This fork adds **Homebridge 2.x / HAP 2.x compatibility** (closes upstream [#18](https://github.com/peledies/homebridge-ambient-weather-sensors/issues/18), [#19](https://github.com/peledies/homebridge-ambient-weather-sensors/issues/19)), plus multi-station naming, opt-in websocket realtime updates, CO2 / PM2.5 / PM10 sensor coverage, password-masked API key fields, and a polling refactor that consolidates per-accessory timers into one. Pull requests against upstream ([#21](https://github.com/peledies/homebridge-ambient-weather-sensors/pull/21), [#22](https://github.com/peledies/homebridge-ambient-weather-sensors/pull/22)) remain open; this fork exists so users on Homebridge 2 can use the plugin in the meantime.
>
> Install via the Homebridge UI plugin search, or:
>
> ```sh
> npm install -g @bcourbage/homebridge-ambient-weather-sensors
> ```

<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

<img src="https://raw.githubusercontent.com/peledies/homebridge-ambient-weather-sensors/main/images/homebridge_ambient_weather.png" width='400px'>

## Complete HomeKit support for the Ambient Weather weather station ecosystem using [Homebridge](https://homebridge.io).

![npm version](https://img.shields.io/npm/v/@bcourbage/homebridge-ambient-weather-sensors?style=for-the-badge&label=npm)
![npm downloads](https://img.shields.io/npm/dt/@bcourbage/homebridge-ambient-weather-sensors?style=for-the-badge)
![license](https://img.shields.io/npm/l/@bcourbage/homebridge-ambient-weather-sensors?style=for-the-badge)
![Discord](https://img.shields.io/discord/432663330281226270?style=for-the-badge&label=Discord)

</DIV>
</SPAN>


## Plugin Information
This plugin allows you to pull sensor data from your Ambient Weather weather station via its REST API and add those accessories to homebridge.

## Compatibility
- Homebridge `1.8+` and Homebridge `2.x`
- Node.js `22.12+` or `24.x`

## Features
- Supports parsing sensors attached to multiple weather stations
- Two data sources: REST polling (default, 2 minute cadence) or websocket realtime updates (opt-in)

## Data Source
The plugin can read sensor values one of two ways. Pick whichever fits your setup; both feed the same HomeKit accessories.

- **Polling** *(default)* — fetches the AWN REST endpoint every 2 minutes. Predictable cadence, minimal moving parts, easy to reason about. Updates lag the real reading by up to 2 minutes.
- **Realtime** *(opt-in via `dataSource: "realtime"`)* — opens a websocket to `rt2.ambientweather.net` and receives values as the station reports them (~30 second cadence indoors). Lower latency but more moving parts (a persistent connection with automatic reconnect).

Realtime is currently opt-in. The default will switch to realtime in a future release once it has been broadly validated.

## Current Supported Sensor Types
- Temperature
- Humidity
- Solar Radiation (as lux — see conversion note below)
- CO2 (AWN's `co2_in_aqin` and standalone `co2` fields)
- Particulate matter — PM2.5 and PM10 (AWN's AQIN-family `pm25_in_aqin`, `pm10_in_aqin`, and the outdoor `pm25` field). Reported with both the raw density and an EPA-bucket-derived HomeKit AirQuality rating.

### Solar Radiation: W/m² ↔ lux

AWN reports solar radiation in **W/m²** (watts per square meter), but HomeKit's `LightSensor` characteristic accepts only **lux**. The plugin converts using the standard approximation:

```
lux ≈ W/m² ÷ 0.0079        (equivalently, lux ≈ W/m² × 127)
```

This factor assumes sunlight's spectral distribution, which matches the AWN sensor's design point. If you want the raw W/m² back from a HomeKit reading, just multiply the displayed lux value by `0.0079`.

## Future Supported Sensor Types
- Air Pressure
- Wind Speed
- Wind Direction

## Setup
An ambientweather.net account is required (no paid subscription is needed) so that you can generate the two keys this plugin uses.

You will need two keys to configre this plugin and they can both be generate on the [Ambient Weather Account Page](https://ambientweather.net/account). This part has been a point of confusion for many users.

creating the API key is straight forward. click the `Create API Key` button and give it a name if you would like.

Creating the Application key involves clicking the following link at the bottom of the 'API Keys' section.

`Developers: An Application Key is also required for each application that you develop. Click here to create one.`

A textbox will come up and you can either leave that blank or put a note in there (It doesn't appear to matter or get displayed anywhere) if you like and click `Create Application Key`.

These keys will get used when you setup the plugin in Homebridge.

## Credits and Acknowledgments

The original work, design, and the vast majority of the code in this plugin are by **[Deac Karns (@peledies)](https://github.com/peledies)**, who created and maintained [homebridge-ambient-weather-sensors](https://github.com/peledies/homebridge-ambient-weather-sensors). The decision to use Ambient Weather's official REST API rather than scraping or BLE bridging is what made this plugin viable in the first place, and it's still the cleanest path to AWN data on HomeKit.

This fork exists only because upstream activity has been quiet (last commit February 2025; pull requests [#21](https://github.com/peledies/homebridge-ambient-weather-sensors/pull/21) and [#22](https://github.com/peledies/homebridge-ambient-weather-sensors/pull/22) sat unmerged) and the plugin stopped working under Homebridge 2.0. Once upstream resumes activity and merges the compatibility PRs, this fork can be sunset — please consider it a temporary bridge, not a competitor.

**If you find this plugin useful**, the appropriate place to donate or thank the author is Deac's PayPal link, preserved unchanged in `package.json`'s `funding` field: [paypal.me/deackarns](https://paypal.me/deackarns).

### Changes in this fork beyond upstream v1.3.2

- Homebridge 2.x / HAP 2.x compatibility (engines bump to Node 22+, ESM migration, HAP v2 stricter `Name` validation)
- Multi-station accessory naming using AWN's `info.name` (instead of bare MAC + sensor key)
- Polling refactor: one platform-level timer instead of N per-accessory timers (eliminates parallel-fetch race against AWN's 1 req/s rate limit; disk cache no longer needed)
- Per-sensor exclusion list (`excludeSensors`) and complementary allowlist (`includeOnly`) with case-insensitive, multi-form matching
- Opt-in websocket realtime data source via AWN's `rt2.ambientweather.net` socket.io endpoint
- CO2 (AQIN) sensor support as HomeKit `CarbonDioxideSensor`
- PM2.5 / PM10 (AQIN) support as HomeKit `AirQualitySensor` with EPA-bucket-derived AirQuality enum
- API/application keys masked as password fields in homebridge-config-ui-x
- Independent latent bug fixes (`Cache.isValid()` async-in-sync, ProductData characteristic on the wrong service, etc.)

### License

Apache License 2.0 — preserved unchanged from upstream. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

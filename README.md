# Homebridge Ambient Weather Sensor Plugin

<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

<img src="https://raw.githubusercontent.com/peledies/homebridge-ambient-weather-sensors/main/images/homebridge_ambient_weather.png" width='400px'>

## Complete HomeKit support for the Ambient Weather weather station ecosystem using [Homebridge](https://homebridge.io).

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
![npm](https://img.shields.io/npm/dt/homebridge-ambient-weather-sensors?style=for-the-badge)
![NPM](https://img.shields.io/npm/l/homebridge-ambient-weather-sensors?style=for-the-badge)
![GitHub release (with filter)](https://img.shields.io/github/v/release/peledies/homebridge-ambient-weather-sensors?style=for-the-badge&label=Latest)
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

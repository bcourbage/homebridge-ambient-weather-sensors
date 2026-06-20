/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export declare const PLATFORM_NAME = "AmbientWeatherSensors";
/**
 * Must match the `name` field in package.json exactly. Homebridge keys
 * cached accessories by (pluginName, platformName, UUID) — if this
 * constant doesn't match the loaded npm package name, every
 * `registerPlatformAccessories` call logs:
 *
 *   "A platform configured a new accessory under the plugin name 'X'.
 *    However no loaded plugin could be found for the name!"
 *
 * and the new accessory is orphaned until Homebridge's plugin-name
 * migration runs on the next restart (transforming it to the actual
 * loaded plugin's name).
 *
 * This was 'homebridge-ambient-weather-sensors' in upstream and was
 * inherited unchanged across the fork-rename in v1.4.0. v1.5.0-beta.2
 * corrected it to match the scoped npm name.
 */
export declare const PLUGIN_NAME = "@bcourbage/homebridge-ambient-weather-sensors";
//# sourceMappingURL=settings.d.ts.map
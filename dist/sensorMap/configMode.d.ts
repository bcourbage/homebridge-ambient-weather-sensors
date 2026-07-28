/**
 * Config-mode detection — see docs/future/sensor-map.md §5.
 *
 * The plugin currently knows how to serve two schema shapes:
 *   - v1.6.0 legacy: no `configVersion`, per-category toggles + thresholds
 *   - v2: `configVersion: 2` + `sensorMap` array
 *
 * A config with `configVersion` > 2 or a malformed `configVersion`
 * means the user has downgraded the plugin (or hand-edited the file
 * to a future format). The plugin enters safe mode: existing cached
 * accessories continue running with last-known values, but zero new
 * structural changes happen and UI writes are refused. Losing config
 * editability is preferable to losing every accessory in HomeKit.
 */
export declare const CURRENT_CONFIG_VERSION = 2;
export type ConfigMode = 'legacy' | 'v2' | 'safe-mode';
export interface ModeDetectionResult {
    mode: ConfigMode;
    /** Warnings the plugin should log. Never fatal. */
    warnings: string[];
    /**
     * User-facing banner text when mode is 'safe-mode', ready to display
     * in the UI. Undefined for legacy/v2 modes.
     */
    safeModeBanner?: string;
}
/**
 * Subset of the raw config the mode detector cares about.
 * Kept loose (any) so we can inspect whatever the user actually wrote.
 */
export interface ConfigInputShape {
    configVersion?: unknown;
    sensorMap?: unknown;
    /** Mirror metadata stamped by the v2 UI save flow (finding 5). */
    _legacyMirror?: unknown;
    temperatureSensors?: unknown;
    humiditySensors?: unknown;
    solarRadiationSensors?: unknown;
    co2Sensors?: unknown;
    airQualitySensors?: unknown;
    extendedSensors?: unknown;
    windSensors?: unknown;
    rainSensors?: unknown;
    pressureSensors?: unknown;
    uvSensors?: unknown;
    lightningSensors?: unknown;
    extendedDisplayMode?: unknown;
    thresholds?: unknown;
    units?: unknown;
    excludeSensors?: unknown;
    includeOnly?: unknown;
}
export declare function detectConfigMode(config: ConfigInputShape | undefined): ModeDetectionResult;
//# sourceMappingURL=configMode.d.ts.map
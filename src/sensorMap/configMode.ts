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

export const CURRENT_CONFIG_VERSION = 2;

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
  // Legacy toggles the detector inspects for the "ambiguous" warning.
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

const LEGACY_TOGGLE_KEYS: ReadonlyArray<keyof ConfigInputShape> = [
  'temperatureSensors', 'humiditySensors', 'solarRadiationSensors',
  'co2Sensors', 'airQualitySensors', 'extendedSensors',
  'windSensors', 'rainSensors', 'pressureSensors', 'uvSensors',
  'lightningSensors', 'extendedDisplayMode', 'thresholds', 'units',
  'excludeSensors', 'includeOnly',
];

export function detectConfigMode(config: ConfigInputShape | undefined): ModeDetectionResult {
  const warnings: string[] = [];
  if (!config) {
    // No config at all — treat as legacy with everything absent
    // (v1.6.0 defaults, which means every category off).
    return { mode: 'legacy', warnings };
  }

  const raw = config.configVersion;

  if (raw === undefined) {
    return { mode: 'legacy', warnings };
  }

  // Non-integer / non-number → safe mode.
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    const banner = `configVersion "${describe(raw)}" is not a supported integer. `
      + 'The plugin cannot interpret this configuration safely. '
      + 'Existing accessories keep running from cache; the UI is read-only until this is fixed.';
    warnings.push(banner);
    return { mode: 'safe-mode', warnings, safeModeBanner: banner };
  }

  if (raw > CURRENT_CONFIG_VERSION) {
    const banner = `This configuration was written by a newer plugin version `
      + `(configVersion: ${raw}; this plugin supports up to ${CURRENT_CONFIG_VERSION}). `
      + 'Upgrade the plugin before making changes.';
    warnings.push(banner);
    return { mode: 'safe-mode', warnings, safeModeBanner: banner };
  }

  // At or below current version. Version 1 would be pre-v2 hand-labeled
  // legacy; treat identically to absent for compat purposes.
  if (raw === 1) {
    return { mode: 'legacy', warnings };
  }

  // configVersion === 2.
  // Ambiguous: v2 + legacy toggles set. v2 wins, warn once per key.
  const legacySet = LEGACY_TOGGLE_KEYS.filter(k => config[k] !== undefined);
  if (legacySet.length > 0) {
    warnings.push(
      `Both configVersion: 2 and legacy toggle(s) [${legacySet.join(', ')}] are set. `
      + 'configVersion: 2 takes precedence; the legacy toggles are ignored.',
    );
  }
  return { mode: 'v2', warnings };
}

function describe(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' && Number.isNaN(v)) {
    return 'NaN';
  }
  return String(v);
}

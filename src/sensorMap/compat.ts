/**
 * Compat layer — translate a v1.6.0 (legacy) config into synthetic
 * global SensorMapOverride entries, deterministically and one-shot.
 *
 * See docs/future/sensor-map.md §6. The layer's contract:
 *   - Reads a LegacyConfig (whatever fields the user has set)
 *   - Emits a SensorMapOverride[] with `stationMac` absent (all global)
 *   - buildEffectiveSensorMap consumes them like any other override
 *   - Nothing written back to config.json; the projection is
 *     recomputed every boot
 *
 * The layer runs ONLY when configMode === 'legacy' (Stage 5). If the
 * user has a `sensorMap` field defined, v2 mode wins and this layer
 * is skipped entirely.
 *
 * Behavioral invariant: for any 1.6.0 config, the effective map
 * produced by (defaults + compatOverrides) MUST produce the same
 * HAP service graph as v1.6.0's determineSensorType-based pipeline.
 * Tested by the migration-equivalence property tests (§12.7),
 * scheduled for Stage 9.
 */

import { batteryFieldForSensor } from '../batteryFields.js';
import { friendlySensorName, sensorKeyByFriendlyName } from '../sensorNames.js';
import { DEFAULT_SENSOR_MAP } from './defaultMap.js';
import type {
  DefaultSensorRow,
  Measurement,
  SensorMapOverride,
  SensorUnit,
} from './types.js';

/**
 * v1.6.0 config shape — union of every field the compat layer inspects.
 * Fields the compat layer doesn't consume (stationFilter, dataSource,
 * apiKey/applicationKey, embedNameUpdateMinIntervalMinutes) are
 * intentionally omitted; they either flow through unchanged or are
 * consumed elsewhere.
 */
export interface LegacyConfig {
  temperatureSensors?: boolean;
  humiditySensors?: boolean;
  solarRadiationSensors?: boolean;
  co2Sensors?: boolean;
  airQualitySensors?: boolean;

  extendedSensors?: boolean;
  windSensors?: boolean;
  rainSensors?: boolean;
  pressureSensors?: boolean;
  uvSensors?: boolean;
  lightningSensors?: boolean;

  extendedDisplayMode?: 'static' | 'embed';

  thresholds?: {
    windSpeedEnabled?: boolean;
    windSpeedMph?: number;
    windGustEnabled?: boolean;
    windGustMph?: number;
    rainRateEnabled?: boolean;
    rainRateInHr?: number;
    uvEnabled?: boolean;
    uv?: number;
    lightningDistanceEnabled?: boolean;
    lightningDistanceMi?: number;
    pressureEnabled?: boolean;
    pressureLowInHg?: number;
  };

  units?: {
    windSpeed?: SensorUnit;
    rain?: SensorUnit;
    pressure?: SensorUnit;
    distance?: SensorUnit;
  };

  excludeSensors?: string[];
  includeOnly?: string[];
}

// AWN battery field names that can appear directly in excludeSensors
// (form 3 of the `-batt` matchers — see platform.buildSuppressedBatteries).
const BATTERY_FIELD_REGEX = /^(?:battout|battin|batt(?:[1-9]|10)|batt_co2|batt_lightning)$/;

/**
 * Public entry point. Returns global overrides (no `stationMac`).
 *
 * Result is stable across calls with equal input — safe to cache but
 * cheap enough to recompute each boot.
 */
export function compatToOverrides(legacy: LegacyConfig): SensorMapOverride[] {
  const overrides: SensorMapOverride[] = [];

  const excludeSet = toMatcherSet(legacy.excludeSensors);
  const includeSet = toMatcherSet(legacy.includeOnly);
  const suppressedBatteries = buildSuppressedBatteries(legacy.excludeSensors);

  for (const row of DEFAULT_SENSOR_MAP) {
    const ov = compatRowOverride(row, legacy, excludeSet, includeSet, suppressedBatteries);
    if (ov) {
      overrides.push(ov);
    }
  }

  return overrides;
}

// ---- Per-row projection --------------------------------------------

function compatRowOverride(
  row: DefaultSensorRow,
  legacy: LegacyConfig,
  excludeSet: Set<string>,
  includeSet: Set<string>,
  suppressedBatteries: Set<string>,
): SensorMapOverride | undefined {
  const parts: SensorMapOverride = { dataPoint: row.dataPoint };
  let touched = false;

  // ---- Category-toggle → enabled.
  const catEnabled = isCategoryEnabled(row, legacy);
  if (!catEnabled) {
    parts.enabled = false;
    touched = true;
  }

  // ---- Extended per-threshold enable checkboxes.
  const perThresholdEnabled = isPerThresholdEnabled(row, legacy);
  if (!perThresholdEnabled) {
    parts.enabled = false;
    touched = true;
  }

  // ---- Threshold value.
  const threshold = thresholdFor(row, legacy);
  if (threshold !== undefined) {
    parts.threshold = threshold;
    touched = true;
  }

  // ---- Display unit.
  const displayUnit = displayUnitFor(row, legacy);
  if (displayUnit !== undefined) {
    parts.displayUnit = displayUnit;
    touched = true;
  }

  // ---- Embed mode (motion kinds only).
  if (row.kind === 'motion' && legacy.extendedDisplayMode === 'embed') {
    parts.embedName = true;
    touched = true;
  }

  // ---- Exclude / include lists.
  if (isExcluded(row, excludeSet)) {
    parts.enabled = false;
    touched = true;
  }
  if (includeSet.size > 0 && !isIncluded(row, includeSet)) {
    parts.enabled = false;
    touched = true;
  }

  // ---- -batt suffix or raw battery-field name → suppress battery.
  if (row.batteryField && suppressedBatteries.has(row.batteryField)) {
    parts.batteryField = null;
    touched = true;
  }

  return touched ? parts : undefined;
}

// ---- Category / sub-toggle logic -----------------------------------

function isCategoryEnabled(row: DefaultSensorRow, legacy: LegacyConfig): boolean {
  // Value-tile kinds map 1:1 to a top-level toggle.
  switch (row.kind) {
    case 'temperature':
      return legacy.temperatureSensors === true;
    case 'humidity':
      return legacy.humiditySensors === true;
    case 'light':
      return legacy.solarRadiationSensors === true;
    case 'co2':
      return legacy.co2Sensors === true;
    case 'air-quality-pm25':
    case 'air-quality-pm10':
      return legacy.airQualitySensors === true;
    default:
      break;
  }
  // Motion kinds — gated by master extendedSensors + measurement-family sub-toggle.
  if (row.kind === 'motion') {
    if (legacy.extendedSensors !== true) {
      return false;
    }
    switch (row.measurement) {
      case 'wind-speed':
      case 'direction':
        return legacy.windSensors === true;
      case 'rain-rate':
      case 'rain-accumulation':
        return legacy.rainSensors === true;
      case 'pressure':
        return legacy.pressureSensors === true;
      case 'uv-index':
        return legacy.uvSensors === true;
      case 'count':
      case 'distance':
        return legacy.lightningSensors === true;
      case 'timestamp':
        // Only two timestamp rows exist: `lastRain` (rain family) and
        // `lightning_time` (lightning family).
        if (row.dataPoint === 'lastRain') {
          return legacy.rainSensors === true;
        }
        if (row.dataPoint === 'lightning_time') {
          return legacy.lightningSensors === true;
        }
        return false;
      default:
        return false;
    }
  }
  // Kinds without a legacy toggle: co, leak, contact, occupancy —
  // none appear in DEFAULT_SENSOR_MAP today; belt-and-suspenders false.
  return false;
}

/**
 * The v1.6.0 form has per-threshold enable checkboxes. Missing key
 * defaults to true (matches v1.6.0's `enabled = v !== false` semantics).
 */
function isPerThresholdEnabled(row: DefaultSensorRow, legacy: LegacyConfig): boolean {
  const t = legacy.thresholds ?? {};
  const enabled = (v: unknown): boolean => v !== false;
  switch (row.dataPoint) {
    case 'windspeedmph':      return enabled(t.windSpeedEnabled);
    case 'windgustmph':       // Wind Gust and Max Daily Gust share windGustEnabled.
    case 'maxdailygust':      return enabled(t.windGustEnabled);
    case 'hourlyrainin':      return enabled(t.rainRateEnabled);
    case 'uv':                return enabled(t.uvEnabled);
    case 'lightning_distance':return enabled(t.lightningDistanceEnabled);
    case 'baromrelin':        // Both pressure accessories share pressureEnabled.
    case 'baromabsin':        return enabled(t.pressureEnabled);
    default:                  return true;
  }
}

function thresholdFor(row: DefaultSensorRow, legacy: LegacyConfig): number | undefined {
  const t = legacy.thresholds ?? {};
  switch (row.dataPoint) {
    case 'windspeedmph':       return t.windSpeedMph;
    case 'windgustmph':
    case 'maxdailygust':       return t.windGustMph;
    case 'hourlyrainin':       return t.rainRateInHr;
    case 'uv':                 return t.uv;
    case 'lightning_distance': return t.lightningDistanceMi;
    case 'baromrelin':
    case 'baromabsin':         return t.pressureLowInHg;
    default:                   return undefined;
  }
}

function displayUnitFor(row: DefaultSensorRow, legacy: LegacyConfig): SensorUnit | undefined {
  const u = legacy.units ?? {};
  const m: Measurement = row.measurement;
  if (m === 'wind-speed' && u.windSpeed && u.windSpeed !== row.displayUnit) {
    return u.windSpeed;
  }
  if ((m === 'rain-rate' || m === 'rain-accumulation') && u.rain) {
    // `units.rain` in v1.6.0 was a single dropdown implying inches vs.
    // millimeters. Map 'in' → 'in' for accumulation, 'in_per_hr' for
    // rate; 'mm' → 'mm' for accumulation, 'mm_per_hr' for rate.
    if (m === 'rain-accumulation') {
      if (u.rain === 'in' || u.rain === 'mm') {
        return u.rain === row.displayUnit ? undefined : u.rain;
      }
    } else {
      if (u.rain === 'in') {
        return row.displayUnit === 'in_per_hr' ? undefined : 'in_per_hr';
      }
      if (u.rain === 'mm') {
        return row.displayUnit === 'mm_per_hr' ? undefined : 'mm_per_hr';
      }
    }
  }
  if (m === 'pressure' && u.pressure && u.pressure !== row.displayUnit) {
    return u.pressure;
  }
  if (m === 'distance' && u.distance && u.distance !== row.displayUnit) {
    return u.distance;
  }
  return undefined;
}

// ---- Exclude / include matchers ------------------------------------

function normalizeMatchKey(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

function toMatcherSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    const k = normalizeMatchKey(entry);
    if (k.length > 0) {
      out.add(k);
    }
  }
  return out;
}

/**
 * Row matches an exclude/include set if any of its match forms
 * (sensorKey, friendly name) is present. Anything with a `-batt`
 * suffix or raw battery-field-name form is handled by the battery
 * suppression path, not here — those entries won't match a sensor
 * accessory.
 */
function isExcluded(row: DefaultSensorRow, excludeSet: Set<string>): boolean {
  if (excludeSet.size === 0) {
    return false;
  }
  return matchesRow(row, excludeSet);
}

function isIncluded(row: DefaultSensorRow, includeSet: Set<string>): boolean {
  return matchesRow(row, includeSet);
}

function matchesRow(row: DefaultSensorRow, matchers: Set<string>): boolean {
  const forms = [row.dataPoint, friendlySensorName(row.dataPoint)].map(normalizeMatchKey);
  for (const f of forms) {
    if (f && matchers.has(f)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve `-batt` suffix + raw battery-field entries from excludeSensors
 * into a set of battery field names to suppress. Mirrors the runtime
 * logic in platform.buildSuppressedBatteries so compat produces the
 * same effect.
 */
function buildSuppressedBatteries(excludeRaw: unknown): Set<string> {
  const suppressed = new Set<string>();
  if (!Array.isArray(excludeRaw)) {
    return suppressed;
  }
  for (const rawEntry of excludeRaw) {
    if (typeof rawEntry !== 'string') {
      continue;
    }
    const normalized = rawEntry.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    if (BATTERY_FIELD_REGEX.test(normalized)) {
      suppressed.add(normalized);
      continue;
    }
    if (normalized.endsWith('-batt')) {
      const stem = normalized.slice(0, -'-batt'.length).trim();
      let field = batteryFieldForSensor(stem);
      if (!field) {
        const key = sensorKeyByFriendlyName(stem);
        if (key) {
          field = batteryFieldForSensor(key);
        }
      }
      if (field) {
        suppressed.add(field);
      }
    }
  }
  return suppressed;
}

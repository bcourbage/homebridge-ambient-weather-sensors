/**
 * Row-level validation for user-authored SensorMapOverride entries.
 *
 * See docs/future/sensor-map.md §3.7 for the full failure table.
 *
 * Two-phase validation, split so buildEffectiveMap can dedup+merge
 * duplicate entries BEFORE semantic checks (§3.3.2 later-wins):
 *
 *   Phase 1 — `validateOverrideIdentity(input: unknown)`: check the
 *   identity fields (dataPoint present + non-empty, stationMac if
 *   present is MAC-shaped). Returns the identity or a rejection
 *   message. Runs on raw, untyped JSON.
 *
 *   Phase 2 — `validateOverrideBody(merged, identity, defaultRow)`:
 *   run runtime type checks on every remaining field, then apply the
 *   semantic rules from §3.7. Returns the fully-typed
 *   `SensorMapOverride` on success. Runs on already-merged input.
 *
 * `validateOverride(input, defaultRow)` is a convenience that composes
 * both phases for single-entry validation.
 *
 * Every check here is pure. Warnings for ignored-with-warn fields
 * are collected as a separate list so the caller can log them
 * without blocking the row.
 */

import type {
  DefaultSensorRow,
  Measurement,
  SensorKind,
  SensorMapOverride,
  SensorUnit,
} from './types.js';
import { LEGAL_UNITS_FOR_MEASUREMENT, isCompatibleKind } from './units.js';

/** Strict MAC-address regex per §3.3.1. Case-insensitive hex + colon. */
export const STATION_MAC_REGEX = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

const KNOWN_KINDS: ReadonlySet<SensorKind> = new Set<SensorKind>([
  'temperature', 'humidity', 'light', 'co2', 'co',
  'air-quality-pm25', 'air-quality-pm10',
  'motion', 'leak', 'contact', 'occupancy', 'unrecognized',
]);
const KNOWN_MEASUREMENTS: ReadonlySet<Measurement> = new Set<Measurement>([
  'temperature', 'humidity', 'illuminance', 'co2', 'co',
  'pm25', 'pm10', 'wind-speed', 'rain-rate', 'rain-accumulation',
  'pressure', 'distance', 'uv-index', 'count', 'direction',
  'timestamp', 'boolean',
]);
const KNOWN_UNITS: ReadonlySet<SensorUnit> = new Set<SensorUnit>([
  'fahrenheit', 'celsius', 'percent', 'wm2', 'lux', 'ppm', 'ugm3',
  'mph', 'kph', 'mps', 'kts', 'in_per_hr', 'mm_per_hr',
  'in', 'mm', 'inHg', 'hPa', 'mi', 'km', 'nm',
  'index', 'count', 'degrees', 'ms',
]);
const TRIGGER_DIRECTIONS: ReadonlySet<'above' | 'below'> = new Set(['above', 'below']);

export type ValidationResult =
  | { status: 'ok'; validated: SensorMapOverride; warnings: string[] }
  | { status: 'error'; message: string; warnings: string[] };

/** Identity extracted from Phase 1 validation. `stationMac` is uppercased if present. */
export interface OverrideIdentity {
  dataPoint: string;
  stationMac?: string;
}

export type IdentityResult =
  | { status: 'ok'; identity: OverrideIdentity }
  | { status: 'error'; message: string };

/**
 * Phase 1: identity-only validation. Accepts raw `unknown` (from
 * JSON) and produces the identity key that buildEffectiveMap uses
 * for dedup. Does NOT validate the body — a duplicate entry that's
 * individually incomplete may still be valid after merge.
 */
export function validateOverrideIdentity(input: unknown): IdentityResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { status: 'error', message: 'sensorMap entry is not an object; skipping.' };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.dataPoint !== 'string' || obj.dataPoint.length === 0) {
    return { status: 'error', message: 'sensorMap entry with no dataPoint; skipping.' };
  }

  const identity: OverrideIdentity = { dataPoint: obj.dataPoint };

  if (obj.stationMac !== undefined) {
    if (typeof obj.stationMac !== 'string' || !STATION_MAC_REGEX.test(obj.stationMac)) {
      return {
        status: 'error',
        message: `stationMac '${describe(obj.stationMac)}' is not a MAC address. Use the station picker.`,
      };
    }
    identity.stationMac = obj.stationMac.toUpperCase();
  }

  return { status: 'ok', identity };
}

/**
 * Phase 2: body validation on an already-merged record. Enforces
 * runtime types on every field before promoting to a typed
 * SensorMapOverride, then applies the semantic rules from §3.7.
 *
 * `merged` is the raw record after dedup+merge (still untyped). The
 * identity is passed in because Phase 1 already validated + normalized
 * it — we don't re-check.
 */
export function validateOverrideBody(
  merged: Record<string, unknown>,
  identity: OverrideIdentity,
  defaultRow: DefaultSensorRow | undefined,
): ValidationResult {
  const warnings: string[] = [];
  const dp = identity.dataPoint;

  // `wrapperId` is not part of the public schema (§3.7). Reject even
  // before we type-check anything else — its presence signals someone
  // trying to control internal state we don't expose.
  if ('wrapperId' in merged) {
    return { status: 'error', message: `wrapperId is not a valid override field on ${dp}.`, warnings };
  }

  // Runtime type checks. Build the typed override incrementally as
  // each field validates. Anything that fails a type check is an
  // error (not a warning) — we don't silently coerce untyped input.
  const out: SensorMapOverride = { dataPoint: dp };
  if (identity.stationMac !== undefined) {
    out.stationMac = identity.stationMac;
  }

  // kind: SensorKind enum value.
  if (merged.kind !== undefined) {
    if (typeof merged.kind !== 'string' || !KNOWN_KINDS.has(merged.kind as SensorKind)) {
      return { status: 'error', message: `kind '${describe(merged.kind)}' is not a valid SensorKind on ${dp}.`, warnings };
    }
    if (merged.kind === 'unrecognized') {
      warnings.push(`kind: 'unrecognized' on ${dp} ignored; unrecognized is auto-inferred.`);
    } else {
      out.kind = merged.kind as SensorKind;
    }
  }

  // measurement: Measurement enum value.
  if (merged.measurement !== undefined) {
    if (typeof merged.measurement !== 'string' || !KNOWN_MEASUREMENTS.has(merged.measurement as Measurement)) {
      return { status: 'error', message: `measurement '${describe(merged.measurement)}' is not a valid Measurement on ${dp}.`, warnings };
    }
    out.measurement = merged.measurement as Measurement;
  }

  // sourceUnit / displayUnit: SensorUnit enum values.
  if (merged.sourceUnit !== undefined) {
    if (typeof merged.sourceUnit !== 'string' || !KNOWN_UNITS.has(merged.sourceUnit as SensorUnit)) {
      return { status: 'error', message: `sourceUnit '${describe(merged.sourceUnit)}' is not a valid unit on ${dp}.`, warnings };
    }
    out.sourceUnit = merged.sourceUnit as SensorUnit;
  }
  if (merged.displayUnit !== undefined) {
    if (typeof merged.displayUnit !== 'string' || !KNOWN_UNITS.has(merged.displayUnit as SensorUnit)) {
      return { status: 'error', message: `displayUnit '${describe(merged.displayUnit)}' is not a valid unit on ${dp}.`, warnings };
    }
    out.displayUnit = merged.displayUnit as SensorUnit;
  }

  // name: non-empty string.
  if (merged.name !== undefined) {
    if (typeof merged.name !== 'string' || merged.name.length === 0) {
      return { status: 'error', message: `name on ${dp} must be a non-empty string.`, warnings };
    }
    out.name = merged.name;
  }

  // threshold: number.
  if (merged.threshold !== undefined) {
    if (typeof merged.threshold !== 'number' || !Number.isFinite(merged.threshold)) {
      return { status: 'error', message: `threshold on ${dp} must be a finite number.`, warnings };
    }
    out.threshold = merged.threshold;
  }

  // triggerEnabled: boolean.
  if (merged.triggerEnabled !== undefined) {
    if (typeof merged.triggerEnabled !== 'boolean') {
      return { status: 'error', message: `triggerEnabled on ${dp} must be a boolean.`, warnings };
    }
    out.triggerEnabled = merged.triggerEnabled;
  }

  // triggerDirection: 'above' | 'below'.
  if (merged.triggerDirection !== undefined) {
    if (typeof merged.triggerDirection !== 'string' || !TRIGGER_DIRECTIONS.has(merged.triggerDirection as 'above' | 'below')) {
      return { status: 'error', message: `triggerDirection on ${dp} must be 'above' or 'below'.`, warnings };
    }
    out.triggerDirection = merged.triggerDirection as 'above' | 'below';
  }

  // batteryField: string | null.
  if ('batteryField' in merged) {
    if (merged.batteryField !== null && (typeof merged.batteryField !== 'string' || merged.batteryField.length === 0)) {
      return { status: 'error', message: `batteryField on ${dp} must be a non-empty string or null.`, warnings };
    }
    out.batteryField = merged.batteryField as string | null;
  }

  // embedName: boolean.
  if (merged.embedName !== undefined) {
    if (typeof merged.embedName !== 'boolean') {
      return { status: 'error', message: `embedName on ${dp} must be a boolean.`, warnings };
    }
    out.embedName = merged.embedName;
  }

  // enabled: boolean.
  if (merged.enabled !== undefined) {
    if (typeof merged.enabled !== 'boolean') {
      return { status: 'error', message: `enabled on ${dp} must be a boolean.`, warnings };
    }
    out.enabled = merged.enabled;
  }

  // Now the semantic checks. `out` at this point is a typed
  // SensorMapOverride containing only the fields the user provided
  // (with unrecognized-kind stripped, per above).

  const isCustom = defaultRow === undefined;

  if (isCustom) {
    // Custom sensor: kind + measurement required, and (for numeric) sourceUnit.
    if (!out.kind) {
      return { status: 'error', message: `Custom dataPoint '${dp}' requires 'kind'.`, warnings };
    }
    if (!out.measurement) {
      return { status: 'error', message: `Custom dataPoint '${dp}' requires 'measurement'.`, warnings };
    }
    if (!isCompatibleKind(out.measurement, out.kind as Exclude<SensorKind, 'unrecognized'>)) {
      return {
        status: 'error',
        message: `kind '${out.kind}' is not compatible with measurement '${out.measurement}' on ${dp}.`,
        warnings,
      };
    }

    if (out.measurement === 'boolean') {
      if (out.sourceUnit !== undefined) {
        warnings.push(`sourceUnit on boolean row ${dp} ignored.`);
        delete out.sourceUnit;
      }
      if (out.displayUnit !== undefined) {
        warnings.push(`displayUnit on boolean row ${dp} ignored.`);
        delete out.displayUnit;
      }
    } else if (out.measurement === 'timestamp') {
      if (out.sourceUnit !== undefined && out.sourceUnit !== 'ms') {
        return { status: 'error', message: `sourceUnit on timestamp row ${dp} must be 'ms'.`, warnings };
      }
      if (out.displayUnit !== undefined) {
        warnings.push(`displayUnit on timestamp row ${dp} ignored.`);
        delete out.displayUnit;
      }
    } else {
      // Numeric.
      if (!out.sourceUnit) {
        return { status: 'error', message: `Custom numeric dataPoint '${dp}' requires 'sourceUnit'.`, warnings };
      }
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[out.measurement];
      if (!legal.includes(out.sourceUnit)) {
        return {
          status: 'error',
          message: `sourceUnit '${out.sourceUnit}' is not legal for measurement '${out.measurement}'.`,
          warnings,
        };
      }
      if (out.displayUnit !== undefined && !legal.includes(out.displayUnit)) {
        return {
          status: 'error',
          message: `displayUnit '${out.displayUnit}' is not legal for measurement '${out.measurement}'.`,
          warnings,
        };
      }
    }
  } else {
    // Known dataPoint: measurement is fixed by the default row.
    if (out.measurement !== undefined && out.measurement !== defaultRow.measurement) {
      warnings.push(
        `measurement override on known dataPoint '${dp}' ignored; measurement is fixed at ${defaultRow.measurement}.`,
      );
      delete out.measurement;
    }
    if (out.kind !== undefined) {
      if (!isCompatibleKind(defaultRow.measurement, out.kind as Exclude<SensorKind, 'unrecognized'>)) {
        return {
          status: 'error',
          message: `kind '${out.kind}' is not compatible with the built-in measurement '${defaultRow.measurement}' on ${dp}.`,
          warnings,
        };
      }
    }
    if (out.sourceUnit !== undefined && out.sourceUnit !== defaultRow.sourceUnit) {
      warnings.push(
        `sourceUnit override on known dataPoint '${dp}' ignored; source unit is fixed at ${defaultRow.sourceUnit}.`,
      );
      delete out.sourceUnit;
    }
    if (out.displayUnit !== undefined) {
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[defaultRow.measurement];
      if (!legal.includes(out.displayUnit)) {
        return {
          status: 'error',
          message: `displayUnit '${out.displayUnit}' is not legal for measurement '${defaultRow.measurement}' on ${dp}.`,
          warnings,
        };
      }
    }
  }

  // Motion-only fields — ignored-with-warn on non-motion kinds, AND
  // stripped from `out` so buildEffectiveMap never sees them. That
  // enforces §3.7's "ignored with warn, row still loads" contract
  // literally rather than trusting downstream to re-check.
  const effectiveKind = out.kind ?? defaultRow?.kind;
  if (effectiveKind && effectiveKind !== 'motion') {
    if (out.threshold !== undefined) {
      warnings.push(`threshold on non-motion row ${dp} ignored.`);
      delete out.threshold;
    }
    if (out.triggerEnabled !== undefined) {
      warnings.push(`triggerEnabled on non-motion row ${dp} ignored.`);
      delete out.triggerEnabled;
    }
    if (out.triggerDirection !== undefined) {
      warnings.push(`triggerDirection on non-motion row ${dp} ignored.`);
      delete out.triggerDirection;
    }
    if (out.embedName === true) {
      warnings.push(`embedName on non-motion row ${dp} ignored.`);
      delete out.embedName;
    }
  }

  return { status: 'ok', validated: out, warnings };
}

/**
 * Convenience: compose Phase 1 + Phase 2 for single-entry
 * validation. buildEffectiveMap uses the phases directly so it can
 * dedup+merge between them; simpler callers use this.
 */
export function validateOverride(
  input: unknown,
  defaultRow: DefaultSensorRow | undefined,
): ValidationResult {
  const identity = validateOverrideIdentity(input);
  if (identity.status === 'error') {
    return { status: 'error', message: identity.message, warnings: [] };
  }
  return validateOverrideBody(input as Record<string, unknown>, identity.identity, defaultRow);
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

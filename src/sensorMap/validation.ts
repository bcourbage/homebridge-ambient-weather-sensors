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
 * Warnings are structured (`OverrideWarning` — code + field +
 * message) rather than plain strings so buildEffectiveMap can
 * attribute them to the specific merge fragment responsible and so
 * the UI can dedupe on `code` + `field` without parsing text.
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

/**
 * The 13 fields users may set on a SensorMapOverride. Any key outside
 * this set on a hand-edited entry is a typo (e.g. `triggerEnabledd`)
 * or an attempt to control internal state we don't expose. Reject
 * loudly so users find the mistake instead of watching their config
 * silently do nothing.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'dataPoint', 'stationMac',
  'kind', 'measurement',
  'name',
  'threshold', 'triggerEnabled', 'triggerDirection',
  'displayUnit', 'sourceUnit',
  'batteryField', 'embedName', 'enabled',
]);

/**
 * Structured warning — code + optional field + message. `code`
 * identifies the warning class for machine consumers; `field` names
 * the offending SensorMapOverride field when applicable. Text form
 * is `message`.
 */
export interface OverrideWarning {
  code: string;
  field?: string;
  message: string;
}

/**
 * ValidationResult's error variant is FLAT: `code`, `field`, `message`
 * live directly on the result. This preserves the pre-refactor
 * `result.message` API (tests + docs still read it) while giving
 * callers the structured `code` + `field` they need for per-field
 * error attribution.
 *
 * `field` is set for field-scoped rejections and identifies the
 * fragment whose value caused the rejection via the merge provenance
 * map. For row-scope failures (missing required field, kind ×
 * measurement incompatibility) it's undefined. For the unknown-key
 * cases (`unknown-key`, `wrapper-id-forbidden`) it holds the
 * offending input key even though that key is outside the
 * SensorMapOverride vocabulary — the merge provenance map records
 * every input key, so this still routes attribution correctly.
 */
export type ValidationResult =
  | { status: 'ok'; validated: SensorMapOverride; warnings: OverrideWarning[] }
  | {
      status: 'error';
      code: string;
      field?: string;
      message: string;
      warnings: OverrideWarning[];
    };

/** Identity extracted from Phase 1 validation. `stationMac` is uppercased if present. */
export interface OverrideIdentity {
  dataPoint: string;
  stationMac?: string;
}

export type IdentityResult =
  | { status: 'ok'; identity: OverrideIdentity }
  | { status: 'error'; message: string };

/**
 * Small helper: build a field-scoped or row-scope error return in one
 * expression. `field` is the SensorMapOverride field the failure is
 * about (undefined for row-scope failures like a missing required
 * field or an unknown key). `warnings` is the ValidateResult's
 * warnings accumulator, threaded through so pre-error warnings still
 * surface on rejection.
 */
function err(
  code: string,
  message: string,
  warnings: OverrideWarning[],
  field?: string,
): ValidationResult {
  return { status: 'error', code, field, message, warnings };
}

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
  const warnings: OverrideWarning[] = [];
  const dp = identity.dataPoint;

  // `wrapperId` is not part of the public schema (§3.7). Reject
  // ahead of the general unknown-key check because it has a
  // dedicated, actionable error message. Pass the offending key
  // as `field` so buildEffectiveMap's per-fragment provenance can
  // attribute the error to the fragment that actually contained
  // `wrapperId`, not the last fragment. `field` here means "the
  // input key responsible for the rejection" — that includes keys
  // outside the SensorMapOverride vocabulary.
  if ('wrapperId' in merged) {
    return err(
      'wrapper-id-forbidden',
      `wrapperId is not a valid override field on ${dp}.`,
      warnings,
      'wrapperId',
    );
  }

  // Reject any other unknown key. Hand-edited configs typo field
  // names (`triggerEnabledd`, `embed_name`, etc.) and JSON schema
  // won't catch it. Better to fail loudly than silently discard.
  //
  // The offending key is passed as `field` so the fragment that
  // introduced it (recorded in the merge provenance map) gets the
  // blame, not the merge-winning last fragment.
  for (const key of Object.keys(merged)) {
    if (!ALLOWED_KEYS.has(key)) {
      return err(
        'unknown-key',
        `Unknown override field '${key}' on ${dp}. Check for typos.`,
        warnings,
        key,
      );
    }
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
      return err('invalid-kind', `kind '${describe(merged.kind)}' is not a valid SensorKind on ${dp}.`, warnings, 'kind');
    }
    if (merged.kind === 'unrecognized') {
      warnings.push({
        code: 'ignored-unrecognized-kind',
        field: 'kind',
        message: `kind: 'unrecognized' on ${dp} ignored; unrecognized is auto-inferred.`,
      });
    } else {
      out.kind = merged.kind as SensorKind;
    }
  }

  // measurement: Measurement enum value.
  if (merged.measurement !== undefined) {
    if (typeof merged.measurement !== 'string' || !KNOWN_MEASUREMENTS.has(merged.measurement as Measurement)) {
      return err('invalid-measurement', `measurement '${describe(merged.measurement)}' is not a valid Measurement on ${dp}.`, warnings, 'measurement');
    }
    out.measurement = merged.measurement as Measurement;
  }

  // sourceUnit / displayUnit: SensorUnit enum values.
  if (merged.sourceUnit !== undefined) {
    if (typeof merged.sourceUnit !== 'string' || !KNOWN_UNITS.has(merged.sourceUnit as SensorUnit)) {
      return err('invalid-sourceunit', `sourceUnit '${describe(merged.sourceUnit)}' is not a valid unit on ${dp}.`, warnings, 'sourceUnit');
    }
    out.sourceUnit = merged.sourceUnit as SensorUnit;
  }
  if (merged.displayUnit !== undefined) {
    if (typeof merged.displayUnit !== 'string' || !KNOWN_UNITS.has(merged.displayUnit as SensorUnit)) {
      return err('invalid-displayunit', `displayUnit '${describe(merged.displayUnit)}' is not a valid unit on ${dp}.`, warnings, 'displayUnit');
    }
    out.displayUnit = merged.displayUnit as SensorUnit;
  }

  // name: non-empty string.
  if (merged.name !== undefined) {
    if (typeof merged.name !== 'string' || merged.name.length === 0) {
      return err('invalid-name', `name on ${dp} must be a non-empty string.`, warnings, 'name');
    }
    out.name = merged.name;
  }

  // threshold: number.
  if (merged.threshold !== undefined) {
    if (typeof merged.threshold !== 'number' || !Number.isFinite(merged.threshold)) {
      return err('invalid-threshold', `threshold on ${dp} must be a finite number.`, warnings, 'threshold');
    }
    out.threshold = merged.threshold;
  }

  // triggerEnabled: boolean.
  if (merged.triggerEnabled !== undefined) {
    if (typeof merged.triggerEnabled !== 'boolean') {
      return err('invalid-triggerenabled', `triggerEnabled on ${dp} must be a boolean.`, warnings, 'triggerEnabled');
    }
    out.triggerEnabled = merged.triggerEnabled;
  }

  // triggerDirection: 'above' | 'below'.
  if (merged.triggerDirection !== undefined) {
    if (typeof merged.triggerDirection !== 'string' || !TRIGGER_DIRECTIONS.has(merged.triggerDirection as 'above' | 'below')) {
      return err('invalid-triggerdirection', `triggerDirection on ${dp} must be 'above' or 'below'.`, warnings, 'triggerDirection');
    }
    out.triggerDirection = merged.triggerDirection as 'above' | 'below';
  }

  // batteryField: string | null.
  if ('batteryField' in merged) {
    if (merged.batteryField !== null && (typeof merged.batteryField !== 'string' || merged.batteryField.length === 0)) {
      return err('invalid-batteryfield', `batteryField on ${dp} must be a non-empty string or null.`, warnings, 'batteryField');
    }
    out.batteryField = merged.batteryField as string | null;
  }

  // embedName: boolean.
  if (merged.embedName !== undefined) {
    if (typeof merged.embedName !== 'boolean') {
      return err('invalid-embedname', `embedName on ${dp} must be a boolean.`, warnings, 'embedName');
    }
    out.embedName = merged.embedName;
  }

  // enabled: boolean.
  if (merged.enabled !== undefined) {
    if (typeof merged.enabled !== 'boolean') {
      return err('invalid-enabled', `enabled on ${dp} must be a boolean.`, warnings, 'enabled');
    }
    out.enabled = merged.enabled;
  }

  // Now the semantic checks. `out` at this point is a typed
  // SensorMapOverride containing only the fields the user provided
  // (with unrecognized-kind stripped, per above).

  const isCustom = defaultRow === undefined;

  // Effective measurement — what the row's measurement will be after
  // resolving overrides against defaults. Applied BEFORE the
  // known/custom branch so timestamp/boolean shape normalization
  // fires consistently regardless of whether the measurement comes
  // from the built-in default or the user's override.
  const effectiveMeasurement: Measurement | undefined = isCustom
    ? out.measurement
    : defaultRow.measurement;

  // Measurement-shape normalization. Applies to both known and
  // custom rows — timestamp rows must have sourceUnit === 'ms' or
  // absent; boolean rows accept no units.
  if (effectiveMeasurement === 'boolean') {
    if (out.sourceUnit !== undefined) {
      warnings.push({
        code: 'ignored-boolean-sourceunit',
        field: 'sourceUnit',
        message: `sourceUnit on boolean row ${dp} ignored.`,
      });
      delete out.sourceUnit;
    }
    if (out.displayUnit !== undefined) {
      warnings.push({
        code: 'ignored-boolean-displayunit',
        field: 'displayUnit',
        message: `displayUnit on boolean row ${dp} ignored.`,
      });
      delete out.displayUnit;
    }
  } else if (effectiveMeasurement === 'timestamp') {
    if (out.sourceUnit !== undefined && out.sourceUnit !== 'ms') {
      return err(
        'invalid-timestamp-sourceunit',
        `sourceUnit on timestamp row ${dp} must be 'ms'.`,
        warnings,
        'sourceUnit',
      );
    }
    if (out.displayUnit !== undefined) {
      warnings.push({
        code: 'ignored-timestamp-displayunit',
        field: 'displayUnit',
        message: `displayUnit on timestamp row ${dp} ignored.`,
      });
      delete out.displayUnit;
    }
  }

  if (isCustom) {
    // Custom sensor: kind + measurement required.
    if (!out.kind) {
      return err('custom-missing-kind', `Custom dataPoint '${dp}' requires 'kind'.`, warnings, 'kind');
    }
    if (!out.measurement) {
      return err('custom-missing-measurement', `Custom dataPoint '${dp}' requires 'measurement'.`, warnings, 'measurement');
    }
    if (!isCompatibleKind(out.measurement, out.kind as Exclude<SensorKind, 'unrecognized'>)) {
      // Kind × measurement incompatibility — row-scope failure. Both
      // fields are consistent within themselves; the row is rejected
      // as a unit.
      return err(
        'incompatible-kind-measurement',
        `kind '${out.kind}' is not compatible with measurement '${out.measurement}' on ${dp}.`,
        warnings,
      );
    }

    // Numeric measurements need a sourceUnit; already-normalized
    // boolean/timestamp above don't fall through here.
    if (out.measurement !== 'boolean' && out.measurement !== 'timestamp') {
      if (!out.sourceUnit) {
        return err('custom-missing-sourceunit', `Custom numeric dataPoint '${dp}' requires 'sourceUnit'.`, warnings, 'sourceUnit');
      }
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[out.measurement];
      if (!legal.includes(out.sourceUnit)) {
        return err(
          'illegal-sourceunit-for-measurement',
          `sourceUnit '${out.sourceUnit}' is not legal for measurement '${out.measurement}'.`,
          warnings,
          'sourceUnit',
        );
      }
      if (out.displayUnit !== undefined && !legal.includes(out.displayUnit)) {
        return err(
          'illegal-displayunit-for-measurement',
          `displayUnit '${out.displayUnit}' is not legal for measurement '${out.measurement}'.`,
          warnings,
          'displayUnit',
        );
      }
    }
  } else {
    // Known dataPoint: measurement is fixed by the default row.
    if (out.measurement !== undefined && out.measurement !== defaultRow.measurement) {
      warnings.push({
        code: 'ignored-measurement-fixed',
        field: 'measurement',
        message: `measurement override on known dataPoint '${dp}' ignored; measurement is fixed at ${defaultRow.measurement}.`,
      });
      delete out.measurement;
    }
    if (out.kind !== undefined) {
      if (!isCompatibleKind(defaultRow.measurement, out.kind as Exclude<SensorKind, 'unrecognized'>)) {
        return err(
          'incompatible-kind-for-known-measurement',
          `kind '${out.kind}' is not compatible with the built-in measurement '${defaultRow.measurement}' on ${dp}.`,
          warnings,
          'kind',
        );
      }
    }
    if (out.sourceUnit !== undefined && out.sourceUnit !== defaultRow.sourceUnit) {
      warnings.push({
        code: 'ignored-sourceunit-fixed',
        field: 'sourceUnit',
        message: `sourceUnit override on known dataPoint '${dp}' ignored; source unit is fixed at ${defaultRow.sourceUnit}.`,
      });
      delete out.sourceUnit;
    }
    if (out.displayUnit !== undefined) {
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[defaultRow.measurement];
      if (!legal.includes(out.displayUnit)) {
        return err(
          'illegal-displayunit-for-known-measurement',
          `displayUnit '${out.displayUnit}' is not legal for measurement '${defaultRow.measurement}' on ${dp}.`,
          warnings,
          'displayUnit',
        );
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
      warnings.push({
        code: 'ignored-non-motion-threshold',
        field: 'threshold',
        message: `threshold on non-motion row ${dp} ignored.`,
      });
      delete out.threshold;
    }
    if (out.triggerEnabled !== undefined) {
      warnings.push({
        code: 'ignored-non-motion-triggerenabled',
        field: 'triggerEnabled',
        message: `triggerEnabled on non-motion row ${dp} ignored.`,
      });
      delete out.triggerEnabled;
    }
    if (out.triggerDirection !== undefined) {
      warnings.push({
        code: 'ignored-non-motion-triggerdirection',
        field: 'triggerDirection',
        message: `triggerDirection on non-motion row ${dp} ignored.`,
      });
      delete out.triggerDirection;
    }
    if (out.embedName === true) {
      warnings.push({
        code: 'ignored-non-motion-embedname',
        field: 'embedName',
        message: `embedName on non-motion row ${dp} ignored.`,
      });
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
    // Identity failures are row-scope by definition (the entry has
    // no valid identity to hang a field-scoped error on).
    return { status: 'error', code: 'invalid-identity', message: identity.message, warnings: [] };
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

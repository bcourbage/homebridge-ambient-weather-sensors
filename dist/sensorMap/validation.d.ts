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
import type { DefaultSensorRow, SensorMapOverride } from './types.js';
/** Strict MAC-address regex per §3.3.1. Case-insensitive hex + colon. */
export declare const STATION_MAC_REGEX: RegExp;
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
 * Structured error — code + optional field + message. `field` is set
 * for field-scoped rejections (a specific SensorMapOverride field
 * failed a type or semantic check) so buildEffectiveMap can attribute
 * to the fragment that sourced its value via the same per-field
 * provenance map used for warnings. Row-scope failures (missing
 * required field, unknown key, incompatible kind × measurement)
 * carry `field: undefined`.
 */
export interface OverrideError {
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
 */
export type ValidationResult = {
    status: 'ok';
    validated: SensorMapOverride;
    warnings: OverrideWarning[];
} | {
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
export type IdentityResult = {
    status: 'ok';
    identity: OverrideIdentity;
} | {
    status: 'error';
    message: string;
};
/**
 * Phase 1: identity-only validation. Accepts raw `unknown` (from
 * JSON) and produces the identity key that buildEffectiveMap uses
 * for dedup. Does NOT validate the body — a duplicate entry that's
 * individually incomplete may still be valid after merge.
 */
export declare function validateOverrideIdentity(input: unknown): IdentityResult;
/**
 * Phase 2: body validation on an already-merged record. Enforces
 * runtime types on every field before promoting to a typed
 * SensorMapOverride, then applies the semantic rules from §3.7.
 *
 * `merged` is the raw record after dedup+merge (still untyped). The
 * identity is passed in because Phase 1 already validated + normalized
 * it — we don't re-check.
 */
export declare function validateOverrideBody(merged: Record<string, unknown>, identity: OverrideIdentity, defaultRow: DefaultSensorRow | undefined): ValidationResult;
/**
 * Convenience: compose Phase 1 + Phase 2 for single-entry
 * validation. buildEffectiveMap uses the phases directly so it can
 * dedup+merge between them; simpler callers use this.
 */
export declare function validateOverride(input: unknown, defaultRow: DefaultSensorRow | undefined): ValidationResult;
//# sourceMappingURL=validation.d.ts.map
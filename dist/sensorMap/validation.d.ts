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
import type { DefaultSensorRow, SensorMapOverride } from './types.js';
/** Strict MAC-address regex per §3.3.1. Case-insensitive hex + colon. */
export declare const STATION_MAC_REGEX: RegExp;
export type ValidationResult = {
    status: 'ok';
    validated: SensorMapOverride;
    warnings: string[];
} | {
    status: 'error';
    message: string;
    warnings: string[];
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
/**
 * Row-level validation for user-authored SensorMapOverride entries.
 *
 * See docs/future/sensor-map.md §3.7 for the full failure table.
 *
 * Two return shapes:
 *   - `{ status: 'ok' }`: entry passes; caller merges it into the map
 *   - `{ status: 'error', message }`: entry rejected; caller records
 *     a RowValidationError and skips the entry (rest of the map still
 *     loads — row-level failures never fail the plugin)
 *
 * Every check here is pure. Warns for ignored-with-warn fields
 * (§3.7 "Ignored with warn" rows) are collected as a separate list
 * so the caller can log them but they DON'T block the row.
 */
import type { DefaultSensorRow, SensorMapOverride } from './types.js';
/** Strict MAC-address regex per §3.3.1. Case-insensitive hex + colon. */
export declare const STATION_MAC_REGEX: RegExp;
export type ValidationResult = {
    status: 'ok';
    warnings: string[];
} | {
    status: 'error';
    message: string;
    warnings: string[];
};
/**
 * Validate one SensorMapOverride entry against the plugin's known
 * defaults. `defaultRow` is the row from DEFAULT_SENSOR_MAP matching
 * the override's dataPoint, or undefined if the dataPoint is custom.
 */
export declare function validateOverride(override: SensorMapOverride, defaultRow: DefaultSensorRow | undefined): ValidationResult;
//# sourceMappingURL=validation.d.ts.map
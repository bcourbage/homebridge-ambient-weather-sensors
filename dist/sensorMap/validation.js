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
import { LEGAL_UNITS_FOR_MEASUREMENT, isCompatibleKind } from './units.js';
/** Strict MAC-address regex per §3.3.1. Case-insensitive hex + colon. */
export const STATION_MAC_REGEX = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
/**
 * Validate one SensorMapOverride entry against the plugin's known
 * defaults. `defaultRow` is the row from DEFAULT_SENSOR_MAP matching
 * the override's dataPoint, or undefined if the dataPoint is custom.
 */
export function validateOverride(override, defaultRow) {
    const warnings = [];
    // dataPoint required.
    if (!override.dataPoint || typeof override.dataPoint !== 'string' || override.dataPoint.length === 0) {
        return err('sensorMap entry with no dataPoint; skipping', warnings);
    }
    // stationMac: absent or MAC-formatted.
    if (override.stationMac !== undefined) {
        if (typeof override.stationMac !== 'string' || !STATION_MAC_REGEX.test(override.stationMac)) {
            return err(`stationMac '${override.stationMac}' is not a MAC address. Use the station picker.`, warnings);
        }
    }
    // User cannot explicitly set kind: 'unrecognized'.
    if (override.kind === 'unrecognized') {
        warnings.push(`kind: 'unrecognized' on ${override.dataPoint} ignored; unrecognized is auto-inferred.`);
    }
    // `wrapperId` is not part of the public schema (§3.7).
    if ('wrapperId' in override) {
        return err(`wrapperId is not a valid override field on ${override.dataPoint}.`, warnings);
    }
    const isCustom = defaultRow === undefined;
    if (isCustom) {
        // Custom sensor: kind + measurement required, and (for numeric) sourceUnit.
        if (!override.kind || override.kind === 'unrecognized') {
            return err(`Custom dataPoint '${override.dataPoint}' requires 'kind'.`, warnings);
        }
        if (!override.measurement) {
            return err(`Custom dataPoint '${override.dataPoint}' requires 'measurement'.`, warnings);
        }
        // kind/measurement must be compatible (§3.8).
        if (!isCompatibleKind(override.measurement, override.kind)) {
            return err(`kind '${override.kind}' is not compatible with measurement '${override.measurement}' on ${override.dataPoint}.`, warnings);
        }
        // Per-measurement-shape rules.
        if (override.measurement === 'boolean') {
            if (override.sourceUnit !== undefined) {
                warnings.push(`sourceUnit on boolean row ${override.dataPoint} ignored.`);
            }
            if (override.displayUnit !== undefined) {
                warnings.push(`displayUnit on boolean row ${override.dataPoint} ignored.`);
            }
        }
        else if (override.measurement === 'timestamp') {
            if (override.sourceUnit !== undefined && override.sourceUnit !== 'ms') {
                return err(`sourceUnit on timestamp row ${override.dataPoint} must be 'ms'.`, warnings);
            }
            if (override.displayUnit !== undefined) {
                warnings.push(`displayUnit on timestamp row ${override.dataPoint} ignored.`);
            }
        }
        else {
            // Numeric.
            if (!override.sourceUnit) {
                return err(`Custom numeric dataPoint '${override.dataPoint}' requires 'sourceUnit'.`, warnings);
            }
            const legalSrc = LEGAL_UNITS_FOR_MEASUREMENT[override.measurement];
            if (!legalSrc.includes(override.sourceUnit)) {
                return err(`sourceUnit '${override.sourceUnit}' is not legal for measurement '${override.measurement}'.`, warnings);
            }
            if (override.displayUnit !== undefined && !legalSrc.includes(override.displayUnit)) {
                return err(`displayUnit '${override.displayUnit}' is not legal for measurement '${override.measurement}'.`, warnings);
            }
        }
    }
    else {
        // Known dataPoint: measurement is fixed by the default row.
        if (override.measurement !== undefined && override.measurement !== defaultRow.measurement) {
            warnings.push(`measurement override on known dataPoint '${override.dataPoint}' ignored; measurement is fixed at ${defaultRow.measurement}.`);
        }
        // kind override permitted only within compatible set.
        if (override.kind && override.kind !== 'unrecognized') {
            if (!isCompatibleKind(defaultRow.measurement, override.kind)) {
                return err(`kind '${override.kind}' is not compatible with the built-in measurement '${defaultRow.measurement}' on ${override.dataPoint}.`, warnings);
            }
        }
        // sourceUnit is fixed for known datapoints.
        if (override.sourceUnit !== undefined && override.sourceUnit !== defaultRow.sourceUnit) {
            warnings.push(`sourceUnit override on known dataPoint '${override.dataPoint}' ignored; source unit is fixed at ${defaultRow.sourceUnit}.`);
        }
        // displayUnit override permitted if legal for the measurement.
        if (override.displayUnit !== undefined) {
            const legal = LEGAL_UNITS_FOR_MEASUREMENT[defaultRow.measurement];
            if (!legal.includes(override.displayUnit)) {
                return err(`displayUnit '${override.displayUnit}' is not legal for measurement '${defaultRow.measurement}' on ${override.dataPoint}.`, warnings);
            }
        }
    }
    // Motion-only fields ignored-with-warn on non-motion kinds.
    const effectiveKind = override.kind ?? defaultRow?.kind;
    if (effectiveKind && effectiveKind !== 'motion') {
        if (override.threshold !== undefined) {
            warnings.push(`threshold on non-motion row ${override.dataPoint} ignored.`);
        }
        if (override.triggerEnabled !== undefined) {
            warnings.push(`triggerEnabled on non-motion row ${override.dataPoint} ignored.`);
        }
        if (override.triggerDirection !== undefined) {
            warnings.push(`triggerDirection on non-motion row ${override.dataPoint} ignored.`);
        }
        if (override.embedName === true) {
            warnings.push(`embedName on non-motion row ${override.dataPoint} ignored.`);
        }
    }
    return { status: 'ok', warnings };
}
function err(message, warnings) {
    return { status: 'error', message, warnings };
}
//# sourceMappingURL=validation.js.map
/**
 * Platform-level effective-map assembly (finding-#4 Stage 4).
 *
 * A PURE function: given the already-loaded persistence stores, the
 * station inventory, the detected config mode, and the raw config, it
 * selects the right `userOverrides` source and calls
 * `buildEffectiveSensorMap`. It performs NO I/O — persistence loading and
 * every lifecycle mutation (register / restore / instantiate) stay in
 * `platform.ts`. This keeps the assembly independently unit-testable and
 * shared across the legacy, v2, and safe-mode config shapes.
 *
 * Override-source selection per mode (mirrors the retired shadow
 * observer's `onParseTick`, now the single source of truth for the live
 * path):
 *
 *   - `legacy`    → synthesise overrides from the v1.7 config via the
 *                   compat layer (`compatToOverrides`), passing the
 *                   station inventory so include/exclude get their full
 *                   seven-candidate v1 semantics.
 *   - `v2`        → read `config.sensorMap` as a raw array. A non-array
 *                   value is a hand-edit mistake; treat it as empty (the
 *                   caller surfaces the validation-free divergence
 *                   separately) rather than coercing silently.
 *   - `safe-mode` → no overrides. `buildEffectiveSensorMap` returns an
 *                   empty map for safe mode anyway; the platform never
 *                   drives reconciliation in safe mode, so this branch is
 *                   for completeness/testability.
 */
import { buildEffectiveSensorMap } from './buildEffectiveMap.js';
import { compatToOverrides } from './compat.js';
/**
 * Select the `userOverrides` array for the detected config mode. Pure.
 */
export function selectUserOverrides(config, configMode, stations) {
    if (configMode === 'safe-mode') {
        return [];
    }
    if (configMode === 'v2') {
        const raw = config.sensorMap;
        return Array.isArray(raw) ? raw : [];
    }
    // legacy
    return compatToOverrides(config, stations);
}
/**
 * Assemble the effective sensor map at the platform boundary. Pure — the
 * caller has already loaded `discovery` / `uiState` from disk.
 */
export function buildPlatformEffectiveMap(inputs) {
    const userOverrides = selectUserOverrides(inputs.config, inputs.configMode, inputs.stations);
    return buildEffectiveSensorMap({
        userOverrides,
        discovery: inputs.discovery,
        uiState: inputs.uiState,
        stations: inputs.stations,
        configMode: inputs.configMode,
    });
}
//# sourceMappingURL=platformEffectiveMap.js.map
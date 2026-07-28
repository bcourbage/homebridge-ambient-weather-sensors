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
import { compatToOverrides, type LegacyConfig } from './compat.js';
import type { ConfigMode } from './configMode.js';
import type {
  DiscoveryStore,
  EffectiveSensorMap,
  StationInventory,
  UiStateStore,
} from './types.js';

/** Config surface the assembler inspects — legacy toggles + the v2 `sensorMap`. */
export type EffectiveMapConfig = LegacyConfig & { sensorMap?: unknown };

export interface EffectiveMapInputs {
  config: EffectiveMapConfig;
  configMode: ConfigMode;
  stations: StationInventory;
  discovery: DiscoveryStore;
  uiState: UiStateStore;
}

/**
 * Detect a malformed v2 `sensorMap` (review finding 6). In v2 mode an
 * ABSENT sensorMap is legitimate — §5's "start from v2 defaults" — but
 * a PRESENT non-array value (string, object, number, null) is a
 * hand-edit mistake. Silently coercing it to `[]` would expose the
 * FULL default map: dozens of accessories the user never configured,
 * registered off a config error. Returns the error message to surface,
 * or undefined when the shape is fine. The caller must treat a
 * non-undefined result as a cache-preserving hard stop (no
 * reconciliation), not a warning.
 */
export function sensorMapShapeError(
  config: EffectiveMapConfig,
  configMode: ConfigMode,
): string | undefined {
  if (configMode !== 'v2') {
    return undefined;
  }
  const raw = config.sensorMap;
  if (raw === undefined || Array.isArray(raw)) {
    return undefined;
  }
  const shape = raw === null ? 'null' : typeof raw;
  return `configVersion: 2 is set but sensorMap is ${shape}, not an array. `
    + 'This configuration cannot be interpreted safely: reconciliation is DISABLED so your cached '
    + 'accessories are preserved (treating the malformed sensorMap as empty would instead register '
    + 'the full default exposure). Fix or remove the sensorMap field and restart Homebridge.';
}

/**
 * Select the `userOverrides` array for the detected config mode. Pure.
 * v2 callers must have already gated on `sensorMapShapeError` — by the
 * time this runs, a v2 sensorMap is either absent (default exposure)
 * or a real array.
 */
export function selectUserOverrides(
  config: EffectiveMapConfig,
  configMode: ConfigMode,
  stations: StationInventory,
): ReadonlyArray<unknown> {
  if (configMode === 'safe-mode') {
    return [];
  }
  if (configMode === 'v2') {
    const raw = config.sensorMap;
    return Array.isArray(raw) ? (raw as unknown[]) : [];
  }
  // legacy
  return compatToOverrides(config as LegacyConfig, stations);
}

/**
 * Assemble the effective sensor map at the platform boundary. Pure — the
 * caller has already loaded `discovery` / `uiState` from disk.
 */
export function buildPlatformEffectiveMap(inputs: EffectiveMapInputs): EffectiveSensorMap {
  const userOverrides = selectUserOverrides(inputs.config, inputs.configMode, inputs.stations);
  return buildEffectiveSensorMap({
    userOverrides,
    discovery: inputs.discovery,
    uiState: inputs.uiState,
    stations: inputs.stations,
    configMode: inputs.configMode,
  });
}

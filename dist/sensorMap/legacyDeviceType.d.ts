/**
 * wrapperId → v1.7 `context.device.type` bridge (finding-#4 Stage 4).
 *
 * The row-driven v2 reconciler instantiates wrappers by `wrapperId` (via
 * `instantiateWrapper`), NOT by the legacy `context.device.type` string
 * that `createSensorWrapper` switches on. But the cached `context.device`
 * MUST keep a v1.7-compatible `type` so that DOWNGRADING the plugin back
 * to a v1.7 code path finds a `type` its `createSensorWrapper`/
 * `determineSensorType` vocabulary recognises and can rebuild — otherwise
 * a known cached accessory would be stranded (unrecognised type →
 * `createSensorWrapper` returns undefined → no wrapper) on downgrade.
 *
 * These strings are exactly the values `determineSensorType` returns and
 * `createSensorWrapper` switches on in `platform.ts`. `Record<WrapperId,
 * string>` forces exhaustiveness — adding a wrapper id without a legacy
 * type mapping fails to compile.
 */
import type { WrapperId } from './types.js';
export declare const LEGACY_TYPE_FOR_WRAPPER_ID: Record<WrapperId, string>;
/** Legacy `context.device.type` for a resolved row's wrapper id. */
export declare function legacyTypeForWrapperId(wrapperId: WrapperId): string;
//# sourceMappingURL=legacyDeviceType.d.ts.map
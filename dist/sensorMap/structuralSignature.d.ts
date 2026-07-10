/**
 * Structural signature — a human-readable string that captures the
 * HAP-service-graph identity of an effective row.
 *
 * See docs/future/sensor-map.md §9. Rows whose signature differs
 * between runs must be re-registered (unregister-and-add); rows
 * whose signature matches can be updated in place.
 *
 * Uses stable wrapper `id` (not `constructor.name`) so a TS class
 * rename doesn't invalidate every user's accessory cache.
 */
import type { EffectiveSensorRow, WrapperDescriptor } from './types.js';
export declare const UNRECOGNIZED_SIGNATURE = "unrecognized";
export declare function computeStructuralSignature(kind: EffectiveSensorRow['kind'], measurement: string, hasBatterySubService: boolean, wrapper: WrapperDescriptor): string;
//# sourceMappingURL=structuralSignature.d.ts.map
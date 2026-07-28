import type { PlatformAccessory } from 'homebridge';
import type { BatteryServiceOptions } from '../batteryService.js';
import type { EffectiveSensorRow } from './types.js';
/**
 * Translate a resolved row into the row-driven `setupBatteryService`
 * contract (finding-#4 Stage 2), or `undefined` for the legacy
 * telemetry-gated path when no row is present.
 *
 * `attach` is `row.hasBatterySubService` — a structural property of the
 * effective map, so the Battery sub-service exists iff the row owns the
 * field, independent of whether AWN reported the battery on the
 * discovery tick. The seed prefers a cached reading
 * (`context.device.batteryLow`) and falls back to `'unknown'` (NORMAL
 * placeholder) until the first real `setBatteryLow` arrives.
 *
 * Unrecognized rows have no battery sub-service and never reach a
 * wrapper; the guard returns `undefined` (legacy path) defensively.
 */
export declare function batteryOptionsFor(row: EffectiveSensorRow | undefined, accessory: PlatformAccessory): BatteryServiceOptions | undefined;
//# sourceMappingURL=batterySeed.d.ts.map
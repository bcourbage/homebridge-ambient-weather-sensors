/**
 * Shared row-aware battery-field resolver (finding-#4 Stage 4, final
 * commit — design doc "Battery sub-service lifecycle", piece 4).
 *
 * Every runtime battery READ resolves its field through this single
 * function so polling, realtime, and the v2 distribution boundary agree
 * on which AWN `batt*` (or custom) field a sensor's Battery sub-service
 * follows:
 *
 * - **With an effective map** (v2 mode): the row for `(stationMac,
 *   dataPoint)` is the sole authority. The field is returned only when
 *   the row actually OWNS a Battery sub-service after ownership
 *   adjudication (`hasBatterySubService && batteryField`). A collision
 *   loser, a row whose owner suppressed the field (`batteryField:
 *   null`), or a dataPoint absent from the map resolves to `null` —
 *   deliberately NOT the legacy fallback, which would resurrect exactly
 *   the field the map removed.
 * - **Without an effective map** (legacy flag-off paths): falls back to
 *   v1.6.0's static `batteryFieldForSensor(dataPoint)` lookup, so the
 *   flag-off behavior is byte-identical to v1.7.0.
 *
 * The "0 = low" AWN convention is unchanged — callers keep converting
 * via `readBatteryLow`, which consumes the field name this returns.
 */

import { batteryFieldForSensor } from '../batteryFields.js';
import type { EffectiveSensorMap } from './types.js';

export function resolveBatteryField(
  effectiveMap: EffectiveSensorMap | undefined,
  stationMac: string,
  dataPoint: string,
): string | null {
  if (!effectiveMap) {
    return batteryFieldForSensor(dataPoint) ?? null;
  }
  const mac = stationMac.toUpperCase();
  const row = effectiveMap.rows.find(
    r => r.stationMac.toUpperCase() === mac && r.dataPoint === dataPoint,
  );
  if (!row || row.kind === 'unrecognized') {
    return null;
  }
  return row.hasBatterySubService && row.batteryField ? row.batteryField : null;
}

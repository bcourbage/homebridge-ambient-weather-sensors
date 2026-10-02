import { PlatformAccessory } from 'homebridge';

import type { AmbientWeatherSensorsPlatform } from './platform.js';

/**
 * Attach a `Battery` sub-service to an existing sensor accessory and
 * return a callback that updates the low/normal state on each
 * subsequent reading. Returns undefined when this sensor's probe
 * doesn't report a battery (i.e. `accessory.context.device.batteryLow`
 * is undefined) — caller should skip the Battery sub-service in
 * that case.
 *
 * Apple Home's automation framework triggers low-battery push
 * notifications off the `StatusLowBattery` characteristic
 * specifically, so that's the one users care about. The other two
 * characteristics HAP requires on a Battery service are filled in
 * to keep the tile sensible:
 *
 *   - ChargingState     → NOT_CHARGEABLE (AWN sensors are battery-only)
 *   - BatteryLevel      → 5% when low, 100% when normal. AWN doesn't
 *                         report an actual percentage — these are
 *                         display-only sentinels chosen so the
 *                         Home.app tile shows an alarming bar when
 *                         the battery is low.
 *
 * Adding the Battery service to an existing sensor accessory makes
 * it a sub-service rather than its own tile, matching HomeKit's
 * convention for battery-powered devices (the same way an Eve
 * Motion sensor exposes its own battery).
 */
/**
 * Row-driven attach contract (finding-#4 Stage 2). Under the row model
 * the HAP graph is a property of the effective map, NOT of transient
 * telemetry — a row whose signature says `battery:1` must get a Battery
 * sub-service even if AWN happened to omit the field on the discovery
 * tick. Callers that have a resolved row pass this shape:
 *
 *   - `attach`: `row.hasBatterySubService` — attach unconditionally
 *     when true; remove any existing sub-service when false.
 *   - `initialLow`: the seed value. `'unknown'` (no usable reading)
 *     seeds HAP's NORMAL placeholder ONLY on a FRESH service; on a
 *     RESTORED service it PRESERVES the retained characteristics, so
 *     an unknown reading never invents a healthy state (PR #67 review
 *     R2-F3). A real boolean reading (and the first real
 *     `setBatteryLow`) seed/override it either way.
 */
export interface BatteryServiceOptions {
  attach: boolean;
  initialLow: boolean | 'unknown';
}

export function setupBatteryService(
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  options?: BatteryServiceOptions,
): ((low: boolean) => void) | undefined {
  // Row-driven contract: attach is a structural decision from the
  // effective map, decoupled from whether telemetry reported the field.
  if (options) {
    if (!options.attach) {
      removeBatteryService(platform, accessory);
      return undefined;
    }
    // Pass the 'unknown' distinction through so a cached restart with
    // no usable reading PRESERVES the retained battery state instead of
    // inventing a healthy one (PR #67 review R2-F3).
    return attachBatteryService(platform, accessory, options.initialLow);
  }

  // Legacy telemetry-gated contract (v1.6.0 live path). Attach iff AWN
  // reported a battery for this probe on the discovery tick.
  const initialLow: boolean | undefined = accessory.context.device.batteryLow;
  if (initialLow === undefined) {
    // No battery reported for this sensor's probe — skip the
    // sub-service entirely. Also cleanup: if a previous version of
    // the plugin attached a Battery sub-service here (v1.5.0-beta.1
    // through beta.12 attached a Battery sub-service to every
    // probe-backed accessory, before the per-probe dedup added in
    // beta.13), remove the stale sub-service from the cached
    // accessory so it disappears from HomeKit on next restart.
    removeBatteryService(platform, accessory);
    return undefined;
  }
  return attachBatteryService(platform, accessory, initialLow);
}

function removeBatteryService(
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
): void {
  const existing = accessory.getService(platform.Service.Battery);
  if (existing) {
    accessory.removeService(existing);
  }
}

function attachBatteryService(
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  initialLow: boolean | 'unknown',
): (low: boolean) => void {
  const existing = accessory.getService(platform.Service.Battery);
  const service = existing || accessory.addService(platform.Service.Battery);

  const StatusLow = platform.Characteristic.StatusLowBattery;
  const ChargingState = platform.Characteristic.ChargingState;

  // ChargingState is constant; safe to (re)assert so the char always
  // exists in the graph.
  service.setCharacteristic(ChargingState, ChargingState.NOT_CHARGEABLE);

  if (initialLow === 'unknown') {
    // No usable reading. On a FRESH service (no history) seed the
    // NORMAL/100 placeholder; on a RESTORED service PRESERVE the
    // retained low/normal state — an unknown reading must never
    // overwrite an established low-battery warning with an invented
    // healthy observation (PR #67 review R2-F3). The first real
    // setBatteryLow (a valid reading) updates it either way.
    if (!existing) {
      service
        .setCharacteristic(StatusLow, StatusLow.BATTERY_LEVEL_NORMAL)
        .setCharacteristic(platform.Characteristic.BatteryLevel, 100);
    }
  } else {
    // A real reading seeds/overrides the retained state.
    service
      .setCharacteristic(
        StatusLow,
        initialLow ? StatusLow.BATTERY_LEVEL_LOW : StatusLow.BATTERY_LEVEL_NORMAL,
      )
      .setCharacteristic(platform.Characteristic.BatteryLevel, initialLow ? 5 : 100);
  }

  return (low: boolean) => {
    service
      .updateCharacteristic(
        StatusLow,
        low ? StatusLow.BATTERY_LEVEL_LOW : StatusLow.BATTERY_LEVEL_NORMAL,
      )
      .updateCharacteristic(platform.Characteristic.BatteryLevel, low ? 5 : 100);
  };
}

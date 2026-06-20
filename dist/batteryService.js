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
export function setupBatteryService(platform, accessory) {
    const initialLow = accessory.context.device.batteryLow;
    if (initialLow === undefined) {
        // No battery reported for this sensor's probe — skip the
        // sub-service entirely. Also cleanup: if a previous version of
        // the plugin attached a Battery sub-service here (v1.5.0-beta.1
        // through beta.12 attached a Battery sub-service to every
        // probe-backed accessory, before the per-probe dedup added in
        // beta.13), remove the stale sub-service from the cached
        // accessory so it disappears from HomeKit on next restart.
        const existing = accessory.getService(platform.Service.Battery);
        if (existing) {
            accessory.removeService(existing);
        }
        return undefined;
    }
    const service = accessory.getService(platform.Service.Battery)
        || accessory.addService(platform.Service.Battery);
    const StatusLow = platform.Characteristic.StatusLowBattery;
    const ChargingState = platform.Characteristic.ChargingState;
    // Seed all three required characteristics on first attach.
    service
        .setCharacteristic(ChargingState, ChargingState.NOT_CHARGEABLE)
        .setCharacteristic(StatusLow, initialLow ? StatusLow.BATTERY_LEVEL_LOW : StatusLow.BATTERY_LEVEL_NORMAL)
        .setCharacteristic(platform.Characteristic.BatteryLevel, initialLow ? 5 : 100);
    return (low) => {
        service
            .updateCharacteristic(StatusLow, low ? StatusLow.BATTERY_LEVEL_LOW : StatusLow.BATTERY_LEVEL_NORMAL)
            .updateCharacteristic(platform.Characteristic.BatteryLevel, low ? 5 : 100);
    };
}
//# sourceMappingURL=batteryService.js.map
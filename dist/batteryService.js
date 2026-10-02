export function setupBatteryService(platform, accessory, options) {
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
    const initialLow = accessory.context.device.batteryLow;
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
function removeBatteryService(platform, accessory) {
    const existing = accessory.getService(platform.Service.Battery);
    if (existing) {
        accessory.removeService(existing);
    }
}
function attachBatteryService(platform, accessory, initialLow) {
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
    }
    else {
        // A real reading seeds/overrides the retained state.
        service
            .setCharacteristic(StatusLow, initialLow ? StatusLow.BATTERY_LEVEL_LOW : StatusLow.BATTERY_LEVEL_NORMAL)
            .setCharacteristic(platform.Characteristic.BatteryLevel, initialLow ? 5 : 100);
    }
    return (low) => {
        service
            .updateCharacteristic(StatusLow, low ? StatusLow.BATTERY_LEVEL_LOW : StatusLow.BATTERY_LEVEL_NORMAL)
            .updateCharacteristic(platform.Characteristic.BatteryLevel, low ? 5 : 100);
    };
}
//# sourceMappingURL=batteryService.js.map
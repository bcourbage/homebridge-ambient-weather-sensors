export type DEVICE = {
    macAddress: string;
    uniqueId: string;
    displayName: string;
    value: number;
    type: string;
    /**
     * Battery state of this sensor's physical probe, derived from AWN's
     * batt* field that corresponds to the same hardware module (e.g.
     * `tempf` → `battout`, `tempinf` → `battin`, `temp1f` → `batt1`,
     * `lightning_*` → `batt_lightning`, `*_aqin` → `batt_co2`).
     *
     * undefined → AWN does not report a battery for this sensor's
     *             probe (or the field is missing from the payload).
     *             The wrapper skips the Battery sub-service entirely.
     * true       → battery is low (AWN reports the batt field as 0).
     * false      → battery is normal (AWN reports the batt field as 1).
     *
     * AWN's batt* field convention is 0 = low / 1 = good — opposite of
     * HomeKit's BATTERY_LEVEL_LOW boolean intuition. The platform
     * inverts at the parseDevices boundary so wrappers see the
     * HomeKit-aligned meaning.
     */
    batteryLow?: boolean;
};
//# sourceMappingURL=types.d.ts.map
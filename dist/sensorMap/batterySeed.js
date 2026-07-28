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
export function batteryOptionsFor(row, accessory) {
    if (!row || row.kind === 'unrecognized') {
        return undefined;
    }
    const cached = accessory.context.device.batteryLow;
    return {
        attach: row.hasBatterySubService,
        initialLow: typeof cached === 'boolean' ? cached : 'unknown',
    };
}
//# sourceMappingURL=batterySeed.js.map
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
export const UNRECOGNIZED_SIGNATURE = 'unrecognized';
export function computeStructuralSignature(kind, measurement, hasBatterySubService, wrapper) {
    if (kind === 'unrecognized') {
        return UNRECOGNIZED_SIGNATURE;
    }
    const battery = hasBatterySubService ? '1' : '0';
    return `${kind}|measurement:${measurement}|battery:${battery}|wrapper:${wrapper.id}:v${wrapper.schemaVersion}`;
}
//# sourceMappingURL=structuralSignature.js.map
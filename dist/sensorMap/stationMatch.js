/**
 * Normalize a config-supplied string for matching against sensor
 * identifiers. Trims whitespace and lowercases. Empty / non-string
 * values normalize to the empty string, which the caller is expected
 * to filter out.
 */
export function normalizeMatchKey(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : '';
}
/**
 * Build a Set of normalized matchers from a config-supplied array.
 * Used for `stationFilter`, `excludeSensors`, and `includeOnly`; the
 * same matching rules apply to all (case-insensitive,
 * whitespace-trimmed, non-string and blank entries dropped).
 */
export function toMatcherSet(raw) {
    const out = new Set();
    if (!Array.isArray(raw)) {
        return out;
    }
    for (const entry of raw) {
        const k = normalizeMatchKey(entry);
        if (k.length > 0) {
            out.add(k);
        }
    }
    return out;
}
/**
 * Apply a stationFilter to a station INVENTORY with the runtime's
 * matching rules (station name OR MAC, case-insensitive,
 * whitespace-trimmed). An empty or absent filter passes everything —
 * exactly applyStationFilterV2's semantics, minus the logging.
 */
export function filterStationInventory(inventory, stationFilter) {
    const matchers = toMatcherSet(stationFilter);
    if (matchers.size === 0) {
        return inventory;
    }
    return inventory.filter(s => (normalizeMatchKey(s.name).length > 0 && matchers.has(normalizeMatchKey(s.name)))
        || (normalizeMatchKey(s.macAddress).length > 0 && matchers.has(normalizeMatchKey(s.macAddress))));
}
//# sourceMappingURL=stationMatch.js.map
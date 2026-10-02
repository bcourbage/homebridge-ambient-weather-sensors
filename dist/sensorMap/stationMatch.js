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
 * Names are recorded per field. A partial observation after a rename must
 * outrank older siblings, not whichever entry happens to be iterated last.
 * Equal-time conflicting names are indeterminate, never a guessed filter
 * exclusion. Equivalent spellings use a deterministic lexical tie-break.
 */
export function latestDiscoveryStationNames(entries) {
    const newest = new Map();
    for (const entry of entries) {
        const seen = Date.parse(entry.lastSeen);
        if (!Number.isFinite(seen) || !normalizeMatchKey(entry.stationName)) {
            continue;
        }
        const mac = entry.stationMac.toUpperCase();
        const prior = newest.get(mac);
        if (!prior || seen > prior.seen) {
            newest.set(mac, { seen, name: entry.stationName });
        }
        else if (seen === prior.seen && prior.name !== undefined) {
            if (normalizeMatchKey(prior.name) !== normalizeMatchKey(entry.stationName)) {
                prior.name = undefined;
            }
            else if (entry.stationName < prior.name) {
                prior.name = entry.stationName;
            }
        }
    }
    const names = new Map();
    for (const [mac, entry] of newest) {
        if (entry.name !== undefined) {
            names.set(mac, entry.name);
        }
    }
    return names;
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
/** MAC-shaped matcher entry (the always-determinate filter form). */
const MAC_FORM = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
/**
 * Stations whose membership under `stationFilter` is INDETERMINATE at
 * editor time (PR #60 round 3 P1): the filter carries name-form
 * entries, and the station's name is unknown in the assembled
 * inventory (cached-accessory or override-derived stations carry no
 * name) — the runtime will evaluate the same filter AFTER fetching,
 * with the real name. Interpreting the unknown name as a non-match
 * could hide structural consequences from the preview, so callers
 * refuse instead. A station a MAC-form entry matches is determinate
 * (included) regardless of its name; a filter with only MAC-form
 * entries is always determinate.
 */
export function indeterminateFilterStations(inventory, stationFilter) {
    const matchers = toMatcherSet(stationFilter);
    if (matchers.size === 0) {
        return [];
    }
    const hasNameForm = [...matchers].some(m => !MAC_FORM.test(m));
    if (!hasNameForm) {
        return [];
    }
    return inventory.filter(s => normalizeMatchKey(s.name).length === 0
        && !matchers.has(normalizeMatchKey(s.macAddress)));
}
//# sourceMappingURL=stationMatch.js.map
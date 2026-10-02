/** Factual cache inventory. Never manufacture a discovery observation. */
import { STATION_MAC_REGEX } from './validation.js';
/** The persisted accessory identity is MAC-dataPoint; the data point may contain hyphens. */
export function cachedPairFromUniqueId(value) {
    if (typeof value !== 'string' || value.length < 19 || value[17] !== '-') {
        return undefined;
    }
    const mac = value.slice(0, 17);
    if (!STATION_MAC_REGEX.test(mac)) {
        return undefined;
    }
    return { stationMac: mac.toUpperCase(), dataPoint: value.slice(18) };
}
export function cachedPairsFromUniqueIds(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    const pairs = new Map();
    for (const value of values) {
        const pair = cachedPairFromUniqueId(value);
        if (pair) {
            pairs.set(`${pair.stationMac}|${pair.dataPoint}`, pair);
        }
    }
    return [...pairs.values()];
}
//# sourceMappingURL=cachedInventory.js.map
export interface CachedFieldPair {
    stationMac: string;
    dataPoint: string;
}
/** The persisted accessory identity is MAC-dataPoint; the data point may contain hyphens. */
export declare function cachedPairFromUniqueId(value: unknown): CachedFieldPair | undefined;
export declare function cachedPairsFromUniqueIds(values: unknown): CachedFieldPair[];
//# sourceMappingURL=cachedInventory.d.ts.map
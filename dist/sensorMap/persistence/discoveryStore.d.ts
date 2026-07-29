/**
 * DiscoveryStore reader/writer + in-memory tracker.
 *
 * See docs/future/sensor-map.md §8.3. Plugin-only writes.
 *
 * The tracker holds the current snapshot in memory and writes to
 * disk under two conditions:
 *   1. **Structural change** — new (stationMac, dataPoint) pair
 *      observed. Immediate flush; the effective-map layer relies
 *      on this to surface unrecognized rows to the UI.
 *   2. **lastSeen tick** — an existing pair reported again. Flushed
 *      no more often than `DISCOVERY_LAST_SEEN_INTERVAL_MS` (default
 *      15 minutes). Avoids write amplification on every AWN poll.
 *
 * `flush(force=true)` is the SIGTERM-time drain — called by the
 * platform layer on graceful shutdown.
 *
 * `lastValue` is NOT persisted (in-memory only; UI queries the
 * platform for a live snapshot).
 */
import type { DiscoveryStore } from '../types.js';
import { cleanupStaleTempFiles, type Clock, type Logger } from './atomicWrite.js';
export declare const DISCOVERY_FILE = "discovery.json";
export declare const DISCOVERY_LAST_SEEN_INTERVAL_MS: number;
export declare function emptyDiscoveryStore(): DiscoveryStore;
export declare function loadDiscoveryStore(filePath: string, log: Logger, clock?: Clock): Promise<DiscoveryStore>;
export declare function saveDiscoveryStore(filePath: string, store: DiscoveryStore, log: Logger): Promise<void>;
interface TrackerOptions {
    filePath: string;
    log: Logger;
    clock?: Clock;
    /** For testing — override the 15-minute cadence. */
    lastSeenIntervalMs?: number;
    initial?: DiscoveryStore;
}
/**
 * In-memory + on-disk discovery tracker. Records observations
 * synchronously; writes to disk asynchronously with throttling.
 */
export declare class DiscoveryTracker {
    private readonly entries;
    private readonly log;
    private readonly clock;
    private readonly filePath;
    private readonly lastSeenIntervalMs;
    private lastFlushAt;
    private pendingLastSeenOnly;
    private pendingStructural;
    private writeChain;
    constructor(opts: TrackerOptions);
    /**
     * Record an observation. Returns true if this call would trigger a
     * structural-change (new pair) flush; false if it's just a lastSeen
     * tick.
     */
    observe(stationMac: string, stationName: string, dataPoint: string): boolean;
    /**
     * Return the current in-memory store shape. Callers pass this to
     * buildEffectiveSensorMap.
     */
    snapshot(): DiscoveryStore;
    /**
     * Flush to disk if a write is due. `force: true` bypasses the
     * lastSeen THROTTLE (SIGTERM path) — but not the no-pending check: a
     * flush (forced or not) queued behind one that already persisted
     * every pending observation returns without a redundant write
     * (review R5-3). Fire-and-forget by default — errors log a warn but
     * don't propagate; callers who need to observe completion await the
     * return value.
     */
    flush(force?: boolean): Promise<void>;
    /**
     * The serialized body — only ever one execution in flight, in strict
     * enqueue order. Pending state and the snapshot are read AT THIS
     * FLUSH'S TURN, so a queued flush behind a write that already
     * persisted everything simply returns, and a write can never carry an
     * older snapshot than a write queued before it.
     */
    private doFlush;
}
export { cleanupStaleTempFiles };
//# sourceMappingURL=discoveryStore.d.ts.map
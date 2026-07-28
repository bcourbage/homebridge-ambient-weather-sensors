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
import { cleanupStaleTempFiles, readJsonStore, writeJsonStore, REAL_CLOCK, } from './atomicWrite.js';
export const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_LAST_SEEN_INTERVAL_MS = 15 * 60 * 1000;
function isDiscoveryStore(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return false;
    }
    const r = raw;
    if (r.schemaVersion !== 1) {
        return false;
    }
    if (!Array.isArray(r.entries)) {
        return false;
    }
    for (const e of r.entries) {
        if (typeof e !== 'object' || e === null) {
            return false;
        }
        const ee = e;
        if (typeof ee.stationMac !== 'string' || typeof ee.dataPoint !== 'string'
            || typeof ee.firstSeen !== 'string' || typeof ee.lastSeen !== 'string'
            || typeof ee.stationName !== 'string') {
            return false;
        }
    }
    return true;
}
export function emptyDiscoveryStore() {
    return { schemaVersion: 1, entries: [] };
}
export async function loadDiscoveryStore(filePath, log, clock = REAL_CLOCK) {
    const loaded = await readJsonStore(filePath, isDiscoveryStore, log, clock);
    return loaded ?? emptyDiscoveryStore();
}
export async function saveDiscoveryStore(filePath, store, log) {
    await writeJsonStore(filePath, store, log);
}
/**
 * In-memory + on-disk discovery tracker. Records observations
 * synchronously; writes to disk asynchronously with throttling.
 */
export class DiscoveryTracker {
    constructor(opts) {
        this.entries = new Map();
        this.lastFlushAt = 0;
        this.pendingLastSeenOnly = false;
        // Structural work (a NEW pair observed) pending a write. Tracked
        // SEPARATELY from lastSeen-only work (review R3-7): a tick that
        // contains both an existing observation and a new pair previously set
        // `pendingLastSeenOnly`, and the throttle then deferred the STRUCTURAL
        // discovery too — leaving it memory-only until the 15-minute window
        // or shutdown (lost entirely on a crash). Structural work always
        // flushes immediately.
        this.pendingStructural = false;
        this.inflight = null;
        this.filePath = opts.filePath;
        this.log = opts.log;
        this.clock = opts.clock ?? REAL_CLOCK;
        this.lastSeenIntervalMs = opts.lastSeenIntervalMs ?? DISCOVERY_LAST_SEEN_INTERVAL_MS;
        if (opts.initial) {
            for (const e of opts.initial.entries) {
                this.entries.set(key(e.stationMac, e.dataPoint), { ...e });
            }
        }
    }
    /**
     * Record an observation. Returns true if this call would trigger a
     * structural-change (new pair) flush; false if it's just a lastSeen
     * tick.
     */
    observe(stationMac, stationName, dataPoint) {
        const macUp = stationMac.toUpperCase();
        const k = key(macUp, dataPoint);
        const existing = this.entries.get(k);
        const iso = this.clock.iso();
        if (!existing) {
            this.entries.set(k, {
                stationMac: macUp,
                stationName,
                dataPoint,
                firstSeen: iso,
                lastSeen: iso,
            });
            this.pendingStructural = true;
            return true;
        }
        existing.lastSeen = iso;
        existing.stationName = stationName; // Keep display name fresh.
        this.pendingLastSeenOnly = true;
        return false;
    }
    /**
     * Return the current in-memory store shape. Callers pass this to
     * buildEffectiveSensorMap.
     */
    snapshot() {
        return {
            schemaVersion: 1,
            entries: [...this.entries.values()].map(e => ({ ...e })),
        };
    }
    /**
     * Flush to disk if a write is due. `force: true` bypasses throttling
     * (SIGTERM path). Fire-and-forget by default — errors log a warn but
     * don't propagate; callers who need to observe completion await the
     * return value.
     */
    async flush(force = false) {
        // Serialize concurrent flushes.
        if (this.inflight) {
            await this.inflight;
            if (!force && !this.pendingLastSeenOnly && !this.pendingStructural) {
                return;
            }
        }
        const now = this.clock.now();
        // The 15-minute throttle applies ONLY to lastSeen-only work.
        // Structural discoveries (new pairs) always write immediately —
        // even when the same tick also refreshed existing entries (R3-7).
        if (!force && !this.pendingStructural && this.pendingLastSeenOnly) {
            if (now - this.lastFlushAt < this.lastSeenIntervalMs) {
                return;
            }
        }
        // Capture-and-clear the pending flags SYNCHRONOUSLY, in the same
        // tick the snapshot is taken. Clearing them when the write FINISHES
        // (the previous shape) lost updates: an observe() landing between
        // this write's snapshot and its completion would set a flag that
        // the completion then wiped — a structural discovery could vanish
        // from the pending state without ever reaching disk (surfaced by
        // the R3-7 tests). On failure the captured work is restored.
        const hadLastSeen = this.pendingLastSeenOnly;
        const hadStructural = this.pendingStructural;
        this.pendingLastSeenOnly = false;
        this.pendingStructural = false;
        const p = (async () => {
            try {
                await saveDiscoveryStore(this.filePath, this.snapshot(), this.log);
                this.lastFlushAt = now;
            }
            catch (e) {
                this.pendingLastSeenOnly = this.pendingLastSeenOnly || hadLastSeen;
                this.pendingStructural = this.pendingStructural || hadStructural;
                this.log.warn(`Discovery store flush failed: ${e.message}`);
            }
        })();
        this.inflight = p;
        try {
            await p;
        }
        finally {
            this.inflight = null;
        }
    }
}
function key(mac, dp) {
    return `${mac}|${dp}`;
}
// Re-export cleanup for the platform-startup wrapper (Stage 7).
export { cleanupStaleTempFiles };
//# sourceMappingURL=discoveryStore.js.map
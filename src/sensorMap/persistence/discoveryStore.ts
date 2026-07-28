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

import type {
  DiscoveredFieldRecord,
  DiscoveryStore,
} from '../types.js';
import {
  cleanupStaleTempFiles,
  readJsonStore,
  writeJsonStore,
  type Clock,
  type Logger,
  REAL_CLOCK,
} from './atomicWrite.js';

export const DISCOVERY_FILE = 'discovery.json';
export const DISCOVERY_LAST_SEEN_INTERVAL_MS = 15 * 60 * 1000;

function isDiscoveryStore(raw: unknown): raw is DiscoveryStore {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const r = raw as Record<string, unknown>;
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
    const ee = e as Record<string, unknown>;
    if (typeof ee.stationMac !== 'string' || typeof ee.dataPoint !== 'string'
        || typeof ee.firstSeen !== 'string' || typeof ee.lastSeen !== 'string'
        || typeof ee.stationName !== 'string') {
      return false;
    }
  }
  return true;
}

export function emptyDiscoveryStore(): DiscoveryStore {
  return { schemaVersion: 1, entries: [] };
}

export async function loadDiscoveryStore(filePath: string, log: Logger, clock: Clock = REAL_CLOCK): Promise<DiscoveryStore> {
  const loaded = await readJsonStore<DiscoveryStore>(filePath, isDiscoveryStore, log, clock);
  return loaded ?? emptyDiscoveryStore();
}

export async function saveDiscoveryStore(filePath: string, store: DiscoveryStore, log: Logger): Promise<void> {
  await writeJsonStore(filePath, store, log);
}

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
export class DiscoveryTracker {
  private readonly entries: Map<string, DiscoveredFieldRecord> = new Map();
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly filePath: string;
  private readonly lastSeenIntervalMs: number;
  private lastFlushAt = 0;
  private pendingLastSeenOnly = false;
  // Structural work (a NEW pair observed) pending a write. Tracked
  // SEPARATELY from lastSeen-only work (review R3-7): a tick that
  // contains both an existing observation and a new pair previously set
  // `pendingLastSeenOnly`, and the throttle then deferred the STRUCTURAL
  // discovery too — leaving it memory-only until the 15-minute window
  // or shutdown (lost entirely on a crash). Structural work always
  // flushes immediately.
  private pendingStructural = false;
  // Write MUTEX (review R4-1): every flush is appended to this promise
  // chain, so at most ONE write is ever in flight and writes land in
  // strict enqueue order. The previous await-the-inflight-then-proceed
  // shape released ALL waiters at once — a normal poll flush and
  // shutdown's forced flush could both start writes after the same
  // await, and the OLDER snapshot could finish last, overwriting the
  // newer one on disk. Each queued flush re-evaluates pending state and
  // takes its snapshot only when its turn comes, so it always writes
  // the newest state (or returns because a predecessor already did).
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: TrackerOptions) {
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
  observe(stationMac: string, stationName: string, dataPoint: string): boolean {
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
  snapshot(): DiscoveryStore {
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
  async flush(force = false): Promise<void> {
    // Append to the write chain (mutex). `.catch` on the tail keeps a
    // failed write from poisoning the chain for later flushes; the
    // returned promise still reflects THIS flush's outcome (doFlush
    // logs its own failures and never rejects).
    const run = this.writeChain.then(() => this.doFlush(force));
    this.writeChain = run.catch(() => { /* never rejects; belt-and-suspenders */ });
    return run;
  }

  /**
   * The serialized body — only ever one execution in flight, in strict
   * enqueue order. Pending state and the snapshot are read AT THIS
   * FLUSH'S TURN, so a queued flush behind a write that already
   * persisted everything simply returns, and a write can never carry an
   * older snapshot than a write queued before it.
   */
  private async doFlush(force: boolean): Promise<void> {
    const now = this.clock.now();
    if (!force) {
      if (!this.pendingStructural && !this.pendingLastSeenOnly) {
        // Nothing pending — a predecessor in the chain already wrote it.
        return;
      }
      // The 15-minute throttle applies ONLY to lastSeen-only work.
      // Structural discoveries (new pairs) always write immediately —
      // even when the same tick also refreshed existing entries (R3-7).
      if (!this.pendingStructural && now - this.lastFlushAt < this.lastSeenIntervalMs) {
        return;
      }
    }

    // Capture-and-clear the pending flags SYNCHRONOUSLY, in the same
    // tick the snapshot is taken (R3-7): an observe() landing during
    // the write sets fresh flags that the next queued flush picks up.
    // On failure the captured work is restored so it isn't lost.
    const hadLastSeen = this.pendingLastSeenOnly;
    const hadStructural = this.pendingStructural;
    this.pendingLastSeenOnly = false;
    this.pendingStructural = false;
    try {
      await saveDiscoveryStore(this.filePath, this.snapshot(), this.log);
      this.lastFlushAt = now;
    } catch (e) {
      this.pendingLastSeenOnly = this.pendingLastSeenOnly || hadLastSeen;
      this.pendingStructural = this.pendingStructural || hadStructural;
      this.log.warn(`Discovery store flush failed: ${(e as Error).message}`);
    }
  }
}

function key(mac: string, dp: string): string {
  return `${mac}|${dp}`;
}

// Re-export cleanup for the platform-startup wrapper (Stage 7).
export { cleanupStaleTempFiles };

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
  private inflight: Promise<void> | null = null;

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
    // Serialize concurrent flushes.
    if (this.inflight) {
      await this.inflight;
      if (!force && !this.pendingLastSeenOnly) {
        return;
      }
    }

    const now = this.clock.now();
    if (!force && this.pendingLastSeenOnly) {
      if (now - this.lastFlushAt < this.lastSeenIntervalMs) {
        return;
      }
    }

    const p = (async () => {
      try {
        await saveDiscoveryStore(this.filePath, this.snapshot(), this.log);
        this.lastFlushAt = now;
        this.pendingLastSeenOnly = false;
      } catch (e) {
        this.log.warn(`Discovery store flush failed: ${(e as Error).message}`);
      }
    })();
    this.inflight = p;
    try {
      await p;
    } finally {
      this.inflight = null;
    }
  }
}

function key(mac: string, dp: string): string {
  return `${mac}|${dp}`;
}

// Re-export cleanup for the platform-startup wrapper (Stage 7).
export { cleanupStaleTempFiles };

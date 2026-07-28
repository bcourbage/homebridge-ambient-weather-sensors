import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock, Logger } from '../../../../src/sensorMap/persistence/atomicWrite';
import {
  DiscoveryTracker,
  emptyDiscoveryStore,
  loadDiscoveryStore,
  saveDiscoveryStore,
} from '../../../../src/sensorMap/persistence/discoveryStore';

const silentLog: Logger = {
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  debug: () => { /* noop */ },
};

class FakeClock implements Clock {
  private t = Date.parse('2026-07-09T20:00:00Z');
  now(): number { return this.t; }
  iso(): string { return new Date(this.t).toISOString(); }
  advanceMs(ms: number): void { this.t += ms; }
}

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-disc-')); });
afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('loadDiscoveryStore / saveDiscoveryStore', () => {
  it('returns empty store on first call (no file)', async () => {
    const s = await loadDiscoveryStore(path.join(tmpRoot, 'discovery.json'), silentLog);
    expect(s).toEqual(emptyDiscoveryStore());
  });

  it('round-trips a populated store', async () => {
    const p = path.join(tmpRoot, 'discovery.json');
    const store = {
      schemaVersion: 1 as const,
      entries: [{
        stationMac: 'AA:BB:CC:DD:EE:01',
        stationName: 'Home',
        dataPoint: 'tempf',
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-09T21:00:00.000Z',
      }],
    };
    await saveDiscoveryStore(p, store, silentLog);
    const loaded = await loadDiscoveryStore(p, silentLog);
    expect(loaded).toEqual(store);
  });

  it('quarantines a file with an entry missing required fields', async () => {
    const p = path.join(tmpRoot, 'discovery.json');
    await fs.writeFile(p, JSON.stringify({
      schemaVersion: 1,
      entries: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf' /* missing firstSeen/lastSeen */ }],
    }), 'utf8');
    const s = await loadDiscoveryStore(p, silentLog);
    expect(s).toEqual(emptyDiscoveryStore());
  });
});

describe('DiscoveryTracker', () => {
  it('reports true (structural change) for a new pair', () => {
    const t = new DiscoveryTracker({ filePath: path.join(tmpRoot, 'd.json'), log: silentLog });
    expect(t.observe('aa:bb:cc:dd:ee:01', 'Home', 'tempf')).toBe(true);
    expect(t.observe('aa:bb:cc:dd:ee:01', 'Home', 'tempf')).toBe(false);
  });

  it('uppercases stationMac in the snapshot', () => {
    const t = new DiscoveryTracker({ filePath: path.join(tmpRoot, 'd.json'), log: silentLog });
    t.observe('aa:bb:cc:dd:ee:01', 'Home', 'tempf');
    const snap = t.snapshot();
    expect(snap.entries[0].stationMac).toBe('AA:BB:CC:DD:EE:01');
  });

  it('flush persists the current snapshot immediately for new pairs', async () => {
    const p = path.join(tmpRoot, 'd.json');
    const t = new DiscoveryTracker({ filePath: p, log: silentLog });
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush();
    const loaded = await loadDiscoveryStore(p, silentLog);
    expect(loaded.entries).toHaveLength(1);
  });

  it('throttles lastSeen-only updates below the interval', async () => {
    const p = path.join(tmpRoot, 'd.json');
    const clock = new FakeClock();
    const t = new DiscoveryTracker({
      filePath: p,
      log: silentLog,
      clock,
      lastSeenIntervalMs: 60_000,
    });
    // Initial write: structural change.
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush();
    const firstSeen = (await loadDiscoveryStore(p, silentLog)).entries[0].lastSeen;

    // A bit later: same pair.
    clock.advanceMs(30_000);
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush(); // Should NOT write (below interval).
    const stillFirstSeen = (await loadDiscoveryStore(p, silentLog)).entries[0].lastSeen;
    expect(stillFirstSeen).toBe(firstSeen);

    // Past the interval.
    clock.advanceMs(31_000);
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush();
    const bumped = (await loadDiscoveryStore(p, silentLog)).entries[0].lastSeen;
    expect(bumped).not.toBe(firstSeen);
  });

  it('force=true flushes even when throttling would suppress', async () => {
    const p = path.join(tmpRoot, 'd.json');
    const clock = new FakeClock();
    const t = new DiscoveryTracker({
      filePath: p,
      log: silentLog,
      clock,
      lastSeenIntervalMs: 60_000,
    });
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush();
    const before = (await loadDiscoveryStore(p, silentLog)).entries[0].lastSeen;

    clock.advanceMs(5_000);
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush(true);
    const after = (await loadDiscoveryStore(p, silentLog)).entries[0].lastSeen;
    expect(after).not.toBe(before);
  });

  it('preserves initial state passed to the constructor', () => {
    const t = new DiscoveryTracker({
      filePath: path.join(tmpRoot, 'd.json'),
      log: silentLog,
      initial: {
        schemaVersion: 1,
        entries: [{
          stationMac: 'AA:BB:CC:DD:EE:01',
          stationName: 'Home',
          dataPoint: 'tempf',
          firstSeen: '2026-07-01T00:00:00.000Z',
          lastSeen: '2026-07-01T00:00:00.000Z',
        }],
      },
    });
    // Same pair should NOT be structural change.
    expect(t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf')).toBe(false);
  });
});

describe('DiscoveryTracker — structural flush is never throttled (review R3-7)', () => {
  it('a mixed tick (existing observation + NEW pair) writes immediately inside the throttle window', async () => {
    const p = path.join(tmpRoot, 'd.json');
    const clock = new FakeClock();
    const t = new DiscoveryTracker({ filePath: p, log: silentLog, clock, lastSeenIntervalMs: 60_000 });

    // Establish the baseline entry + first flush.
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush();

    // WELL inside the throttle window: the same tick refreshes the
    // existing entry (sets lastSeen-only work) AND discovers a new pair.
    clock.advanceMs(1_000);
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');       // existing → lastSeen-only
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'brand_new');   // NEW → structural
    await t.flush();                                       // not forced

    const onDisk = await loadDiscoveryStore(p, silentLog);
    expect(onDisk.entries.some(e => e.dataPoint === 'brand_new')).toBe(true);
  });

  it('lastSeen-only work is still throttled', async () => {
    const p = path.join(tmpRoot, 'd.json');
    const clock = new FakeClock();
    const t = new DiscoveryTracker({ filePath: p, log: silentLog, clock, lastSeenIntervalMs: 60_000 });

    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');
    await t.flush();
    const before = (await fs.stat(p)).mtimeMs;

    clock.advanceMs(1_000);
    t.observe('AA:BB:CC:DD:EE:01', 'Home', 'tempf');       // existing only
    await t.flush();
    expect((await fs.stat(p)).mtimeMs).toBe(before);        // throttled, no write
  });
});

describe('DiscoveryTracker — write serialization (review R4-1)', () => {
  it('overlapping normal + forced flushes never overwrite a newer snapshot with an older one', async () => {
    const p = path.join(tmpRoot, 'd.json');
    const t = new DiscoveryTracker({ filePath: p, log: silentLog });

    // Deterministic delayed-rename harness: hold the FIRST write's
    // rename open while more observations and flushes pile up, record
    // every write's payload size and the max rename concurrency.
    const realRename = fs.rename.bind(fs);
    let inFlight = 0;
    let maxInFlight = 0;
    const payloadSizes: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let renameCalls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation((async (src: string, dest: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const body = JSON.parse(await fs.readFile(src, 'utf8')) as { entries: unknown[] };
        payloadSizes.push(body.entries.length);
        renameCalls += 1;
        if (renameCalls === 1) {
          await firstGate;                    // hold write #1 mid-flight
        }
        return await realRename(src, dest);
      } finally {
        inFlight -= 1;
      }
    }) as never);

    try {
      // Write #1 starts (snapshot: [a]) and stalls at its rename.
      t.observe('AA:BB:CC:DD:EE:01', 'Home', 'a');
      const f1 = t.flush();
      // Observation lands DURING the in-flight write...
      t.observe('AA:BB:CC:DD:EE:01', 'Home', 'b');
      // ...and both a normal poll flush and a shutdown-style forced
      // flush arrive while write #1 is still open — the exact overlap
      // that previously released both waiters into concurrent writes.
      const f2 = t.flush();
      const f3 = t.flush(true);
      releaseFirst();
      await Promise.all([f1, f2, f3]);

      // Strictly serialized: never more than one rename in flight.
      expect(maxInFlight).toBe(1);
      // Monotone: no write ever carried FEWER entries than one queued
      // before it (an older snapshot can no longer land last).
      for (let i = 1; i < payloadSizes.length; i += 1) {
        expect(payloadSizes[i]).toBeGreaterThanOrEqual(payloadSizes[i - 1]);
      }
      // Disk ends equal to memory.
      const disk = await loadDiscoveryStore(p, silentLog);
      expect(disk.entries.map(e => e.dataPoint).sort()).toEqual(['a', 'b']);
      expect(disk.entries).toHaveLength(t.snapshot().entries.length);
    } finally {
      spy.mockRestore();
    }
  });
});

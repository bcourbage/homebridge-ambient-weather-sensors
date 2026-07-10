import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

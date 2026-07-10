import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Clock, Logger } from '../../../../src/sensorMap/persistence/atomicWrite';
import {
  appendNotice,
  emptyNoticeStore,
  loadNoticeStore,
  MAX_NOTICES,
  saveNoticeStore,
} from '../../../../src/sensorMap/persistence/noticesStore';

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
beforeEach(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-not-')); });
afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('loadNoticeStore', () => {
  it('returns empty on first call', async () => {
    const s = await loadNoticeStore(path.join(tmpRoot, 'n.json'), silentLog);
    expect(s).toEqual(emptyNoticeStore());
  });

  it('round-trips a populated store', async () => {
    const p = path.join(tmpRoot, 'n.json');
    const store = {
      schemaVersion: 1 as const,
      notices: [{
        id: 'AA:BB:CC:DD:EE:01|tempf|2026-07-09T20:00:00.000Z',
        type: 'structural-change' as const,
        stationMac: 'AA:BB:CC:DD:EE:01',
        dataPoint: 'tempf',
        oldSignature: 'temperature|measurement:temperature|battery:0|wrapper:temperature:v1',
        newSignature: 'temperature|measurement:temperature|battery:1|wrapper:temperature:v1',
        occurredAt: '2026-07-09T20:00:00.000Z',
      }],
    };
    await saveNoticeStore(p, store, silentLog);
    const loaded = await loadNoticeStore(p, silentLog);
    expect(loaded).toEqual(store);
  });
});

describe('appendNotice', () => {
  it('appends and persists', async () => {
    const p = path.join(tmpRoot, 'n.json');
    const clock = new FakeClock();
    const next = await appendNotice(
      p,
      emptyNoticeStore(),
      'AA:BB:CC:DD:EE:01',
      'tempf',
      undefined,
      'temperature|measurement:temperature|battery:1|wrapper:temperature:v1',
      silentLog,
      clock,
    );
    expect(next.notices).toHaveLength(1);
    const loaded = await loadNoticeStore(p, silentLog);
    expect(loaded.notices).toHaveLength(1);
    expect(loaded.notices[0].occurredAt).toBe('2026-07-09T20:00:00.000Z');
  });

  it('uppercases stationMac in both id and notice body', async () => {
    const p = path.join(tmpRoot, 'n.json');
    const clock = new FakeClock();
    const next = await appendNotice(
      p, emptyNoticeStore(), 'aa:bb:cc:dd:ee:01', 'tempf', undefined,
      'sig', silentLog, clock,
    );
    expect(next.notices[0].stationMac).toBe('AA:BB:CC:DD:EE:01');
    expect(next.notices[0].id.startsWith('AA:BB:CC:DD:EE:01|')).toBe(true);
  });

  it('caps to MAX_NOTICES, keeping the newest', async () => {
    const p = path.join(tmpRoot, 'n.json');
    const clock = new FakeClock();
    let store = emptyNoticeStore();
    for (let i = 0; i < MAX_NOTICES + 5; i++) {
      store = await appendNotice(
        p, store, `AA:BB:CC:DD:EE:${i.toString(16).padStart(2, '0')}`, 'tempf',
        undefined, `sig-${i}`, silentLog, clock,
      );
      clock.advanceMs(1000);
    }
    expect(store.notices.length).toBe(MAX_NOTICES);
    // The oldest 5 notices dropped; newest still present.
    expect(store.notices[store.notices.length - 1].newSignature).toBe(`sig-${MAX_NOTICES + 4}`);
    expect(store.notices[0].newSignature).toBe('sig-5');
  });
});

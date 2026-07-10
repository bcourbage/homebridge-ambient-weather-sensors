import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Clock, Logger } from '../../../../src/sensorMap/persistence/atomicWrite';
import {
  emptyUiStateStore,
  loadUiStateStore,
  saveUiStateStore,
  withDismissedNotice,
  withForgottenField,
} from '../../../../src/sensorMap/persistence/uiStateStore';

const silentLog: Logger = {
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  debug: () => { /* noop */ },
};

const FIXED_CLOCK: Clock = {
  now: () => Date.parse('2026-07-09T20:00:00Z'),
  iso: () => '2026-07-09T20:00:00.000Z',
};

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-uistate-')); });
afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('loadUiStateStore / saveUiStateStore', () => {
  it('returns empty on first call', async () => {
    const s = await loadUiStateStore(path.join(tmpRoot, 'ui.json'), silentLog);
    expect(s).toEqual(emptyUiStateStore());
  });

  it('round-trips populated state', async () => {
    const p = path.join(tmpRoot, 'ui.json');
    const store = {
      schemaVersion: 1 as const,
      dismissedNoticeIds: ['a', 'b'],
      forgottenFields: [{
        stationMac: 'AA:BB:CC:DD:EE:01',
        dataPoint: 'foo_bar',
        forgottenAt: '2026-07-09T20:00:00.000Z',
      }],
    };
    await saveUiStateStore(p, store, silentLog);
    const loaded = await loadUiStateStore(p, silentLog);
    expect(loaded).toEqual(store);
  });

  it('quarantines a file with wrong field types', async () => {
    const p = path.join(tmpRoot, 'ui.json');
    await fs.writeFile(p, JSON.stringify({
      schemaVersion: 1,
      dismissedNoticeIds: [123],
      forgottenFields: [],
    }), 'utf8');
    const loaded = await loadUiStateStore(p, silentLog);
    expect(loaded).toEqual(emptyUiStateStore());
  });
});

describe('withForgottenField', () => {
  it('adds a new entry with uppercase MAC', () => {
    const s = withForgottenField(emptyUiStateStore(), 'aa:bb:cc:dd:ee:01', 'foo', FIXED_CLOCK);
    expect(s.forgottenFields).toHaveLength(1);
    expect(s.forgottenFields[0].stationMac).toBe('AA:BB:CC:DD:EE:01');
    expect(s.forgottenFields[0].dataPoint).toBe('foo');
    expect(s.forgottenFields[0].forgottenAt).toBe('2026-07-09T20:00:00.000Z');
  });

  it('is idempotent — repeat calls do not accumulate duplicates', () => {
    let s = withForgottenField(emptyUiStateStore(), 'AA:BB:CC:DD:EE:01', 'foo', FIXED_CLOCK);
    s = withForgottenField(s, 'aa:bb:cc:dd:ee:01', 'foo', FIXED_CLOCK);
    expect(s.forgottenFields).toHaveLength(1);
  });

  it('does not mutate the input store', () => {
    const original = emptyUiStateStore();
    const next = withForgottenField(original, 'AA:BB:CC:DD:EE:01', 'foo', FIXED_CLOCK);
    expect(original.forgottenFields).toHaveLength(0);
    expect(next).not.toBe(original);
  });
});

describe('withDismissedNotice', () => {
  it('adds a notice id', () => {
    const s = withDismissedNotice(emptyUiStateStore(), 'notice-1');
    expect(s.dismissedNoticeIds).toEqual(['notice-1']);
  });

  it('is idempotent', () => {
    let s = withDismissedNotice(emptyUiStateStore(), 'notice-1');
    s = withDismissedNotice(s, 'notice-1');
    expect(s.dismissedNoticeIds).toEqual(['notice-1']);
  });
});

/**
 * NoticesStore reader/appender. See docs/future/sensor-map.md §8.4.
 *
 * Plugin-only writes. Size-capped to prevent unbounded growth — the
 * newest `MAX_NOTICES` entries are retained; older entries are
 * dropped on each write.
 *
 * Notices record structural-graph changes (a row's structural
 * signature changed → re-registration happened). The UI groups them
 * so users understand why their HomeKit room / automation for that
 * accessory disappeared.
 */

import type { NoticeStore, SensorMapNotice } from '../types.js';
import {
  readJsonStore,
  writeJsonStore,
  type Clock,
  type Logger,
  REAL_CLOCK,
  type ReadStoreOptions,
} from './atomicWrite.js';

export const NOTICES_FILE = 'notices.json';
export const MAX_NOTICES = 100;

function isNoticeStore(raw: unknown): raw is NoticeStore {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    return false;
  }
  if (!Array.isArray(r.notices)) {
    return false;
  }
  for (const n of r.notices) {
    if (typeof n !== 'object' || n === null) {
      return false;
    }
    const nn = n as Record<string, unknown>;
    if (typeof nn.id !== 'string' || nn.type !== 'structural-change'
        || typeof nn.stationMac !== 'string' || typeof nn.dataPoint !== 'string'
        || typeof nn.newSignature !== 'string' || typeof nn.occurredAt !== 'string') {
      return false;
    }
  }
  return true;
}

export function emptyNoticeStore(): NoticeStore {
  return { schemaVersion: 1, notices: [] };
}

export async function loadNoticeStore(filePath: string, log: Logger, clock: Clock = REAL_CLOCK, opts: ReadStoreOptions = {}): Promise<NoticeStore> {
  const loaded = await readJsonStore<NoticeStore>(filePath, isNoticeStore, log, clock, opts);
  return loaded ?? emptyNoticeStore();
}

export async function saveNoticeStore(filePath: string, store: NoticeStore, log: Logger): Promise<void> {
  await writeJsonStore(filePath, capNotices(store), log);
}

/**
 * Append a notice and persist. Deterministic id derived from
 * `${stationMac}|${dataPoint}|${occurredAt}` — makes dedup by id
 * possible if the same structural change is recorded twice within
 * the same millisecond.
 */
export async function appendNotice(
  filePath: string,
  current: NoticeStore,
  stationMac: string,
  dataPoint: string,
  oldSignature: string | undefined,
  newSignature: string,
  log: Logger,
  clock: Clock = REAL_CLOCK,
): Promise<NoticeStore> {
  const occurredAt = clock.iso();
  const id = `${stationMac.toUpperCase()}|${dataPoint}|${occurredAt}`;
  const notice: SensorMapNotice = {
    id,
    type: 'structural-change',
    stationMac: stationMac.toUpperCase(),
    dataPoint,
    oldSignature,
    newSignature,
    occurredAt,
  };
  const next: NoticeStore = {
    schemaVersion: 1,
    notices: [...current.notices, notice],
  };
  const capped = capNotices(next);
  await saveNoticeStore(filePath, capped, log);
  return capped;
}

function capNotices(store: NoticeStore): NoticeStore {
  if (store.notices.length <= MAX_NOTICES) {
    return store;
  }
  return {
    schemaVersion: 1,
    notices: store.notices.slice(-MAX_NOTICES),
  };
}

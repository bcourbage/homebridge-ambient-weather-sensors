/**
 * UiStateStore reader/writer. See docs/future/sensor-map.md §8.5.
 *
 * **UI-server-only writes.** The plugin reads to know which notices
 * to hide and which (stationMac, dataPoint) pairs to suppress from
 * unrecognized-row emission; it never modifies this file.
 *
 * If the plugin needs to record something (e.g., a notice), it uses
 * NoticeStore, not this file. Single-writer discipline is enforced
 * by convention — there's no filesystem lock here.
 */

import type { UiStateStore, ForgottenField } from '../types.js';
import {
  readJsonStore,
  writeJsonStore,
  type Clock,
  type Logger,
  REAL_CLOCK,
  type ReadStoreOptions,
} from './atomicWrite.js';

export const UI_STATE_FILE = 'ui-state.json';

function isUiStateStore(raw: unknown): raw is UiStateStore {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    return false;
  }
  if (!Array.isArray(r.dismissedNoticeIds) || !Array.isArray(r.forgottenFields)) {
    return false;
  }
  for (const id of r.dismissedNoticeIds) {
    if (typeof id !== 'string') {
      return false;
    }
  }
  for (const f of r.forgottenFields) {
    if (typeof f !== 'object' || f === null) {
      return false;
    }
    const ff = f as Record<string, unknown>;
    if (typeof ff.stationMac !== 'string' || typeof ff.dataPoint !== 'string' || typeof ff.forgottenAt !== 'string') {
      return false;
    }
  }
  return true;
}

export function emptyUiStateStore(): UiStateStore {
  return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}

export async function loadUiStateStore(filePath: string, log: Logger, clock: Clock = REAL_CLOCK, opts: ReadStoreOptions = {}): Promise<UiStateStore> {
  const loaded = await readJsonStore<UiStateStore>(filePath, isUiStateStore, log, clock, opts);
  return loaded ?? emptyUiStateStore();
}

/**
 * UI-server-only write path. The plugin should NEVER call this; it
 * exists here so the UI server (Stage 8) has a single source of truth
 * for the write shape.
 */
export async function saveUiStateStore(filePath: string, store: UiStateStore, log: Logger): Promise<void> {
  await writeJsonStore(filePath, store, log);
}

/**
 * Helper: add a `ForgottenField` entry. Called from the UI server
 * when the user clicks "forget" on a discovered row.
 */
export function withForgottenField(
  store: UiStateStore,
  stationMac: string,
  dataPoint: string,
  clock: Clock = REAL_CLOCK,
): UiStateStore {
  const macUp = stationMac.toUpperCase();
  const already = store.forgottenFields.find(
    f => f.stationMac.toUpperCase() === macUp && f.dataPoint === dataPoint,
  );
  if (already) {
    return store;
  }
  const entry: ForgottenField = {
    stationMac: macUp,
    dataPoint,
    forgottenAt: clock.iso(),
  };
  return {
    ...store,
    forgottenFields: [...store.forgottenFields, entry],
  };
}

/** Helper: mark a notice as dismissed. Idempotent. */
export function withDismissedNotice(store: UiStateStore, noticeId: string): UiStateStore {
  if (store.dismissedNoticeIds.includes(noticeId)) {
    return store;
  }
  return {
    ...store,
    dismissedNoticeIds: [...store.dismissedNoticeIds, noticeId],
  };
}

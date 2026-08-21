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
import { readJsonStore, writeJsonStore, REAL_CLOCK, } from './atomicWrite.js';
export const UI_STATE_FILE = 'ui-state.json';
function isUiStateStore(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return false;
    }
    const r = raw;
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
        const ff = f;
        if (typeof ff.stationMac !== 'string' || typeof ff.dataPoint !== 'string' || typeof ff.forgottenAt !== 'string') {
            return false;
        }
    }
    return true;
}
export function emptyUiStateStore() {
    return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}
export async function loadUiStateStore(filePath, log, clock = REAL_CLOCK, opts = {}) {
    const loaded = await readJsonStore(filePath, isUiStateStore, log, clock, opts);
    return loaded ?? emptyUiStateStore();
}
/**
 * UI-server-only write path. The plugin should NEVER call this; it
 * exists here so the UI server (Stage 8) has a single source of truth
 * for the write shape.
 */
export async function saveUiStateStore(filePath, store, log) {
    await writeJsonStore(filePath, store, log);
}
/**
 * Helper: add a `ForgottenField` entry. Called from the UI server
 * when the user clicks "forget" on a discovered row.
 */
export function withForgottenField(store, stationMac, dataPoint, clock = REAL_CLOCK) {
    const macUp = stationMac.toUpperCase();
    const already = store.forgottenFields.find(f => f.stationMac.toUpperCase() === macUp && f.dataPoint === dataPoint);
    if (already) {
        return store;
    }
    const entry = {
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
export function withDismissedNotice(store, noticeId) {
    if (store.dismissedNoticeIds.includes(noticeId)) {
        return store;
    }
    return {
        ...store,
        dismissedNoticeIds: [...store.dismissedNoticeIds, noticeId],
    };
}
//# sourceMappingURL=uiStateStore.js.map
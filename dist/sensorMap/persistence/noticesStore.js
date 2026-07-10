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
import { readJsonStore, writeJsonStore, REAL_CLOCK, } from './atomicWrite.js';
export const NOTICES_FILE = 'notices.json';
export const MAX_NOTICES = 100;
function isNoticeStore(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return false;
    }
    const r = raw;
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
        const nn = n;
        if (typeof nn.id !== 'string' || nn.type !== 'structural-change'
            || typeof nn.stationMac !== 'string' || typeof nn.dataPoint !== 'string'
            || typeof nn.newSignature !== 'string' || typeof nn.occurredAt !== 'string') {
            return false;
        }
    }
    return true;
}
export function emptyNoticeStore() {
    return { schemaVersion: 1, notices: [] };
}
export async function loadNoticeStore(filePath, log, clock = REAL_CLOCK) {
    const loaded = await readJsonStore(filePath, isNoticeStore, log, clock);
    return loaded ?? emptyNoticeStore();
}
export async function saveNoticeStore(filePath, store, log) {
    await writeJsonStore(filePath, capNotices(store), log);
}
/**
 * Append a notice and persist. Deterministic id derived from
 * `${stationMac}|${dataPoint}|${occurredAt}` — makes dedup by id
 * possible if the same structural change is recorded twice within
 * the same millisecond.
 */
export async function appendNotice(filePath, current, stationMac, dataPoint, oldSignature, newSignature, log, clock = REAL_CLOCK) {
    const occurredAt = clock.iso();
    const id = `${stationMac.toUpperCase()}|${dataPoint}|${occurredAt}`;
    const notice = {
        id,
        type: 'structural-change',
        stationMac: stationMac.toUpperCase(),
        dataPoint,
        oldSignature,
        newSignature,
        occurredAt,
    };
    const next = {
        schemaVersion: 1,
        notices: [...current.notices, notice],
    };
    const capped = capNotices(next);
    await saveNoticeStore(filePath, capped, log);
    return capped;
}
function capNotices(store) {
    if (store.notices.length <= MAX_NOTICES) {
        return store;
    }
    return {
        schemaVersion: 1,
        notices: store.notices.slice(-MAX_NOTICES),
    };
}
//# sourceMappingURL=noticesStore.js.map
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
import type { NoticeStore } from '../types.js';
import { type Clock, type Logger } from './atomicWrite.js';
export declare const NOTICES_FILE = "notices.json";
export declare const MAX_NOTICES = 100;
export declare function emptyNoticeStore(): NoticeStore;
export declare function loadNoticeStore(filePath: string, log: Logger, clock?: Clock): Promise<NoticeStore>;
export declare function saveNoticeStore(filePath: string, store: NoticeStore, log: Logger): Promise<void>;
/**
 * Append a notice and persist. Deterministic id derived from
 * `${stationMac}|${dataPoint}|${occurredAt}` — makes dedup by id
 * possible if the same structural change is recorded twice within
 * the same millisecond.
 */
export declare function appendNotice(filePath: string, current: NoticeStore, stationMac: string, dataPoint: string, oldSignature: string | undefined, newSignature: string, log: Logger, clock?: Clock): Promise<NoticeStore>;
//# sourceMappingURL=noticesStore.d.ts.map
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
import type { UiStateStore } from '../types.js';
import { type Clock, type Logger } from './atomicWrite.js';
export declare const UI_STATE_FILE = "ui-state.json";
export declare function emptyUiStateStore(): UiStateStore;
export declare function loadUiStateStore(filePath: string, log: Logger, clock?: Clock): Promise<UiStateStore>;
/**
 * UI-server-only write path. The plugin should NEVER call this; it
 * exists here so the UI server (Stage 8) has a single source of truth
 * for the write shape.
 */
export declare function saveUiStateStore(filePath: string, store: UiStateStore, log: Logger): Promise<void>;
/**
 * Helper: add a `ForgottenField` entry. Called from the UI server
 * when the user clicks "forget" on a discovered row.
 */
export declare function withForgottenField(store: UiStateStore, stationMac: string, dataPoint: string, clock?: Clock): UiStateStore;
/** Helper: mark a notice as dismissed. Idempotent. */
export declare function withDismissedNotice(store: UiStateStore, noticeId: string): UiStateStore;
//# sourceMappingURL=uiStateStore.d.ts.map
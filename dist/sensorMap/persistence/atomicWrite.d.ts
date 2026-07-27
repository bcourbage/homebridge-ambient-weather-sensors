/**
 * Atomic file persistence helper — see docs/future/sensor-map.md §8.6.
 *
 * Contract:
 *   - `readJsonStore` reads and parses; on any failure (missing file,
 *     malformed JSON, unrecognized schemaVersion) it quarantines the
 *     bad file and returns undefined. Caller starts with an empty
 *     in-memory store.
 *   - `writeJsonStore` writes to a unique temp file and renames.
 *     `<name>.<pid>.<random>.tmp` naming avoids cross-process
 *     collisions. Optional `fsync` before rename gated by env flag.
 *   - `cleanupStaleTempFiles` removes any `<name>.*.tmp` older than
 *     1 hour on startup — belt against orphaned temp files from a
 *     crashed prior boot.
 *
 * The functions are deliberately narrow: they know about JSON and
 * files, nothing about sensor-map semantics. Higher-level stores
 * (DiscoveryStore, NoticeStore, UiStateStore) wrap these with
 * schema-specific validation.
 */
/** Clock injection point for testability. */
export interface Clock {
    now(): number;
    iso(): string;
}
export declare const REAL_CLOCK: Clock;
/** Logger surface — a subset of Homebridge's Logger. */
export interface Logger {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
}
/**
 * Read a JSON store file. Returns the parsed object on success, or
 * undefined on any failure (with the file quarantined and a warn
 * logged). Caller supplies a validator that rejects malformed shapes
 * — e.g., checks `schemaVersion === 1`.
 */
export declare function readJsonStore<T>(filePath: string, validator: (raw: unknown) => raw is T, log: Logger, clock?: Clock): Promise<T | undefined>;
/**
 * Write a JSON store atomically. The temp file is closed and renamed
 * over the target path in one step (POSIX + modern Windows both
 * support atomic replace).
 *
 * If the rename step fails (out of disk, permissions, cross-device
 * link), the destination file is left untouched, the orphan temp file
 * is unlinked on a best-effort basis, a warn is logged, and the
 * original error is re-thrown so the caller (e.g. DiscoveryTracker.flush)
 * can skip advancing its flush watermarks. There is NO unlink+rename
 * fallback — see the throw at the bottom of the function.
 *
 * The stores are single-writer per §8 so cross-process races are
 * outside this function's remit.
 */
export declare function writeJsonStore(filePath: string, data: unknown, log: Logger): Promise<void>;
/**
 * Remove any `<name>.*.tmp` in the persistence directory older than
 * `STALE_TEMP_AGE_MS`. Safe to run on startup — legit in-flight temps
 * are always well under a minute old.
 */
export declare function cleanupStaleTempFiles(dir: string, log: Logger, clock?: Clock): Promise<void>;
//# sourceMappingURL=atomicWrite.d.ts.map
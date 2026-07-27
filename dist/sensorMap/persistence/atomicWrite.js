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
import { promises as fs } from 'fs';
import * as path from 'path';
export const REAL_CLOCK = {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
};
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
/**
 * Read a JSON store file. Returns the parsed object on success, or
 * undefined on any failure (with the file quarantined and a warn
 * logged). Caller supplies a validator that rejects malformed shapes
 * — e.g., checks `schemaVersion === 1`.
 */
export async function readJsonStore(filePath, validator, log, clock = REAL_CLOCK) {
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    }
    catch (e) {
        const err = e;
        if (err.code === 'ENOENT') {
            // Missing file is the normal first-boot case; not a warn.
            log.debug(`Persistence file ${filePath} not present; starting empty.`);
            return undefined;
        }
        log.warn(`Failed to read ${filePath}: ${err.message}; starting empty.`);
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        const err = e;
        const quarantined = await quarantine(filePath, log, clock);
        log.warn(`Malformed JSON in ${filePath} (${err.message}); quarantined to ${quarantined}. Starting empty.`);
        return undefined;
    }
    if (!validator(parsed)) {
        const quarantined = await quarantine(filePath, log, clock);
        log.warn(`Unexpected schema in ${filePath}; quarantined to ${quarantined}. Starting empty.`);
        return undefined;
    }
    return parsed;
}
/**
 * Write a JSON store atomically. The temp file is closed and renamed
 * over the target path in one step (on POSIX + modern Windows).
 *
 * On unsupported platforms the fallback is unlink + rename with a
 * warn; a brief window of "file absent" is visible to concurrent
 * readers. The stores are single-writer per §8 so cross-process
 * races are outside this function's remit.
 */
export async function writeJsonStore(filePath, data, log) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const base = path.basename(filePath);
    const suffix = `${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
    const tmpPath = path.join(dir, `${base}.${suffix}.tmp`);
    const body = JSON.stringify(data, null, 2);
    let fh;
    try {
        fh = await fs.open(tmpPath, 'w', 0o640);
        await fh.writeFile(body, 'utf8');
        if (process.env.PERSIST_FSYNC === '1') {
            await fh.sync();
        }
    }
    finally {
        if (fh) {
            await fh.close().catch(() => { });
        }
    }
    try {
        await fs.rename(tmpPath, filePath);
    }
    catch (e) {
        const err = e;
        // Rename failure. Do NOT unlink the existing file and retry — a
        // second rename that also fails would leave us with no persisted
        // state at all. Node.js's fs.rename atomically replaces an
        // existing destination on every platform we support (POSIX +
        // Windows via MoveFileExW), so first-rename failure signals a
        // real error (out of disk, permissions, cross-device link)
        // rather than "target already exists." The right thing to do is
        // fail the write, preserve the existing file, and let the next
        // save attempt (with a fresh temp file) try again. Clean up our
        // orphan temp so it doesn't accumulate; cleanupStaleTempFiles
        // catches any we can't remove synchronously.
        log.warn(`Persistence write failed on rename ${tmpPath} → ${filePath}: `
            + `${err.code ?? err.message}. Existing file at ${filePath} preserved; `
            + `orphan temp file will be cleaned up on next startup.`);
        try {
            await fs.unlink(tmpPath);
        }
        catch { /* best-effort */ }
    }
}
/**
 * Remove any `<name>.*.tmp` in the persistence directory older than
 * `STALE_TEMP_AGE_MS`. Safe to run on startup — legit in-flight temps
 * are always well under a minute old.
 */
export async function cleanupStaleTempFiles(dir, log, clock = REAL_CLOCK) {
    let entries;
    try {
        entries = await fs.readdir(dir);
    }
    catch (e) {
        const err = e;
        if (err.code === 'ENOENT') {
            return;
        }
        log.warn(`cleanupStaleTempFiles: failed to list ${dir}: ${err.message}`);
        return;
    }
    const now = clock.now();
    for (const name of entries) {
        if (!name.endsWith('.tmp')) {
            continue;
        }
        const full = path.join(dir, name);
        try {
            const stat = await fs.stat(full);
            if (now - stat.mtimeMs > STALE_TEMP_AGE_MS) {
                await fs.unlink(full);
                log.debug(`Removed stale temp file ${full}`);
            }
        }
        catch { /* best-effort */ }
    }
}
/**
 * Move a corrupt file aside with a timestamped suffix so evidence
 * is preserved for post-mortem inspection.
 */
async function quarantine(filePath, log, clock) {
    const stamp = clock.iso().replace(/[:.]/g, '-');
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const ext = path.extname(filePath);
    const quarantined = path.join(dir, `${base}.corrupt-${stamp}${ext}`);
    try {
        await fs.rename(filePath, quarantined);
    }
    catch (e) {
        const err = e;
        log.warn(`Failed to quarantine ${filePath}: ${err.message}`);
    }
    return quarantined;
}
//# sourceMappingURL=atomicWrite.js.map
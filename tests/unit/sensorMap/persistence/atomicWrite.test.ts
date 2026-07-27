import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupStaleTempFiles,
  readJsonStore,
  writeJsonStore,
  type Clock,
  type Logger,
} from '../../../../src/sensorMap/persistence/atomicWrite';

const silentLog: Logger = {
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  debug: () => { /* noop */ },
};

interface Interceptor extends Logger {
  warns: string[];
}
function captureLog(): Interceptor {
  const warns: string[] = [];
  return {
    warns,
    info: () => { /* noop */ },
    warn: (m) => warns.push(m),
    debug: () => { /* noop */ },
  };
}

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-persist-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

interface Sample { schemaVersion: 1; value: string }
const isSample = (r: unknown): r is Sample =>
  typeof r === 'object' && r !== null
  && (r as Record<string, unknown>).schemaVersion === 1
  && typeof (r as Record<string, unknown>).value === 'string';

describe('writeJsonStore + readJsonStore round-trip', () => {
  it('writes then reads the same object', async () => {
    const p = path.join(tmpRoot, 'store.json');
    await writeJsonStore(p, { schemaVersion: 1, value: 'hello' }, silentLog);
    const round = await readJsonStore<Sample>(p, isSample, silentLog);
    expect(round).toEqual({ schemaVersion: 1, value: 'hello' });
  });

  it('returns undefined on missing file (first-boot case, no warn)', async () => {
    const log = captureLog();
    const p = path.join(tmpRoot, 'missing.json');
    const r = await readJsonStore<Sample>(p, isSample, log);
    expect(r).toBeUndefined();
    expect(log.warns).toHaveLength(0);
  });

  it('quarantines malformed JSON and returns undefined', async () => {
    const log = captureLog();
    const p = path.join(tmpRoot, 'bad.json');
    await fs.writeFile(p, '{not valid json', 'utf8');
    const r = await readJsonStore<Sample>(p, isSample, log);
    expect(r).toBeUndefined();
    expect(log.warns[0]).toMatch(/Malformed JSON/);
    // Original file no longer exists; quarantined sibling does.
    await expect(fs.access(p)).rejects.toBeTruthy();
    const dirEntries = await fs.readdir(tmpRoot);
    expect(dirEntries.some(n => n.startsWith('bad.corrupt-') && n.endsWith('.json'))).toBe(true);
  });

  it('quarantines unrecognized schema and returns undefined', async () => {
    const log = captureLog();
    const p = path.join(tmpRoot, 'wrong-schema.json');
    await fs.writeFile(p, JSON.stringify({ schemaVersion: 99, value: 'x' }), 'utf8');
    const r = await readJsonStore<Sample>(p, isSample, log);
    expect(r).toBeUndefined();
    expect(log.warns[0]).toMatch(/Unexpected schema/);
  });

  it('overwrites an existing file atomically (rename-based)', async () => {
    const p = path.join(tmpRoot, 'target.json');
    await writeJsonStore(p, { schemaVersion: 1, value: 'first' }, silentLog);
    await writeJsonStore(p, { schemaVersion: 1, value: 'second' }, silentLog);
    const round = await readJsonStore<Sample>(p, isSample, silentLog);
    expect(round?.value).toBe('second');
  });

  it('leaves no .tmp files behind after a successful write', async () => {
    const p = path.join(tmpRoot, 'store.json');
    await writeJsonStore(p, { schemaVersion: 1, value: 'x' }, silentLog);
    const entries = await fs.readdir(tmpRoot);
    expect(entries.filter(e => e.endsWith('.tmp'))).toHaveLength(0);
  });
});

describe('cleanupStaleTempFiles', () => {
  it('removes .tmp files older than 1 hour', async () => {
    const oldTmp = path.join(tmpRoot, 'x.tmp');
    await fs.writeFile(oldTmp, '', 'utf8');
    // Backdate mtime to 2 hours ago.
    const twoHrsAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(oldTmp, twoHrsAgo, twoHrsAgo);
    const stableClock: Clock = { now: () => Date.now(), iso: () => new Date().toISOString() };
    await cleanupStaleTempFiles(tmpRoot, silentLog, stableClock);
    await expect(fs.access(oldTmp)).rejects.toBeTruthy();
  });

  it('leaves fresh .tmp files alone', async () => {
    const freshTmp = path.join(tmpRoot, 'y.tmp');
    await fs.writeFile(freshTmp, '', 'utf8');
    await cleanupStaleTempFiles(tmpRoot, silentLog);
    await expect(fs.access(freshTmp)).resolves.toBeUndefined();
  });

  it('does not touch non-.tmp files', async () => {
    const real = path.join(tmpRoot, 'z.json');
    await fs.writeFile(real, '{}', 'utf8');
    await cleanupStaleTempFiles(tmpRoot, silentLog);
    await expect(fs.access(real)).resolves.toBeUndefined();
  });

  it('is a no-op on missing directory', async () => {
    await expect(cleanupStaleTempFiles(path.join(tmpRoot, 'nope'), silentLog)).resolves.toBeUndefined();
  });
});

// ---- Review finding #1 / follow-up: rename failure must (a) preserve
// the existing target and (b) THROW so callers (e.g. DiscoveryTracker.flush)
// can skip clearing their pending-work flags.

describe('writeJsonStore — rename failure preserves target and rejects', () => {
  it('preserves the existing target file when the rename step fails, and rejects', async () => {
    const p = path.join(tmpRoot, 'target.json');
    // Seed the target with a known-good value.
    await writeJsonStore(p, { schemaVersion: 1, value: 'previous' }, silentLog);
    const before = await readJsonStore<Sample>(p, isSample, silentLog);
    expect(before?.value).toBe('previous');

    // Force fs.rename to fail once with EACCES.
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('simulated rename failure'), { code: 'EACCES' }),
    );

    const log = captureLog();
    try {
      await expect(
        writeJsonStore(p, { schemaVersion: 1, value: 'attempted' }, log),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      renameSpy.mockRestore();
    }

    // (a) Existing target is intact.
    const after = await readJsonStore<Sample>(p, isSample, silentLog);
    expect(after?.value).toBe('previous');

    // Warning was logged with rename context, including error code.
    expect(log.warns.some(w => /rename/i.test(w) && w.includes('EACCES'))).toBe(true);

    // (b) Orphan .tmp cleaned up so temp files don't accumulate on failure.
    const entries = await fs.readdir(tmpRoot);
    expect(entries.filter(e => e.endsWith('.tmp'))).toHaveLength(0);
  });
});

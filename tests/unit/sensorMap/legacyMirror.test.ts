import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compatToOverrides } from '../../../src/sensorMap/compat';
import { detectConfigMode } from '../../../src/sensorMap/configMode';
import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { defaultRowFor } from '../../../src/sensorMap/defaultMap';
import {
  LEGACY_JOURNAL_DIR,
  LEGACY_MIRROR_KEY,
  LEGACY_SENSOR_FIELDS,
  LEGACY_SNAPSHOT_FILE,
  composeV2ConfigSave,
  journalConversionBaseline,
  mirrorHash,
  projectLegacyMirror,
  recognizeMirror,
  writeLegacySnapshot,
} from '../../../src/sensorMap/legacyMirror';
import { emptyDiscoveryStore } from '../../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../../src/sensorMap/persistence/uiStateStore';
import { buildPlatformEffectiveMap } from '../../../src/sensorMap/platformEffectiveMap';
import type { EffectiveSensorMap, StationInventory } from '../../../src/sensorMap/types';

const MAC1 = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';
const ONE_STATION: StationInventory = [{ macAddress: MAC1, name: 'Home' }];
const TWO_STATIONS: StationInventory = [
  { macAddress: MAC1, name: 'Home' },
  { macAddress: MAC2, name: 'Cabin' },
];

function v2Map(sensorMap: unknown[], stations: StationInventory = ONE_STATION): EffectiveSensorMap {
  return buildPlatformEffectiveMap({
    config: { sensorMap },
    configMode: 'v2',
    stations,
    discovery: emptyDiscoveryStore(),
    uiState: emptyUiStateStore(),
  });
}

/**
 * Compose as the real save flow must: the mode passed to
 * composeV2ConfigSave is ALWAYS detectConfigMode's verdict (review
 * R4-3 — config-mode detection is the single legacy authority).
 */
function compose(config: Record<string, unknown>, sensorMap: unknown[], map: EffectiveSensorMap) {
  return composeV2ConfigSave(config, sensorMap, map, detectConfigMode(config as never).mode);
}

describe('projectLegacyMirror (finding 5 — reverse projection)', () => {
  it('all-defaults v2 map turns every category toggle on with no exclusions', () => {
    const mirror = projectLegacyMirror(v2Map([]));
    expect(mirror.temperatureSensors).toBe(true);
    expect(mirror.humiditySensors).toBe(true);
    expect(mirror.solarRadiationSensors).toBe(true);
    expect(mirror.co2Sensors).toBe(true);
    expect(mirror.airQualitySensors).toBe(true);
    expect(mirror.extendedSensors).toBe(true);
    expect(mirror.windSensors).toBe(true);
    expect(mirror.rainSensors).toBe(true);
    expect(mirror.pressureSensors).toBe(true);
    expect(mirror.uvSensors).toBe(true);
    expect(mirror.lightningSensors).toBe(true);
    expect(mirror.excludeSensors).toBeUndefined();
  });

  it('a globally-disabled known row becomes a bare excludeSensors entry', () => {
    const mirror = projectLegacyMirror(v2Map([{ dataPoint: 'humidity', enabled: false }]));
    // Category stays on (humidityin remains enabled).
    expect(mirror.humiditySensors).toBe(true);
    expect(mirror.excludeSensors).toContain('humidity');
    expect(mirror.excludeSensors!.some(e => e.includes(':'))).toBe(false);
  });

  it('a station-specific disable becomes a MAC-dataPoint exclusion', () => {
    const mirror = projectLegacyMirror(v2Map(
      [{ dataPoint: 'tempinf', stationMac: MAC2, enabled: false }],
      TWO_STATIONS,
    ));
    expect(mirror.excludeSensors).toContain(`${MAC2}-tempinf`);
    expect(mirror.excludeSensors).not.toContain('tempinf');
    expect(mirror.excludeSensors).not.toContain(`${MAC1}-tempinf`);
  });

  it('a custom row emits BOTH the station-scoped uniqueId and the bare dataPoint exclusion', () => {
    // Custom rows surface as no-wrapper errors while the table is empty
    // - both exclusion forms must still be emitted, or v1.7's broad
    // includes("temp") matcher would build a WRONG wrapper for barn_temp.
    const mirror = projectLegacyMirror(v2Map(
      [{ dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'celsius' }],
      TWO_STATIONS,
    ));
    expect(mirror.excludeSensors).toContain('barn_temp');
    expect(mirror.excludeSensors).toContain(`${MAC1}-barn_temp`);
    expect(mirror.excludeSensors).toContain(`${MAC2}-barn_temp`);
  });

  it('batteryField: null on a canonical row mirrors as the raw batt* field name', () => {
    const mirror = projectLegacyMirror(v2Map([{ dataPoint: 'lightning_day', batteryField: null }]));
    expect(mirror.excludeSensors).toContain('batt_lightning');
  });

  it('thresholds and non-default display units project; conflicts fall back to the lowest station MAC', () => {
    const mirror = projectLegacyMirror(v2Map(
      [
        { dataPoint: 'uv', threshold: 7 },
        // Family-uniform wind unit (v1.7's units.windSpeed is family-wide).
        { dataPoint: 'windspeedmph', displayUnit: 'kph' },
        { dataPoint: 'windgustmph', displayUnit: 'kph' },
        { dataPoint: 'maxdailygust', displayUnit: 'kph' },
        // Station-conflicting thresholds: MAC1 wins (lowest MAC).
        { dataPoint: 'hourlyrainin', stationMac: MAC1, threshold: 0.5 },
        { dataPoint: 'hourlyrainin', stationMac: MAC2, threshold: 2.0 },
      ],
      TWO_STATIONS,
    ));
    expect(mirror.thresholds?.uv).toBe(7);
    expect(mirror.units?.windSpeed).toBe('kph');
    expect(mirror.thresholds?.rainRateInHr).toBe(0.5);
  });

  it('a family-MIXED display unit is omitted (not v1-expressible; v1.7 default applies on downgrade)', () => {
    const mirror = projectLegacyMirror(v2Map([
      { dataPoint: 'windspeedmph', displayUnit: 'kph' },
      // windgustmph + maxdailygust stay at the mph default → mixed family.
    ]));
    expect(mirror.units?.windSpeed).toBeUndefined();
  });

  it('embed mode mirrors only when EVERY enabled motion row embeds', () => {
    const all = projectLegacyMirror(v2Map([
      // Global embed for every motion row is impractical to express row
      // by row here; flip two and confirm partial does NOT set embed.
      { dataPoint: 'uv', embedName: true },
    ]));
    expect(all.extendedDisplayMode).toBeUndefined();
  });
});

describe('mirrorHash + recognizeMirror', () => {
  it('is stable across key order and ignores non-legacy fields', () => {
    const a = mirrorHash({ temperatureSensors: true, excludeSensors: ['x'], apiKey: 'secret' });
    const b = mirrorHash({ excludeSensors: ['x'], temperatureSensors: true, applicationKey: 'other' });
    expect(a).toBe(b);
  });

  it('classifies absent / recognized / stale', () => {
    expect(recognizeMirror({}).state).toBe('absent');
    const fields = { temperatureSensors: true };
    const good = { ...fields, [LEGACY_MIRROR_KEY]: { version: 1, hash: mirrorHash(fields) } };
    expect(recognizeMirror(good).state).toBe('recognized');
    const stale = { temperatureSensors: false, [LEGACY_MIRROR_KEY]: { version: 1, hash: mirrorHash(fields) } };
    expect(recognizeMirror(stale).state).toBe('stale');
  });

  it('present-but-malformed metadata is INVALID and warns loudly, even with zero legacy fields (R4-4)', () => {
    // A number hash, an unsupported version, and a non-object are all
    // "invalid" — never silently "absent".
    const badHash = { configVersion: 2, sensorMap: [], [LEGACY_MIRROR_KEY]: { version: 1, hash: 42 } };
    const badVersion = { configVersion: 2, sensorMap: [], [LEGACY_MIRROR_KEY]: { version: 99, hash: 'abc' } };
    const nonObject = { configVersion: 2, sensorMap: [], [LEGACY_MIRROR_KEY]: true };
    for (const cfg of [badHash, badVersion, nonObject]) {
      expect(recognizeMirror(cfg).state, JSON.stringify(cfg[LEGACY_MIRROR_KEY])).toBe('invalid');
      const detected = detectConfigMode(cfg as never);
      expect(detected.mode).toBe('v2');
      expect(detected.warnings.some(w => w.includes('INVALID')), JSON.stringify(cfg[LEGACY_MIRROR_KEY])).toBe(true);
    }
    // Sanity: valid metadata on the same zero-legacy-field shape warns
    // stale (hash can't match a gutted config) but not invalid.
    const valid = { configVersion: 2, sensorMap: [], [LEGACY_MIRROR_KEY]: { version: 1, hash: 'a'.repeat(64) } };
    expect(recognizeMirror(valid).state).toBe('stale');
  });

  it('detectConfigMode suppresses the ambiguity warning ONLY for a recognized mirror', () => {
    const map = v2Map([]);
    const { nextConfig } = compose({ apiKey: 'k' }, [], map);
    // Recognized mirror: v2 mode, silent.
    const recognized = detectConfigMode(nextConfig as never);
    expect(recognized.mode).toBe('v2');
    expect(recognized.warnings).toHaveLength(0);

    // Hand-edit a mirrored field: stale warning names the hashes.
    const edited = { ...nextConfig, temperatureSensors: false };
    const stale = detectConfigMode(edited as never);
    expect(stale.mode).toBe('v2');
    expect(stale.warnings.some(w => w.includes('STALE'))).toBe(true);

    // No metadata at all: the original ambiguity warning.
    const bare = { configVersion: 2, sensorMap: [], temperatureSensors: true };
    const ambiguous = detectConfigMode(bare as never);
    expect(ambiguous.warnings.some(w => w.includes('takes precedence'))).toBe(true);
  });

  it('a sensorMap-only hand edit reads as STALE (hash binds both sides)', () => {
    const map = v2Map([]);
    const { nextConfig } = compose({ apiKey: 'k' }, [], map);
    const edited = { ...nextConfig, sensorMap: [{ dataPoint: 'tempf', enabled: false }] };
    expect(recognizeMirror(edited).state).toBe('stale');
    const detected = detectConfigMode(edited as never);
    expect(detected.warnings.some(w => w.includes('STALE'))).toBe(true);
  });

  it('deleting every mirrored legacy field still warns (metadata validated unconditionally)', () => {
    const map = v2Map([]);
    const { nextConfig } = compose({ apiKey: 'k' }, [], map);
    const gutted: Record<string, unknown> = { ...nextConfig };
    for (const key of LEGACY_SENSOR_FIELDS) {
      delete gutted[key];
    }
    expect(recognizeMirror(gutted).state).toBe('stale');
    const detected = detectConfigMode(gutted as never);
    expect(detected.warnings.some(w => w.includes('STALE') && w.includes('REMOVED'))).toBe(true);
  });
});

describe('composeV2ConfigSave', () => {
  it('extracts the legacy snapshot, strips legacy fields, and stamps mirror + metadata', () => {
    const current = {
      apiKey: 'secret', applicationKey: 'secret2', stationFilter: ['Home'],
      temperatureSensors: true, excludeSensors: ['tempinf'], thresholds: { uv: 6 },
    };
    const map = v2Map([{ dataPoint: 'humidity', enabled: false }]);
    const { snapshot, nextConfig } = compose(current, [{ dataPoint: 'humidity', enabled: false }], map);

    // Snapshot = exactly the legacy fields being removed. Never secrets.
    expect(snapshot).toEqual({ temperatureSensors: true, excludeSensors: ['tempinf'], thresholds: { uv: 6 } });
    expect(Object.keys(snapshot!)).not.toContain('apiKey');

    // Next config: v2 + sensorMap + mirror + metadata; live fields kept.
    expect(nextConfig.configVersion).toBe(2);
    expect(nextConfig.sensorMap).toEqual([{ dataPoint: 'humidity', enabled: false }]);
    expect(nextConfig.apiKey).toBe('secret');
    expect(nextConfig.stationFilter).toEqual(['Home']);
    expect(nextConfig.temperatureSensors).toBe(true);          // mirrored, not the old value by accident
    expect((nextConfig.excludeSensors as string[])).toContain('humidity');
    expect(recognizeMirror(nextConfig).state).toBe('recognized');
  });

  it('already-migrated config (no legacy fields) yields no snapshot payload', () => {
    const map = v2Map([]);
    const { snapshot } = compose({ apiKey: 'k', configVersion: 2, sensorMap: [] }, [], map);
    expect(snapshot).toBeUndefined();
  });

  it('hybrid/malformed legacy shapes follow detectConfigMode (R4-3)', () => {
    const map = v2Map([]);
    // configVersion: 1 wins over a stray sensorMap — detectConfigMode
    // says LEGACY, so conversion MUST emit the permanent snapshot.
    const hybrid = { configVersion: 1, sensorMap: [], temperatureSensors: true };
    expect(detectConfigMode(hybrid as never).mode).toBe('legacy');
    expect(compose(hybrid, [], map).snapshot).toEqual({ temperatureSensors: true });

    // Absent version + sensorMap: null — also legacy per detection.
    const nullMap = { sensorMap: null, temperatureSensors: true };
    expect(detectConfigMode(nullMap as never).mode).toBe('legacy');
    const { snapshot, nextConfig } = compose(nullMap, [], map);
    expect(snapshot).toEqual({ temperatureSensors: true });
    // The stray null is replaced by the real sensorMap in the output.
    expect(nextConfig.sensorMap).toEqual([]);

    // safe-mode input: composing a save is a caller bug — throws.
    const safe = { configVersion: 999 };
    expect(detectConfigMode(safe as never).mode).toBe('safe-mode');
    expect(() => compose(safe, [], map)).toThrow(/safe-mode/);
  });

  it('re-saving its OWN prior nextConfig never re-emits a snapshot (mirror is not legacy input)', () => {
    // R3-5: the mirror fields present on a v2 config are the projection,
    // not user-authored v1 configuration. Feeding composeV2ConfigSave
    // its own output must NOT produce a snapshot payload that could
    // "recreate" a deleted snapshot from the mirror.
    const map = v2Map([]);
    const first = compose({ apiKey: 'k', temperatureSensors: true }, [], map);
    expect(first.snapshot).toBeDefined();               // true legacy conversion
    const second = compose(first.nextConfig, [], map);
    expect(second.snapshot).toBeUndefined();            // subsequent v2 save
    // Even a hand-gutted variant (metadata removed but sensorMap kept)
    // is not a legacy conversion.
    const gutted = { ...first.nextConfig };
    delete gutted[LEGACY_MIRROR_KEY];
    expect(compose(gutted, [], map).snapshot).toBeUndefined();
  });
});

describe('writeLegacySnapshot (immutable, atomic, no secrets)', () => {
  let dir: string;
  const log = { info: () => {}, warn: () => {}, debug: () => {} };

  beforeEach(async () => {
    dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'aws-snap-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes once and never overwrites (first conversion wins)', async () => {
    const first = await writeLegacySnapshot(dir, { temperatureSensors: true, apiKey: 'secret' }, log);
    expect(first).toBe('written');
    const second = await writeLegacySnapshot(dir, { temperatureSensors: false }, log);
    expect(second).toBe('exists');

    const raw = JSON.parse(await fs.readFile(nodePath.join(dir, LEGACY_SNAPSHOT_FILE), 'utf8')) as {
      legacy: Record<string, unknown>;
    };
    // First write preserved; secrets excluded by field allowlist.
    expect(raw.legacy.temperatureSensors).toBe(true);
    expect(Object.keys(raw.legacy)).not.toContain('apiKey');
    for (const key of Object.keys(raw.legacy)) {
      expect(LEGACY_SENSOR_FIELDS).toContain(key as never);
    }
  });

  it('concurrent first writes: exactly one wins, the loser reports exists, the winner payload stays intact', async () => {
    // R3-5: exclusive-create (link(2)) — an access()-then-write check
    // would race and let the second writer clobber the first.
    const results = await Promise.all([
      writeLegacySnapshot(dir, { temperatureSensors: true }, log),
      writeLegacySnapshot(dir, { temperatureSensors: false, humiditySensors: true }, log),
    ]);
    expect(results.filter(r => r === 'written')).toHaveLength(1);
    expect(results.filter(r => r === 'exists')).toHaveLength(1);

    const raw = JSON.parse(await fs.readFile(nodePath.join(dir, LEGACY_SNAPSHOT_FILE), 'utf8')) as {
      legacy: Record<string, unknown>;
    };
    // The file is EXACTLY one of the two payloads — never a torn mix.
    const isFirst = raw.legacy.temperatureSensors === true && raw.legacy.humiditySensors === undefined;
    const isSecond = raw.legacy.temperatureSensors === false && raw.legacy.humiditySensors === true;
    expect(isFirst || isSecond).toBe(true);
    // No orphan temp files left behind.
    const entries = await fs.readdir(dir);
    expect(entries.filter(e => e.endsWith('.tmp'))).toHaveLength(0);
  });
});

describe('journalConversionBaseline (append-only entry files, deduplicated, no secrets)', () => {
  let dir: string;
  const log = { info: () => {}, warn: () => {}, debug: () => {} };
  const clock = { iso: () => '2026-08-20T00:00:00.000Z', now: () => 1_755_648_000_000 };
  const journalDir = (): string => nodePath.join(dir, LEGACY_JOURNAL_DIR);
  const entryPath = (seq: number): string =>
    nodePath.join(journalDir(), `entry-${String(seq).padStart(6, '0')}.json`);

  /** Read the journal directory back the way a human (or restore doc) would. */
  async function readEntries(): Promise<Array<{ name: string; savedAt: string; legacy: Record<string, unknown> }>> {
    const names = (await fs.readdir(journalDir())).filter(n => !n.startsWith('.')).sort();
    return Promise.all(names.map(async name => {
      const parsed = JSON.parse(await fs.readFile(nodePath.join(journalDir(), name), 'utf8')) as {
        savedAt: string; legacy: Record<string, unknown>;
      };
      return { name, savedAt: parsed.savedAt, legacy: parsed.legacy };
    }));
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'aws-journal-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('appends a fresh baseline as entry-000001.json, excluding secrets by the field allowlist', async () => {
    const outcome = await journalConversionBaseline(dir, { temperatureSensors: true, apiKey: 'secret' }, log, clock);
    expect(outcome).toBe('appended');
    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('entry-000001.json');
    expect(entries[0].savedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(entries[0].legacy).toEqual({ temperatureSensors: true });
    // No orphan temp files anywhere in the persist dir.
    const stray = (await fs.readdir(dir)).filter(e => e.endsWith('.tmp'));
    expect(stray).toHaveLength(0);
  });

  it('deduplicates against the LATEST entry only (key order never matters)', async () => {
    await journalConversionBaseline(dir, { temperatureSensors: true, windSensors: false }, log, clock);
    // Same baseline, different key order → unchanged, still one entry.
    expect(await journalConversionBaseline(dir, { windSensors: false, temperatureSensors: true }, log, clock)).toBe('unchanged');
    // A different baseline appends...
    expect(await journalConversionBaseline(dir, { temperatureSensors: false }, log, clock)).toBe('appended');
    // ...and returning to an OLDER baseline appends again (only the
    // latest entry deduplicates — history is never rewritten).
    expect(await journalConversionBaseline(dir, { temperatureSensors: true, windSensors: false }, log, clock)).toBe('appended');
    const entries = await readEntries();
    expect(entries.map(e => e.name)).toEqual(['entry-000001.json', 'entry-000002.json', 'entry-000003.json']);
  });

  it('existing entries are never rewritten by later appends', async () => {
    await journalConversionBaseline(dir, { temperatureSensors: true }, log, clock);
    const firstBytes = await fs.readFile(entryPath(1), 'utf8');
    await journalConversionBaseline(dir, { temperatureSensors: false }, log, clock);
    expect(await fs.readFile(entryPath(1), 'utf8')).toBe(firstBytes);
  });

  it('tolerates gaps from manual pruning and continues after the highest entry', async () => {
    await journalConversionBaseline(dir, { temperatureSensors: true }, log, clock);
    await journalConversionBaseline(dir, { temperatureSensors: false }, log, clock);
    await journalConversionBaseline(dir, { windSensors: true }, log, clock);
    await fs.rm(entryPath(2)); // a user pruned an entry by hand
    expect(await journalConversionBaseline(dir, { humiditySensors: true }, log, clock)).toBe('appended');
    const entries = await readEntries();
    expect(entries.map(e => e.name)).toEqual(['entry-000001.json', 'entry-000003.json', 'entry-000004.json']);
  });

  it('ignores OS dotfiles but fails closed on any other unexpected file in the journal', async () => {
    await journalConversionBaseline(dir, { temperatureSensors: true }, log, clock);
    await fs.writeFile(nodePath.join(journalDir(), '.DS_Store'), 'finder junk');
    expect(await journalConversionBaseline(dir, { temperatureSensors: false }, log, clock)).toBe('appended');

    await fs.writeFile(nodePath.join(journalDir(), 'notes.txt'), 'what is this');
    await expect(journalConversionBaseline(dir, { windSensors: true }, log, clock))
      .rejects.toThrow(/unexpected file 'notes\.txt'/);
  });

  it('fails closed on an unparsable entry file and never rewrites it', async () => {
    await fs.mkdir(journalDir(), { recursive: true });
    await fs.writeFile(entryPath(1), '{not json');
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(entryPath(1), 'utf8')).toBe('{not json');
  });

  it('fails closed on an unrecognized schemaVersion or malformed entry', async () => {
    await fs.mkdir(journalDir(), { recursive: true });
    await fs.writeFile(entryPath(1), JSON.stringify({ schemaVersion: 99, savedAt: '2026-01-01T00:00:00Z', legacy: {} }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/unrecognized shape/);

    await fs.writeFile(entryPath(1), JSON.stringify({ schemaVersion: 1, savedAt: 'not-a-date', legacy: {} }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/unrecognized shape/);

    await fs.writeFile(entryPath(1), JSON.stringify({ schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z', legacy: [] }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/unrecognized shape/);
  });

  it('rejects an entry carrying fields outside LEGACY_SENSOR_FIELDS (the apiKey counterexample) and never rewrites it', async () => {
    // PR #46 review P2, reproduced pre-fix: this entry was ACCEPTED
    // and the credential re-persisted by the next append.
    const poisoned = JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z', legacy: { apiKey: 'secret' },
    });
    await fs.mkdir(journalDir(), { recursive: true });
    await fs.writeFile(entryPath(1), poisoned);
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock))
      .rejects.toThrow(/outside the legacy sensor-configuration vocabulary/);
    expect(await fs.readFile(entryPath(1), 'utf8')).toBe(poisoned); // untouched
  });

  it('rejects unknown entry keys', async () => {
    await fs.mkdir(journalDir(), { recursive: true });
    await fs.writeFile(entryPath(1), JSON.stringify({
      schemaVersion: 1, savedAt: '2026-01-01T00:00:00Z', legacy: { temperatureSensors: true }, note: 'hi',
    }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock))
      .rejects.toThrow(/unknown entry key 'note'/);
  });

  it('fails closed when a pre-release single-file journal is present', async () => {
    const singleFile = nodePath.join(dir, `${LEGACY_JOURNAL_DIR}.json`);
    await fs.writeFile(singleFile, JSON.stringify({ schemaVersion: 1, entries: [] }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock))
      .rejects.toThrow(/pre-release single-file conversion journal/);
    expect(await fs.readFile(singleFile, 'utf8')).toContain('"entries"'); // untouched
  });

  it('concurrent appends with DISTINCT baselines both survive (PR #46 P1: the unlocked read-modify-rename dropped one)', async () => {
    const outcomes = await Promise.all([
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
      journalConversionBaseline(dir, { temperatureSensors: false }, log, clock),
    ]);
    expect(outcomes).toEqual(['appended', 'appended']);
    const entries = await readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].legacy).toEqual({ temperatureSensors: true });
    expect(entries[1].legacy).toEqual({ temperatureSensors: false });
  });

  it('concurrent appends with IDENTICAL baselines: one appends, one deduplicates', async () => {
    const outcomes = await Promise.all([
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
    ]);
    expect(outcomes.sort()).toEqual(['appended', 'unchanged']);
    expect(await readEntries()).toHaveLength(1);
  });

  it('the lock chain is failure-safe: an append after a rejected one still runs', async () => {
    await fs.mkdir(journalDir(), { recursive: true });
    await fs.writeFile(entryPath(1), '{not json');
    const [first, second] = await Promise.allSettled([
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
      // Queued behind the failing call on the same journal's lock;
      // it must still run (and fail on the same corrupt entry, not
      // hang or get swallowed).
      journalConversionBaseline(dir, { temperatureSensors: false }, log, clock),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    await fs.rm(entryPath(1));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).resolves.toBe('appended');
  });

  it('TWO WRITER PROCESSES with distinct baselines both survive (PR #46 round-3 P1: HB UI X forks a UI server per client)', async () => {
    // A module-level lock cannot serialize separate processes — this
    // is the reproduced cross-process loss case. Safety must come
    // from the exclusive-create entry files. The child imports the
    // COMMITTED dist build (the repo tracks dist and CI rebuilds it),
    // mirroring how two real forked UI servers load the module.
    const childScript = nodePath.join(dir, 'child.mjs');
    const distUrl = pathToFileURL(nodePath.resolve(__dirname, '../../../dist/sensorMap/legacyMirror.js')).href;
    await fs.writeFile(childScript, [
      `import { journalConversionBaseline } from ${JSON.stringify(distUrl)};`,
      'const [persistDir, field] = process.argv.slice(2);',
      'const log = { info() {}, warn() {}, debug() {} };',
      'const outcome = await journalConversionBaseline(persistDir, { [field]: true }, log);',
      'process.stdout.write(outcome);',
    ].join('\n'));

    const run = (field: string): Promise<string> => new Promise((resolve, reject) => {
      execFile(process.execPath, [childScript, dir, field], (err, stdout) =>
        (err ? reject(err) : resolve(stdout.trim())));
    });
    const outcomes = await Promise.all([run('temperatureSensors'), run('windSensors')]);
    expect(outcomes.sort()).toEqual(['appended', 'appended']);

    const entries = await readEntries();
    expect(entries).toHaveLength(2);
    const baselines = entries.map(e => Object.keys(e.legacy)[0]).sort();
    expect(baselines).toEqual(['temperatureSensors', 'windSensors']);
  });

  it('TWO WRITER PROCESSES with the identical baseline: exactly one entry survives', async () => {
    const childScript = nodePath.join(dir, 'child.mjs');
    const distUrl = pathToFileURL(nodePath.resolve(__dirname, '../../../dist/sensorMap/legacyMirror.js')).href;
    await fs.writeFile(childScript, [
      `import { journalConversionBaseline } from ${JSON.stringify(distUrl)};`,
      'const [persistDir, field] = process.argv.slice(2);',
      'const log = { info() {}, warn() {}, debug() {} };',
      'const outcome = await journalConversionBaseline(persistDir, { [field]: true }, log);',
      'process.stdout.write(outcome);',
    ].join('\n'));

    const run = (field: string): Promise<string> => new Promise((resolve, reject) => {
      execFile(process.execPath, [childScript, dir, field], (err, stdout) =>
        (err ? reject(err) : resolve(stdout.trim())));
    });
    const outcomes = await Promise.all([run('temperatureSensors'), run('temperatureSensors')]);
    // Either both raced ('appended' + 'unchanged') or they ran back to
    // back with the same result — in every interleaving the journal
    // holds exactly one entry for the one distinct baseline.
    expect(outcomes).toContain('appended');
    expect(await readEntries()).toHaveLength(1);
  });
});

describe('projection property test (finding 5 — reviewer requirement)', () => {
  it('compatToOverrides(mirror) reproduces the v1-expressible portion of the v2 effective map', () => {
    const sensorMap = [
      { dataPoint: 'humidity', enabled: false },                                    // global disable
      { dataPoint: 'tempinf', stationMac: MAC2, enabled: false },                   // station-specific disable
      { dataPoint: 'uv', threshold: 7 },                                            // threshold
      // Family-uniform display unit (per-row units are not v1-expressible).
      { dataPoint: 'windspeedmph', displayUnit: 'kph' },
      { dataPoint: 'windgustmph', displayUnit: 'kph' },
      { dataPoint: 'maxdailygust', displayUnit: 'kph' },
      { dataPoint: 'lightning_day', batteryField: null },                           // battery suppression
      { dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'celsius' }, // custom
    ];
    const v2 = v2Map(sensorMap, TWO_STATIONS);
    const mirror = projectLegacyMirror(v2);

    const legacy = buildEffectiveSensorMap({
      userOverrides: compatToOverrides(mirror, TWO_STATIONS),
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
      stations: TWO_STATIONS,
      configMode: 'legacy',
    });

    // Index KNOWN configured rows by (mac, dataPoint). Custom rows are
    // deliberately excluded from the universe comparison: since the
    // Stage-4 table restoration they materialize as real rows in the
    // v2 map, but v1.7 cannot represent them — they are the explicit
    // downgrade-loss boundary, asserted separately below.
    type Rowish = { stationMac: string; dataPoint: string; enabled: boolean;
      hasBatterySubService?: boolean; structuralSignature?: string;
      threshold?: number; displayUnit?: string };
    const index = (m: EffectiveSensorMap): Map<string, Rowish> => {
      const out = new Map<string, Rowish>();
      for (const r of m.rows) {
        if (r.kind === 'unrecognized' || !defaultRowFor(r.dataPoint)) {
          continue;
        }
        out.set(`${r.stationMac}|${r.dataPoint}`, r as unknown as Rowish);
      }
      return out;
    };
    const v2Rows = index(v2);
    const legacyRows = index(legacy);

    // Same known-row universe.
    expect([...legacyRows.keys()].sort()).toEqual([...v2Rows.keys()].sort());

    for (const [key, v2Row] of v2Rows) {
      const legacyRow = legacyRows.get(key)!;
      // Structural agreement: enabled + full structural signature
      // (kind, measurement, battery ownership, wrapper identity).
      expect(legacyRow.enabled, `${key} enabled`).toBe(v2Row.enabled);
      expect(legacyRow.structuralSignature, `${key} signature`).toBe(v2Row.structuralSignature);
      // Behavioral agreement where v1.7 can express it.
      expect(legacyRow.threshold, `${key} threshold`).toBe(v2Row.threshold);
      expect(legacyRow.displayUnit, `${key} displayUnit`).toBe(v2Row.displayUnit);
    }

    // The custom dataPoint is the loss boundary: a REAL row in the v2
    // map (table restored), absent from the legacy projection, and
    // excluded by the mirror so v1.7's broad matchers can't misclassify.
    expect(v2.rows.some(r => r.dataPoint === 'barn_temp' && r.kind !== 'unrecognized')).toBe(true);
    expect(legacy.rows.some(r => r.dataPoint === 'barn_temp')).toBe(false);
    expect(mirror.excludeSensors).toContain('barn_temp');
  });
});

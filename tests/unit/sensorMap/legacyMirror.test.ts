import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compatToOverrides } from '../../../src/sensorMap/compat';
import { detectConfigMode } from '../../../src/sensorMap/configMode';
import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { defaultRowFor } from '../../../src/sensorMap/defaultMap';
import {
  LEGACY_JOURNAL_FILE,
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

describe('journalConversionBaseline (append-only, deduplicated, no secrets)', () => {
  let dir: string;
  const log = { info: () => {}, warn: () => {}, debug: () => {} };
  const clock = { iso: () => '2026-08-20T00:00:00.000Z', now: () => 1_755_648_000_000 };
  const journalPath = (): string => nodePath.join(dir, LEGACY_JOURNAL_FILE);

  beforeEach(async () => {
    dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'aws-journal-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('appends a fresh baseline, excluding secrets by the field allowlist', async () => {
    const outcome = await journalConversionBaseline(dir, { temperatureSensors: true, apiKey: 'secret' }, log, clock);
    expect(outcome).toBe('appended');
    const raw = JSON.parse(await fs.readFile(journalPath(), 'utf8')) as {
      schemaVersion: number;
      entries: Array<{ savedAt: string; legacy: Record<string, unknown> }>;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].savedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(raw.entries[0].legacy).toEqual({ temperatureSensors: true });
    const entries = await fs.readdir(dir);
    expect(entries.filter(e => e.endsWith('.tmp'))).toHaveLength(0);
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
    const raw = JSON.parse(await fs.readFile(journalPath(), 'utf8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(3);
  });

  it('fails closed on an unparsable journal and never rewrites it', async () => {
    await fs.writeFile(journalPath(), '{not json');
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(journalPath(), 'utf8')).toBe('{not json');
  });

  it('fails closed on an unrecognized schemaVersion or malformed entries', async () => {
    await fs.writeFile(journalPath(), JSON.stringify({ schemaVersion: 99, entries: [] }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/unrecognized shape/);

    await fs.writeFile(journalPath(), JSON.stringify({ schemaVersion: 1, entries: [{ savedAt: 'not-a-date', legacy: {} }] }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/unrecognized shape/);

    await fs.writeFile(journalPath(), JSON.stringify({ schemaVersion: 1, entries: [{ savedAt: '2026-01-01T00:00:00Z', legacy: [] }] }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).rejects.toThrow(/unrecognized shape/);
  });

  it('rejects a journal whose entry carries fields outside LEGACY_SENSOR_FIELDS (the apiKey counterexample) and never rewrites it', async () => {
    // PR #46 review P2, reproduced pre-fix: this journal was ACCEPTED
    // and the credential re-persisted by the next append.
    const poisoned = JSON.stringify({
      schemaVersion: 1,
      entries: [{ savedAt: '2026-01-01T00:00:00Z', legacy: { apiKey: 'secret' } }],
    });
    await fs.writeFile(journalPath(), poisoned);
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock))
      .rejects.toThrow(/outside the legacy sensor-configuration vocabulary/);
    expect(await fs.readFile(journalPath(), 'utf8')).toBe(poisoned); // untouched
  });

  it('rejects unknown envelope keys and unknown entry keys', async () => {
    await fs.writeFile(journalPath(), JSON.stringify({
      schemaVersion: 1, entries: [], extra: true,
    }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock))
      .rejects.toThrow(/unknown envelope key 'extra'/);

    await fs.writeFile(journalPath(), JSON.stringify({
      schemaVersion: 1,
      entries: [{ savedAt: '2026-01-01T00:00:00Z', legacy: { temperatureSensors: true }, note: 'hi' }],
    }));
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock))
      .rejects.toThrow(/unknown entry key 'note'/);
  });

  it('concurrent appends with DISTINCT baselines both survive (PR #46 P1: the unlocked read-modify-rename dropped one)', async () => {
    // Deterministic: both calls enter before either completes, so
    // without serialization both read the empty journal and the last
    // rename wins (reproduced: two 'appended', one surviving entry).
    // The per-path lock serializes them end-to-end.
    const outcomes = await Promise.all([
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
      journalConversionBaseline(dir, { temperatureSensors: false }, log, clock),
    ]);
    expect(outcomes).toEqual(['appended', 'appended']);
    const raw = JSON.parse(await fs.readFile(journalPath(), 'utf8')) as {
      entries: Array<{ legacy: Record<string, unknown> }>;
    };
    expect(raw.entries).toHaveLength(2);
    expect(raw.entries[0].legacy).toEqual({ temperatureSensors: true });
    expect(raw.entries[1].legacy).toEqual({ temperatureSensors: false });
  });

  it('concurrent appends with IDENTICAL baselines: one appends, one deduplicates', async () => {
    const outcomes = await Promise.all([
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
    ]);
    expect(outcomes.sort()).toEqual(['appended', 'unchanged']);
    const raw = JSON.parse(await fs.readFile(journalPath(), 'utf8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(1);
  });

  it('the lock chain is failure-safe: an append after a rejected one still runs', async () => {
    const poisoned = JSON.stringify({ schemaVersion: 99, entries: [] });
    await fs.writeFile(journalPath(), poisoned);
    const [first, second] = await Promise.allSettled([
      journalConversionBaseline(dir, { temperatureSensors: true }, log, clock),
      // Queued behind the failing call on the same journal's lock;
      // it must still run (and fail on the same corrupt journal, not
      // hang or get swallowed).
      journalConversionBaseline(dir, { temperatureSensors: false }, log, clock),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    await fs.rm(journalPath());
    await expect(journalConversionBaseline(dir, { temperatureSensors: true }, log, clock)).resolves.toBe('appended');
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

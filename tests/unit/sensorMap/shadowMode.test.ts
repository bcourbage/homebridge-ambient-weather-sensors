import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createShadowMode,
  shadowModeEnabled,
  ShadowMode,
} from '../../../src/sensorMap/shadowMode';
import { HAP_SERVICE_UUIDS, type CachedAccessoryShape } from '../../../src/sensorMap/bootstrap';
import { loadDiscoveryStore } from '../../../src/sensorMap/persistence/discoveryStore';

interface LogCapture {
  info: string[];
  warn: string[];
  debug: string[];
  error: string[];
}

function makeLog(): { log: import('../../../src/sensorMap/shadowMode').HomebridgeLogger; captured: LogCapture } {
  const c: LogCapture = { info: [], warn: [], debug: [], error: [] };
  return {
    log: {
      info: (m) => c.info.push(m),
      warn: (m) => c.warn.push(m),
      debug: (m) => c.debug.push(m),
      error: (m) => c.error.push(m),
    },
    captured: c,
  };
}

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-shadow-')); });
afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('shadowModeEnabled', () => {
  it('true when env SENSOR_MAP_V2=1', () => {
    expect(shadowModeEnabled({ env: { SENSOR_MAP_V2: '1' } })).toBe(true);
  });

  it('true when env SENSOR_MAP_V2=true', () => {
    expect(shadowModeEnabled({ env: { SENSOR_MAP_V2: 'true' } })).toBe(true);
  });

  it('true when config _sensorMapV2 is true', () => {
    expect(shadowModeEnabled({ env: {}, config: { _sensorMapV2: true } })).toBe(true);
  });

  it('true when config _sensorMapV2 is "true" string (HB UI X shape)', () => {
    expect(shadowModeEnabled({ env: {}, config: { _sensorMapV2: 'true' } })).toBe(true);
  });

  it('false when neither env nor config set', () => {
    expect(shadowModeEnabled({ env: {}, config: {} })).toBe(false);
  });

  it('false on unrelated env var values', () => {
    expect(shadowModeEnabled({ env: { SENSOR_MAP_V2: 'yes' } })).toBe(false);
    expect(shadowModeEnabled({ env: { SENSOR_MAP_V2: '0' } })).toBe(false);
  });
});

describe('createShadowMode factory', () => {
  it('returns undefined when the flag is off', () => {
    const { log } = makeLog();
    const s = createShadowMode({
      log,
      config: {},
      api: { user: { storagePath: () => tmpRoot } },
    });
    expect(s).toBeUndefined();
  });

  it('returns a ShadowMode instance when _sensorMapV2 is set', () => {
    const { log, captured } = makeLog();
    const s = createShadowMode({
      log,
      config: { _sensorMapV2: true },
      api: { user: { storagePath: () => tmpRoot } },
    });
    expect(s).toBeInstanceOf(ShadowMode);
    expect(captured.info.some(l => l.includes('[sensor-map v2 shadow] enabled'))).toBe(true);
  });
});

describe('ShadowMode.initialize', () => {
  it('logs the detected config mode', async () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { configVersion: 2 as unknown as undefined, _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    expect(captured.info.some(l => l.includes('config mode: v2'))).toBe(true);
  });

  it('warns on safe mode with the banner', async () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { configVersion: 99 as unknown as undefined, _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    expect(captured.warn.some(l => l.includes('SAFE MODE'))).toBe(true);
    expect(captured.warn.some(l => l.includes('newer plugin version'))).toBe(true);
  });

  it('warns on ambiguous v2+legacy config', async () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { configVersion: 2, temperatureSensors: true, _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    expect(captured.warn.some(l => l.includes('configVersion: 2 takes precedence'))).toBe(true);
  });
});

describe('ShadowMode.onConfigureAccessory', () => {
  it('logs an inferred kind/measurement for a legacy-type cached accessory', () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    s.onConfigureAccessory({
      context: { device: { uniqueId: 'AA:BB:CC:DD:EE:01-tempf', type: 'Temperature' } },
      services: [],
    });
    expect(captured.debug.some(l => l.includes('kind=temperature'))).toBe(true);
  });

  it('logs preserve-cached for an accessory with no legacy type + no services', () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    s.onConfigureAccessory({
      context: { device: { uniqueId: 'AA:BB:CC:DD:EE:01-mystery' } },
    });
    expect(captured.debug.some(l => l.includes('preserve-cached'))).toBe(true);
  });

  it('dedupes repeated calls for the same uniqueId', () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    const accessory = {
      context: { device: { uniqueId: 'AA:BB:CC:DD:EE:01-tempf', type: 'Temperature' } },
      services: [],
    };
    s.onConfigureAccessory(accessory);
    s.onConfigureAccessory(accessory);
    expect(captured.debug.filter(l => l.includes('AA:BB:CC:DD:EE:01-tempf')).length).toBe(1);
  });
});

describe('ShadowMode.onParseTick', () => {
  it('feeds the discovery tracker with every observed key', async () => {
    const { log } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [
        { stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' },
        { stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'battout' },
      ],
      v1Decisions: [
        { stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' },
      ],
    });
    await s.shutdown();
    const loaded = await loadDiscoveryStore(
      path.join(tmpRoot, 'plugin-data', 'ambient-weather', 'discovery.json'),
      { info: () => {}, warn: () => {}, debug: () => {} },
    );
    const keys = loaded.entries.map(e => e.dataPoint).sort();
    expect(keys).toEqual(['battout', 'tempf']);
  });

  it('reports divergence when v2 would drop a v1-registered field', () => {
    const { log, captured } = makeLog();
    // temperatureSensors is FALSE — v2's compat layer disables temperature
    // rows. But we simulate v1.6.0 registering tempf anyway (impossible
    // in real life, but the divergence log is what we're testing).
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    });
    expect(captured.info.some(l => l.includes('v2 would DROP'))).toBe(true);
  });

  it('reports divergence when v2 would register a v1-dropped field', () => {
    const { log, captured } = makeLog();
    // temperatureSensors true → v2 enables tempf. v1Decisions empty
    // simulates v1.6.0 dropping the field.
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [],
    });
    expect(captured.info.some(l => l.includes('v2 would register'))).toBe(true);
  });

  it('no divergence when both paths agree', () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    });
    expect(captured.info.filter(l => l.includes('would'))).toHaveLength(0);
  });

  it('dedupes divergence logs — one line per unique key per boot', () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    const tick = {
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    };
    s.onParseTick(tick);
    s.onParseTick(tick);
    expect(captured.info.filter(l => l.includes('v2 would DROP'))).toHaveLength(1);
  });
});

describe('ShadowMode — end-to-end smoke', () => {
  it('initialize → observe → shutdown persists discovery.json', async () => {
    const { log } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    // Configure a cached temperature accessory.
    s.onConfigureAccessory({
      context: { device: { uniqueId: 'AA:BB:CC:DD:EE:01-tempf', type: 'Temperature' } },
      services: [{ UUID: HAP_SERVICE_UUIDS.TEMPERATURE_SENSOR }],
    });
    // Simulate a poll tick.
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    });
    await s.shutdown();
    // Verify persistence file was created.
    const dp = path.join(tmpRoot, 'plugin-data', 'ambient-weather', 'discovery.json');
    const stat = await fs.stat(dp);
    expect(stat.isFile()).toBe(true);
  });
});

/**
 * Regression guard for the v2.0.0-beta.1 EISDIR crash. HAP-NodeJS
 * scans <storagePath>/persist/ via node-persist, which does
 * readFileSync on every entry — dropping a subdirectory inside that
 * path crashes HAP on the next child-bridge start.
 *
 * The ShadowMode.HomebridgeApi type deliberately declares
 * `storagePath()` (not `persistPath()`) so a future refactor can't
 * silently regress this. This test locks in the API surface AND
 * verifies the derived plugin-data path is NOT under a `persist`
 * subdirectory.
 */
describe('ShadowMode — HAP storage collision regression (beta.1 EISDIR)', () => {
  it('accepts storagePath() as the api surface (not persistPath)', () => {
    // Compile-time assertion: HomebridgeApi has storagePath, not persistPath.
    // If this test file compiles, the type is correct.
    const api: import('../../../src/sensorMap/shadowMode').HomebridgeApi = {
      user: { storagePath: () => tmpRoot },
    };
    // Sanity: constructor accepts it.
    const { log } = makeLog();
    expect(() => new ShadowMode({ log, config: { _sensorMapV2: true } as never, api })).not.toThrow();
  });

  it('warns on startup if the beta.0/beta.1 orphan directory still exists', async () => {
    // Simulate a leftover from the buggy earlier beta.
    const leftover = path.join(tmpRoot, 'persist', 'plugin-data', 'ambient-weather');
    await fs.mkdir(leftover, { recursive: true });
    await fs.writeFile(path.join(leftover, 'discovery.json'), '{"schemaVersion":1,"entries":[]}', 'utf8');

    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();

    expect(captured.warn.some(l => l.includes('orphan directory from v2.0.0-beta'))).toBe(true);
    expect(captured.warn.some(l => l.includes(leftover))).toBe(true);
    expect(captured.warn.some(l => l.includes('rm -rf'))).toBe(true);
  });

  it('is silent about the orphan directory when it does not exist', async () => {
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    expect(captured.warn.filter(l => l.includes('orphan directory'))).toHaveLength(0);
  });

  it('writes plugin data under <storagePath>/plugin-data/, NOT under <storagePath>/persist/', async () => {
    const { log } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [],
    });
    await s.shutdown();

    // Positive: plugin-data/ exists under storage root.
    const good = path.join(tmpRoot, 'plugin-data', 'ambient-weather', 'discovery.json');
    await expect(fs.stat(good)).resolves.toBeTruthy();

    // Negative: NOTHING under persist/. HAP owns that path.
    const bad = path.join(tmpRoot, 'persist');
    await expect(fs.access(bad)).rejects.toBeTruthy();
  });
});

// ---- Review finding #5: observer must exercise real config mode ----

describe('ShadowMode — config mode drives the parallel pipeline (finding #5)', () => {
  it('v2 mode: reads `sensorMap` as unknown[] and validates it, not compat output', async () => {
    // A malformed sensorMap entry (name: 42) MUST surface as a
    // validation error under v2 mode. Under legacy mode this
    // entry would never be reached (compat emits well-formed
    // synthetic overrides only), so the error surfacing here is
    // a positive signal that v2 is actually being exercised.
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: {
        _sensorMapV2: true,
        configVersion: 2,
        sensorMap: [{ dataPoint: 'tempf', name: 42 }],
      } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    });
    expect(captured.info.some(l => /config mode: v2/.test(l))).toBe(true);
    expect(captured.info.some(l => /v2 override validation error/.test(l) && /name/i.test(l))).toBe(true);
    await s.shutdown();
  });

  it('v2 mode: non-array `sensorMap` surfaces a divergence line, not a silent empty', async () => {
    // A malformed sensorMap (string, object, number, null) MUST
    // announce itself in the observer log — silently treating it
    // as empty means the observer validates the default-exposure
    // layout instead of the config the user wrote. The observer
    // logs a "sensormap-not-array" divergence and then falls back
    // to an empty override list so the parallel pipeline stays up.
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: {
        _sensorMapV2: true,
        configVersion: 2,
        sensorMap: 'oops',
      } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    try {
      await s.initialize();
      expect(() =>
        s.onParseTick({
          stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
          observed: [],
          v1Decisions: [],
        }),
      ).not.toThrow();
      expect(captured.info.some(l => /sensorMap must be an array.*got string/.test(l))).toBe(true);
    } finally {
      await s.shutdown();
    }
  });

  it('safe mode: onParseTick short-circuits (no divergence lines, no errors)', async () => {
    // configVersion > CURRENT enters safe mode. The observer must
    // NOT run its parallel pipeline — the config is uninterpretable
    // and any effective-map output would be noise.
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: {
        _sensorMapV2: true,
        configVersion: 999,
      } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    });
    // Safe mode was logged at initialize.
    expect(captured.info.some(l => /config mode: safe-mode/.test(l))).toBe(true);
    // (1) No divergence lines from parseTick — the pipeline never ran.
    expect(captured.info.filter(l => /would DROP|would register|validation (error|warning)/.test(l))).toHaveLength(0);
    // (2) Safe mode is contractually read-only per §5: the plugin
    // must NOT create the persist tree or write discovery.json.
    // Regression guard for the review finding that safe mode
    // still wrote discovery state.
    const persistDir = path.join(tmpRoot, 'plugin-data', 'ambient-weather');
    await expect(fs.access(persistDir)).rejects.toBeTruthy();
    await s.shutdown();
    // After shutdown too — shutdown() has no tracker to flush.
    await expect(fs.access(persistDir)).rejects.toBeTruthy();
  });

  it('legacy mode: falls through to compat (unchanged behavior)', async () => {
    // Sanity that the routing change didn't regress the legacy
    // path. temperatureSensors=true + observed tempf + v1 registered
    // it → no divergence (both agree).
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [{ stationMac: 'AA:BB:CC:DD:EE:01', stationName: 'Home', dataPoint: 'tempf' }],
      v1Decisions: [{ stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf', type: 'Temperature' }],
    });
    expect(captured.info.some(l => /config mode: legacy/.test(l))).toBe(true);
    expect(captured.info.filter(l => /would/.test(l))).toHaveLength(0);
    await s.shutdown();
  });
});

// ---- Review finding #11: preserve-cached retry (§17.3) ---------------

describe('ShadowMode — preserve-cached recovery (finding #11)', () => {
  it('re-attempts inference on every parse tick and logs a recovered line once the row resolves', async () => {
    // A cached accessory whose kind+measurement isn't inferable at
    // startup — no legacy type field, unknown dataPoint. It stays
    // in the preserved set until a parse tick discovers it and the
    // default map (or a plugin update) resolves it.
    //
    // We simulate the recovery by mutating the accessory's context
    // BETWEEN parse ticks — a `type` field appears (as if a plugin
    // update taught inferForCachedAccessory a new legacy string).
    // A production recovery would look different (default-map
    // update, or AWN newly reporting the field), but the code path
    // exercised is identical: preserved accessories are re-inferred
    // and dropped from the set when resolution succeeds.
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, temperatureSensors: true } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();

    // Cached accessory with only a uniqueId — inferForCachedAccessory
    // returns preserve-cached.
    const accessory: CachedAccessoryShape = {
      context: { device: { uniqueId: 'AA:BB:CC:DD:EE:01-mystery' } },
    };
    s.onConfigureAccessory(accessory);
    expect(captured.debug.some(l => l.includes('preserve-cached'))).toBe(true);

    // First parse tick — nothing changed on the accessory; still
    // preserve-cached, no info-level "recovered" line yet.
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [],
      v1Decisions: [],
    });
    expect(captured.info.filter(l => l.includes('recovered')).length).toBe(0);

    // Simulate resolution: something about the accessory's context
    // now lets inferForCachedAccessory succeed.
    (accessory.context!.device as { type?: string }).type = 'Temperature';

    // Next parse tick — the retry should now find the accessory
    // inferable, log the recovery, and drop it from the preserved
    // set.
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [],
      v1Decisions: [],
    });
    expect(captured.info.some(l =>
      /recovered.*kind=temperature/.test(l) && l.includes('AA:BB:CC:DD:EE:01-mystery'),
    )).toBe(true);

    // Third tick — accessory no longer in the preserved set, so no
    // duplicate recovery line fires.
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [],
      v1Decisions: [],
    });
    expect(captured.info.filter(l => l.includes('recovered')).length).toBe(1);

    await s.shutdown();
  });

  it('does not retry in safe mode (short-circuit stays before recovery)', async () => {
    // Safe mode's onParseTick returns immediately per §5. That
    // includes the preserve-cached recovery — we must not touch
    // the retry map in safe mode, which would happen if the retry
    // ran before the short-circuit.
    const { log, captured } = makeLog();
    const s = new ShadowMode({
      log,
      config: { _sensorMapV2: true, configVersion: 999 } as never,
      api: { user: { storagePath: () => tmpRoot } },
    });
    await s.initialize();
    const accessory: CachedAccessoryShape = {
      context: { device: { uniqueId: 'AA:BB:CC:DD:EE:01-mystery' } },
    };
    s.onConfigureAccessory(accessory);
    // Even if the accessory becomes resolvable, safe mode must not
    // announce recovery — the parallel pipeline is quiet.
    (accessory.context!.device as { type?: string }).type = 'Temperature';
    s.onParseTick({
      stations: [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }],
      observed: [],
      v1Decisions: [],
    });
    expect(captured.info.filter(l => l.includes('recovered')).length).toBe(0);
    await s.shutdown();
  });
});

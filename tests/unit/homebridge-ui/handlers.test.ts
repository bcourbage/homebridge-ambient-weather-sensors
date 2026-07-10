import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleGetDiscovery,
  handleGetNotices,
  handleGetStatus,
  handleGetUiState,
  type HandlerDeps,
} from '../../../homebridge-ui/handlers.ts';

let tmpRoot: string;
let persistDir: string;

const silentLog = {
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  debug: () => { /* noop */ },
};

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    persistDir,
    log: silentLog,
    version: '2.0.0-beta.0',
    env: {},
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-ui-'));
  persistDir = path.join(tmpRoot, 'plugin-data', 'ambient-weather');
});
afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('handleGetStatus', () => {
  it('returns legacy mode for a bare config', async () => {
    const r = await handleGetStatus(deps(), { config: {} });
    expect(r.configMode).toBe('legacy');
    expect(r.shadowFlag.enabled).toBe(false);
    expect(r.shadowFlag.source).toBe('none');
    expect(r.readOnly).toBe(true);
  });

  it('reports v2 mode with legacy-toggle ambiguity warn', async () => {
    const r = await handleGetStatus(deps(), {
      config: { configVersion: 2, temperatureSensors: true },
    });
    expect(r.configMode).toBe('v2');
    expect(r.configWarnings.some(w => /precedence/.test(w))).toBe(true);
  });

  it('surfaces safe-mode banner for future configVersion', async () => {
    const r = await handleGetStatus(deps(), { config: { configVersion: 99 } });
    expect(r.configMode).toBe('safe-mode');
    expect(r.safeModeBanner).toMatch(/newer plugin version/);
  });

  it('detects shadow flag from env', async () => {
    const r = await handleGetStatus(
      deps({ env: { SENSOR_MAP_V2: '1' } }),
      { config: {} },
    );
    expect(r.shadowFlag.enabled).toBe(true);
    expect(r.shadowFlag.source).toBe('env');
  });

  it('detects shadow flag from config field', async () => {
    const r = await handleGetStatus(deps(), { config: { _sensorMapV2: true } });
    expect(r.shadowFlag.enabled).toBe(true);
    expect(r.shadowFlag.source).toBe('config');
  });

  it('env source wins when both env and config are set', async () => {
    const r = await handleGetStatus(
      deps({ env: { SENSOR_MAP_V2: '1' } }),
      { config: { _sensorMapV2: true } },
    );
    expect(r.shadowFlag.source).toBe('env');
  });

  it('handles missing payload gracefully', async () => {
    const r = await handleGetStatus(deps(), undefined);
    expect(r.configMode).toBe('legacy');
  });

  it('always reports readOnly: true during Path B', async () => {
    const r = await handleGetStatus(deps(), { config: { configVersion: 2 } });
    expect(r.readOnly).toBe(true);
  });

  it('reports the version from deps', async () => {
    const r = await handleGetStatus(deps({ version: '2.0.0-beta.5' }), { config: {} });
    expect(r.version).toBe('2.0.0-beta.5');
  });
});

describe('handleGetDiscovery', () => {
  it('returns empty when discovery.json is absent', async () => {
    const r = await handleGetDiscovery(deps());
    expect(r.entries).toEqual([]);
  });

  it('returns the persisted store when present', async () => {
    await fs.mkdir(persistDir, { recursive: true });
    const store = {
      schemaVersion: 1 as const,
      entries: [{
        stationMac: 'AA:BB:CC:DD:EE:01',
        stationName: 'Home',
        dataPoint: 'tempf',
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-09T21:00:00.000Z',
      }],
    };
    await fs.writeFile(path.join(persistDir, 'discovery.json'), JSON.stringify(store), 'utf8');
    const r = await handleGetDiscovery(deps());
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].dataPoint).toBe('tempf');
  });
});

describe('handleGetNotices', () => {
  it('returns empty when notices.json is absent', async () => {
    const r = await handleGetNotices(deps());
    expect(r.notices).toEqual([]);
  });
});

describe('handleGetUiState', () => {
  it('returns empty when ui-state.json is absent', async () => {
    const r = await handleGetUiState(deps());
    expect(r.dismissedNoticeIds).toEqual([]);
    expect(r.forgottenFields).toEqual([]);
  });
});

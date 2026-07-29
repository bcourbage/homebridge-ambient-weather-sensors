/**
 * v2-config downgrade guard (1.7.1) — the safety net for a plugin
 * downgraded onto a configuration written by the 2.x line.
 *
 * Contract: on detecting `configVersion >= 2` (or a malformed
 * configVersion) or a `sensorMap` field, didFinishLaunching returns
 * BEFORE discovery, persistence initialization, network access, or any
 * reconciliation. Cached accessories remain published with last-known
 * values: zero register / unregister / update calls, zero fetches.
 */

import { describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform, isUnsupportedNewerConfig } from '../../src/platform';
import { MockAPI, MockLogger, MockServices, MockCharacteristics, makeMockAccessory } from '../helpers/mockHomebridge';

function makePlatform(config: Record<string, unknown>): { platform: AmbientWeatherSensorsPlatform; api: MockAPI; log: MockLogger } {
  const api = new MockAPI();
  const log = new MockLogger();
  const platform = new AmbientWeatherSensorsPlatform(
    log as never,
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', ...config } as never,
    api as never,
  );
  return { platform, api, log };
}

function addCached(platform: AmbientWeatherSensorsPlatform, uniqueId: string): void {
  const a = makeMockAccessory({ uniqueId, type: 'Temperature', displayName: 'Cached ' + uniqueId, value: 20 });
  const svc = a.addService(MockServices.TemperatureSensor);
  svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
  platform.configureAccessory(a as never);
}

describe('isUnsupportedNewerConfig', () => {
  it('freezes on every defined configVersion except 1, and on sensorMap presence', () => {
    // Newer-plugin markers.
    expect(isUnsupportedNewerConfig({ configVersion: 2 })).toBe(true);
    expect(isUnsupportedNewerConfig({ configVersion: 3 })).toBe(true);
    expect(isUnsupportedNewerConfig({ sensorMap: [] })).toBe(true);
    expect(isUnsupportedNewerConfig({ sensorMap: [{ dataPoint: 'tempf' }] })).toBe(true);
    // Malformed values — none may reach the destructive 1.x path.
    expect(isUnsupportedNewerConfig({ configVersion: '2' })).toBe(true);
    expect(isUnsupportedNewerConfig({ configVersion: 1.5 })).toBe(true);
    expect(isUnsupportedNewerConfig({ configVersion: 0 })).toBe(true);
    expect(isUnsupportedNewerConfig({ configVersion: -1 })).toBe(true);
    expect(isUnsupportedNewerConfig({ configVersion: null })).toBe(true);
    expect(isUnsupportedNewerConfig({ configVersion: NaN })).toBe(true);
  });

  it('passes normal 1.x configs through', () => {
    expect(isUnsupportedNewerConfig({})).toBe(false);
    expect(isUnsupportedNewerConfig({ configVersion: 1 })).toBe(false);
    expect(isUnsupportedNewerConfig({ temperatureSensors: true } as never)).toBe(false);
  });
});

describe('didFinishLaunching guard', () => {
  const V2_SHAPES: Array<[string, Record<string, unknown>]> = [
    ['configVersion: 2', { configVersion: 2 }],
    ['sensorMap only', { sensorMap: [{ dataPoint: 'tempf', name: 'Patio' }] }],
    ['full migrated config', { configVersion: 2, sensorMap: [], temperatureSensors: true }],
    // Malformed versions without legacy toggles: the exact shape that
    // would otherwise reconcile to an empty set and wipe the cache.
    ['malformed configVersion: 0', { configVersion: 0 }],
    ['malformed configVersion: -1', { configVersion: -1 }],
    ['malformed configVersion: null', { configVersion: null }],
    ['malformed configVersion: NaN', { configVersion: NaN }],
  ];

  for (const [label, cfg] of V2_SHAPES) {
    it(`freezes on a 2.x config (${label}): cache stays published, zero HAP calls, no network`, () => {
      const { platform, api, log } = makePlatform(cfg);
      addCached(platform, 'AA:BB:CC:DD:EE:01-tempf');
      addCached(platform, 'AA:BB:CC:DD:EE:01-tempinf');

      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
        throw new Error('network access is forbidden under the guard');
      });
      const intervalSpy = vi.spyOn(global, 'setInterval');

      api.emit('didFinishLaunching');

      // Cached accessories remain published, untouched.
      expect(platform.accessories).toHaveLength(2);
      expect(api.registered).toHaveLength(0);
      expect(api.unregistered).toHaveLength(0);
      expect(api.updated).toHaveLength(0);
      // No discovery fetch, no poll/realtime timers, no reconciliation.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(intervalSpy).not.toHaveBeenCalled();
      // The banner explains the freeze at error level.
      expect(log.find('error', 'written by plugin version 2.x').length).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });
  }

  it('a normal 1.x config still runs discovery', () => {
    const { platform, api } = makePlatform({ temperatureSensors: true });
    addCached(platform, 'AA:BB:CC:DD:EE:01-tempf');

    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify([]), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

    api.emit('didFinishLaunching');

    expect(fetchSpy).toHaveBeenCalled();
    expect(platform).toBeDefined();
    vi.restoreAllMocks();
  });
});

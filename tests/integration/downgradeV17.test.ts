/**
 * Downgrade lifecycle fixtures (finding 5; reworked per review #45
 * round 3).
 *
 * The REAL downgrade journey for an editor-generated v2 config has
 * two shipped halves:
 *
 *   1. GUARD FREEZE (markers present): a downgraded v1.7.1+ detects
 *      `configVersion`/`sensorMap` in didFinishLaunching and freezes —
 *      zero fetch, zero reconciliation, cache preserved. That
 *      lifecycle is pinned ON THE 1.x BRANCH, where the guard lives:
 *      release/1.7.0 → tests/integration/configGuard.test.ts
 *      ("freezes on a 2.x config: cache stays published, zero HAP
 *      calls, no network"). HEAD cannot run 1.7.1 code, so it is not
 *      re-tested here.
 *
 *   2. DOCUMENTED CURRENT-STATE MANUAL ROLLBACK (this file's first
 *      test): with a recognized editor-generated mirror, delete
 *      exactly `sensorMap`, `configVersion`, and `_legacyMirror`,
 *      leave the v2 flag off, and the remaining synchronized legacy
 *      fields ARE a working 1.x configuration — the legacy pipeline
 *      keeps every representable accessory with zero unregister
 *      calls; custom rows are the explicit loss boundary. Exercised
 *      through didFinishLaunching against HEAD's flag-off path, which
 *      Stage 4 keeps byte-identical to the v1.7.0 registration
 *      pipeline.
 *
 * The second test in this file is a HISTORICAL HAZARD ILLUSTRATION,
 * not a downgrade journey: it runs v1.7.0-ERA parser semantics
 * against a STILL-MARKED v2 config (v1.7.0 ignored unknown keys and
 * read the mirrored legacy fields). Shipped 1.7.1+ freezes instead of
 * ever doing this — the test exists to pin what the mirror protects
 * against on ancient versions, and must not be cited as the real
 * journey.
 */

import { describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { buildEffectiveSensorMap } from '../../src/sensorMap/buildEffectiveMap';
import { detectConfigMode } from '../../src/sensorMap/configMode';
import { composeV2ConfigSave } from '../../src/sensorMap/legacyMirror';
import { emptyDiscoveryStore } from '../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../src/sensorMap/persistence/uiStateStore';
import { computeStructuralSignature } from '../../src/sensorMap/structuralSignature';
import { wrapperById } from '../../src/sensorMap/wrappers';
import type { StationInventory } from '../../src/sensorMap/types';
import type { WrapperId } from '../../src/sensorMap/types';
import {
  MockAPI,
  MockLogger,
  MockPlatformAccessory,
  MockServices,
  MockCharacteristics,
  mockUuidGenerate,
} from '../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';
const STATIONS: StationInventory = [{ macAddress: MAC, name: 'Home' }];

/** A v2-written cached accessory: legacy type + row identity fields. */
function v2CachedAccessory(opts: {
  dataPoint: string; type: string; displayName: string;
  kind: string; measurement: string; wrapperId?: WrapperId; battery?: boolean;
  services: (a: MockPlatformAccessory) => void;
}): MockPlatformAccessory {
  const uniqueId = `${MAC}-${opts.dataPoint}`;
  const a = new MockPlatformAccessory(opts.displayName, mockUuidGenerate(uniqueId));
  const structuralSignature = opts.wrapperId
    ? computeStructuralSignature(
      opts.kind as never, opts.measurement, opts.battery ?? false, wrapperById(opts.wrapperId),
    )
    : 'custom|unknown';
  a.context.device = {
    uniqueId,
    macAddress: MAC,
    type: opts.type,
    displayName: opts.displayName,
    value: 20,
    kind: opts.kind,
    measurement: opts.measurement,
    structuralSignature,
  };
  opts.services(a);
  return a;
}

describe('downgrade journeys: editor-generated v2 config + v2-written cache', () => {
  it('DOCUMENTED current-state rollback from the CONFIG-FLAG save path: compose preserves the flag, rollback disables it, representables survive', async () => {
    // ---- 1. The v2 config as the UI save flow writes it.
    const sensorMap = [
      { dataPoint: 'humidity', enabled: false },                 // disabled in v2 → stays gone in v1.7
      { dataPoint: 'tempf', name: 'Patio' },                     // rename (behavioral; lost on downgrade)
      { dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'celsius' }, // custom
    ];
    const v2Map = buildEffectiveSensorMap({
      userOverrides: sensorMap,
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
      stations: STATIONS,
      configMode: 'v2',
    });
    // The NORMAL save path (review #45 round 4): the config-flag
    // opt-in is present on the base — /compose-save requires it — and
    // composition must PRESERVE it into the saved block.
    const { nextConfig } = composeV2ConfigSave(
      { apiKey: 'k', applicationKey: 'k', _sensorMapV2: true }, sensorMap, v2Map,
      detectConfigMode({ } as never).mode,
    );
    expect((nextConfig as Record<string, unknown>)._sensorMapV2).toBe(true);

    // ---- 2. The v2-written cache: native + extended + battery host.
    // ---- 1b. The DOCUMENTED current-state rollback (review #45
    //          round 3): with a recognized mirror, delete exactly the
    //          three v2 markers and keep everything else; the v2 flag
    //          is absent (off). The synchronized legacy fields remain.
    const rolledBack = { ...nextConfig } as Record<string, unknown>;
    delete rolledBack.sensorMap;
    delete rolledBack.configVersion;
    delete rolledBack._legacyMirror;
    // The documented procedure EXPLICITLY disables the config flag —
    // without this deletion the live v2 path would stay enabled and
    // this assertion catches any regression that forgets it.
    delete rolledBack._sensorMapV2;
    expect('_sensorMapV2' in rolledBack).toBe(false);
    expect(rolledBack.temperatureSensors).toBe(true); // the mirror's fields survive

    const api = new MockAPI();
    const log = new MockLogger();
    const platform = new AmbientWeatherSensorsPlatform(
      log as never,
      { platform: 'AmbientWeatherSensors', ...rolledBack } as never,
      api as never,
    );
    const tempf = v2CachedAccessory({
      dataPoint: 'tempf', type: 'Temperature', displayName: 'Patio',
      kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature', battery: true,
      services: (a) => {
        const svc = a.addService(MockServices.TemperatureSensor);
        svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
        const batt = a.addService(MockServices.Battery);
        batt.addCharacteristic(MockCharacteristics.StatusLowBattery);
      },
    });
    const pressure = v2CachedAccessory({
      dataPoint: 'baromabsin', type: 'PressureAbsolute', displayName: 'Pressure Station',
      kind: 'motion', measurement: 'pressure', wrapperId: 'pressure-absolute',
      services: (a) => {
        a.addService(MockServices.MotionSensor);
      },
    });
    const humidityIn = v2CachedAccessory({
      dataPoint: 'humidityin', type: 'Humidity', displayName: 'Indoor Humidity',
      kind: 'humidity', measurement: 'humidity', wrapperId: 'humidity',
      services: (a) => {
        const svc = a.addService(MockServices.HumiditySensor);
        svc.addCharacteristic(MockCharacteristics.CurrentRelativeHumidity);
      },
    });
    // A future-v2 custom accessory (post-table-restore shape) — the
    // explicit downgrade-loss boundary.
    const custom = v2CachedAccessory({
      dataPoint: 'barn_temp', type: 'CustomSensor', displayName: 'Barn Temp',
      kind: 'temperature', measurement: 'temperature',
      services: (a) => {
        const svc = a.addService(MockServices.TemperatureSensor);
        svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
      },
    });
    for (const a of [tempf, pressure, humidityIn, custom]) {
      platform.configureAccessory(a as never);
    }

    // ---- 3. Boot v1.7 registration semantics against a live payload
    //         that includes the custom dataPoint AWN-side.
    const awnPayload = [{
      macAddress: MAC,
      info: { name: 'Home' },
      lastData: {
        tempf: 68, humidity: 40, humidityin: 50, baromabsin: 29.92,
        battout: 1, battin: 1, barn_temp: 21,
      },
    }];
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(awnPayload), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

    // The FULL lifecycle: didFinishLaunching detects the (now marker-
    // free) config as 'legacy' and runs the flag-off pipeline — the
    // same route a real restart takes after the manual rollback.
    api.emit('didFinishLaunching');
    await vi.waitFor(() => {
      expect(api.updated).toContain(tempf);
    });

    // Every representable known accessory survives with ZERO
    // unregister calls; the custom cache is the only loss.
    expect(api.unregistered).toEqual([custom]);
    expect(platform.accessories).toContain(tempf);
    expect(platform.accessories).toContain(pressure);
    expect(platform.accessories).toContain(humidityIn);
    // v2-disabled humidity stays gone: the mirror's exclusion prevents
    // (re-)registration even though AWN reports it.
    expect(api.registered.some(a => (a.context.device as { uniqueId?: string }).uniqueId === `${MAC}-humidity`)).toBe(false);
    // The custom dataPoint is NEVER misregistered as a wrong-wrapper
    // accessory despite barn_temp.includes('temp') and
    // temperatureSensors: true in the mirror.
    expect(api.registered.some(a => (a.context.device as { uniqueId?: string }).uniqueId === `${MAC}-barn_temp`)).toBe(false);

    // The representable accessories were restored (v1.7 update path) —
    // wrappers exist and the rename fell back to the friendly name.
    expect(api.updated).toContain(tempf);
    expect(tempf.displayName).toBe('Outdoor Temperature');

    vi.restoreAllMocks();
  });

  it('DOCUMENTED current-state rollback from the ENVIRONMENT-FLAG save path: SENSOR_MAP_V2 must be unset for the legacy lifecycle', async () => {
    // Variant: the opt-in came from the environment, so the config
    // never carried _sensorMapV2 — the rollback is the three marker
    // deletions plus UNSETTING the environment variable.
    const sensorMap = [{ dataPoint: 'humidity', enabled: false }];
    const v2Map = buildEffectiveSensorMap({
      userOverrides: sensorMap,
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
      stations: STATIONS,
      configMode: 'v2',
    });
    const { nextConfig } = composeV2ConfigSave(
      { apiKey: 'k', applicationKey: 'k' }, sensorMap, v2Map,
      detectConfigMode({} as never).mode,
    );
    expect('_sensorMapV2' in (nextConfig as Record<string, unknown>)).toBe(false);
    const rolledBack = { ...nextConfig } as Record<string, unknown>;
    delete rolledBack.sensorMap;
    delete rolledBack.configVersion;
    delete rolledBack._legacyMirror;

    // The environment-enabled installation is REAL in this test
    // (review #45 round 5): SENSOR_MAP_V2 is set, the v2 path is
    // positively proven enabled, and only the documented UNSET flips
    // the platform back to the legacy path — omit the unset and the
    // lifecycle enters the v2 reconciler, failing the v2Routing
    // discriminator below (mutation-verified).
    const envBefore = process.env.SENSOR_MAP_V2;
    process.env.SENSOR_MAP_V2 = '1';
    try {
      // Positive proof the env flag drives the v2 path: a platform
      // constructed NOW (env set) has the live v2 opt-in even though
      // the rolled-back config carries no _sensorMapV2.
      const probe = new AmbientWeatherSensorsPlatform(
        new MockLogger() as never,
        { platform: 'AmbientWeatherSensors', ...rolledBack } as never,
        new MockAPI() as never,
      );
      expect((probe as unknown as { sensorMapV2: boolean }).sensorMapV2).toBe(true);

      // The documented rollback step: UNSET the environment variable
      // BEFORE the legacy platform starts.
      delete process.env.SENSOR_MAP_V2;

      const api = new MockAPI();
      const platform = new AmbientWeatherSensorsPlatform(
        new MockLogger() as never,
        { platform: 'AmbientWeatherSensors', ...rolledBack } as never,
        api as never,
      );
      expect((platform as unknown as { sensorMapV2: boolean }).sensorMapV2).toBe(false);
      const tempf = v2CachedAccessory({
        dataPoint: 'tempf', type: 'Temperature', displayName: 'Outdoor Temperature',
        kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature', battery: true,
        services: (a) => {
          const svc = a.addService(MockServices.TemperatureSensor);
          svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
          const batt = a.addService(MockServices.Battery);
          batt.addCharacteristic(MockCharacteristics.StatusLowBattery);
        },
      });
      platform.configureAccessory(tempf as never);
      vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify([{
        macAddress: MAC, info: { name: 'Home' },
        lastData: { tempf: 68, humidity: 40, battout: 1 },
      }]), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

      api.emit('didFinishLaunching');
      await vi.waitFor(() => {
        expect(api.updated).toContain(tempf);
      });
      expect(api.unregistered).not.toContain(tempf);
      // v2-disabled humidity stays excluded via the mirror.
      expect(api.registered.some(a => (a.context.device as { uniqueId?: string }).uniqueId === `${MAC}-humidity`)).toBe(false);
      // THE DISCRIMINATOR: the legacy lifecycle never builds a v2
      // routing map. If the unset above is omitted, didFinishLaunching
      // runs the v2 reconciler instead and this fails.
      expect((platform as unknown as { v2Routing: unknown }).v2Routing).toBeUndefined();
      vi.restoreAllMocks();
    } finally {
      if (envBefore !== undefined) {
        process.env.SENSOR_MAP_V2 = envBefore;
      } else {
        delete process.env.SENSOR_MAP_V2;
      }
    }
  });

  it('HISTORICAL HAZARD (v1.7.0-era ONLY, not the documented journey): raw parser reads a STILL-MARKED v2 config via the mirror', async () => {
    // v1.7.0 and earlier ignored unknown config keys and attempted to
    // interpret whatever legacy fields were present — the mirror is
    // what made that survivable for representable accessories. Shipped
    // v1.7.1+ NEVER does this: its guard freezes on the markers first
    // (pinned on release/1.7.0 in tests/integration/configGuard.test.ts).
    const sensorMap = [
      { dataPoint: 'humidity', enabled: false },
      { dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'celsius' },
    ];
    const v2Map = buildEffectiveSensorMap({
      userOverrides: sensorMap,
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
      stations: STATIONS,
      configMode: 'v2',
    });
    const { nextConfig } = composeV2ConfigSave(
      { apiKey: 'k', applicationKey: 'k' }, sensorMap, v2Map,
      detectConfigMode({} as never).mode,
    );
    // Markers deliberately LEFT IN PLACE — the v1.7.0-era scenario.
    expect(nextConfig.configVersion).toBe(2);

    const api = new MockAPI();
    const platform = new AmbientWeatherSensorsPlatform(
      new MockLogger() as never,
      { platform: 'AmbientWeatherSensors', ...nextConfig } as never,
      api as never,
    );
    const tempf = v2CachedAccessory({
      dataPoint: 'tempf', type: 'Temperature', displayName: 'Outdoor Temperature',
      kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature', battery: true,
      services: (a) => {
        const svc = a.addService(MockServices.TemperatureSensor);
        svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
        const batt = a.addService(MockServices.Battery);
        batt.addCharacteristic(MockCharacteristics.StatusLowBattery);
      },
    });
    platform.configureAccessory(tempf as never);
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify([{
      macAddress: MAC, info: { name: 'Home' },
      lastData: { tempf: 68, humidity: 40, battout: 1, barn_temp: 21 },
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

    // v1.7.0's didFinishLaunching called discoverDevices()
    // unconditionally — no guard, no mode detection. Direct call =
    // that era's semantics; do NOT route through HEAD's lifecycle.
    await platform.discoverDevices();

    expect(api.unregistered).not.toContain(tempf);
    expect(api.registered.some(a => (a.context.device as { uniqueId?: string }).uniqueId === `${MAC}-humidity`)).toBe(false);
    expect(api.registered.some(a => (a.context.device as { uniqueId?: string }).uniqueId === `${MAC}-barn_temp`)).toBe(false);
    vi.restoreAllMocks();
  });
});

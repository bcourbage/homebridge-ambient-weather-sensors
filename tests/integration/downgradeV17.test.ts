/**
 * Downgrade lifecycle fixture (finding 5 — reviewer requirement).
 *
 * Simulates the real downgrade sequence:
 *
 *   1. A v2 configuration is produced by the UI save flow
 *      (`composeV2ConfigSave`): `configVersion: 2` + `sensorMap` + the
 *      SYNCHRONIZED LEGACY MIRROR + `_legacyMirror` metadata.
 *   2. The accessory cache is v2-WRITTEN: contexts carry `kind`,
 *      `measurement`, and `structuralSignature` alongside the legacy
 *      `type` (P1-2's shape).
 *   3. The plugin is downgraded to v1.7 and boots against that config
 *      and cache. v1.7 has no configMode detection — it reads the
 *      legacy fields directly and runs its registration semantics.
 *
 * v1.7 semantics are exercised through HEAD's flag-OFF discoverDevices
 * path, which the Stage-4 work keeps byte-identical to the v1.7.0
 * registration pipeline (the full 1044-test v1 baseline pins it).
 *
 * The assertions the reviewer asked for:
 *   - ZERO unregister calls for every v1.7-representable known
 *     accessory (not merely recognizable `type` strings) — native AND
 *     extended, battery hosts included.
 *   - The custom accessory is the explicit downgrade-loss boundary:
 *     its cached accessory IS unregistered, and its dataPoint is never
 *     (mis)registered as a new wrong-wrapper accessory even though
 *     v1.7's broad matchers would otherwise catch it
 *     (`barn_temp`.includes('temp')).
 */

import { describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { buildEffectiveSensorMap } from '../../src/sensorMap/buildEffectiveMap';
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

describe('v1.7 downgrade fixture: v2 config + synchronized mirror + v2-written cache', () => {
  it('v1.7 registration semantics keep every representable accessory; custom is the loss boundary', async () => {
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
    const { nextConfig } = composeV2ConfigSave({ apiKey: 'k', applicationKey: 'k' }, sensorMap, v2Map);

    // ---- 2. The v2-written cache: native + extended + battery host.
    const api = new MockAPI();
    const log = new MockLogger();
    const platform = new AmbientWeatherSensorsPlatform(
      log as never,
      { platform: 'AmbientWeatherSensors', ...nextConfig } as never,
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

    // v1.7 has no configMode detection or v2 branch — its
    // didFinishLaunching calls discoverDevices() unconditionally.
    // HEAD's flag-off discoverDevices is that same pipeline.
    await platform.discoverDevices();

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
});

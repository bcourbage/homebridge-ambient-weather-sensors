/**
 * finding-#4 Stage 4, first commit — platform-boundary lifecycle tests.
 *
 * These drive the REAL `AmbientWeatherSensorsPlatform` with a mocked
 * Homebridge API through the flag-gated v2 reconciler
 * (`discoverDevicesV2`), exercising the whole boundary the earlier stages
 * only unit-tested in isolation: effective-map assembly → accessory
 * restore/register (v1.7 UUID reuse) → row-driven wrapper construction →
 * `(mac, dataPoint) → wrapper` routing → value + battery distribution for
 * BOTH the polling and realtime paths.
 *
 * The resolution table is still EMPTY, so custom dataPoints resolve
 * `no-wrapper` and never register — the reviewer's hard ordering gate
 * before the table is restored.
 */

import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockAPI,
  MockLogger,
  MockPlatformAccessory,
  MockServices,
  MockCharacteristics,
  mockUuidGenerate,
} from '../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';
const F_TO_C = (f: number) => (f - 32) * 5 / 9;

function makePlatform(config: Record<string, unknown>): {
  platform: AmbientWeatherSensorsPlatform; api: MockAPI; log: MockLogger;
} {
  const api = new MockAPI();
  const log = new MockLogger();
  const platform = new AmbientWeatherSensorsPlatform(
    log as never,
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', ...config } as never,
    api as never,
  );
  return { platform, api, log };
}

/**
 * Seed a cached accessory with the UUID the platform will regenerate
 * from `uniqueId` (NOT from displayName — that's what
 * `makeMockAccessory` keys on), so the restore branch reuses it.
 */
function cacheAccessory(
  platform: AmbientWeatherSensorsPlatform,
  uniqueId: string,
  type: string,
  displayName: string,
  setup?: (a: MockPlatformAccessory) => void,
): MockPlatformAccessory {
  const a = new MockPlatformAccessory(displayName, mockUuidGenerate(uniqueId));
  a.context.device = { uniqueId, type, displayName, value: 20 };
  setup?.(a);
  platform.configureAccessory(a as never);
  return a;
}

function mockFetch(payload: unknown): void {
  vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

/** Neuter the poll timer so it never fires a real fetch during a test. */
function stubTimer(): void {
  vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
}

/** Set the config mode the way didFinishLaunching would, then reconcile. */
async function reconcile(platform: AmbientWeatherSensorsPlatform, mode: 'legacy' | 'v2' = 'legacy'): Promise<void> {
  (platform as unknown as { configMode: string }).configMode = mode;
  await platform.discoverDevices();
}

function routing(platform: AmbientWeatherSensorsPlatform): Map<string, unknown> | undefined {
  return (platform as unknown as { v2Routing: Map<string, unknown> | undefined }).v2Routing;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discoverDevicesV2 — flag OFF stays on the v1.7 path', () => {
  it('does not build a v2 routing map, keeps the v1 wrappers map + shadow off', async () => {
    // No _sensorMapV2 → the v1.6.0 discoverDevices path runs unchanged.
    const { platform } = makePlatform({ temperatureSensors: true });
    cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();

    await reconcile(platform);

    // v2 machinery dormant; v1 wrappers map used.
    expect(routing(platform)).toBeUndefined();
    expect((platform as unknown as { shadow: unknown }).shadow).toBeUndefined();
    const wrappers = (platform as unknown as { wrappers: Map<string, unknown> }).wrappers;
    expect(wrappers.has(`${MAC}-tempf`)).toBe(true);

    // Value seeded through the v1 path.
    const svc = platform.accessories[0].getService(MockServices.TemperatureSensor as never) as unknown as {
      readCharacteristic(c: unknown): unknown;
    };
    expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(68), 4);

    // No persistence side effects on the flag-off path: the v2 stores
    // are never loaded, so the plugin-data dir is never created.
    const storageRoot = ((platform as unknown as { api: { user: { storagePath(): string } } })
      .api.user.storagePath());
    expect(existsSync(nodePath.join(storageRoot, 'plugin-data'))).toBe(false);
  });
});

describe('discoverDevicesV2 — flag ON lifecycle', () => {
  it('restores a cached row, registers a new row, and builds routing for known rows only', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true, humiditySensors: true });
    // tempf is cached (restore path); humidity is new (register path).
    const cachedTemp = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, humidity: 40, battout: 1 } }]);
    stubTimer();

    await reconcile(platform, 'legacy');

    // Routing built for the two known rows.
    const r = routing(platform)!;
    expect(r.size).toBe(2);
    expect(r.has(`${MAC}|tempf`)).toBe(true);
    expect(r.has(`${MAC}|humidity`)).toBe(true);

    // Cached tempf reused (updated, not deregistered, same object).
    expect(api.unregistered).toHaveLength(0);
    expect(api.updated).toContain(cachedTemp);
    // Humidity registered new, with a v1.7-compatible context.device so a
    // downgrade finds a recognisable cache (uniqueId, type, displayName,
    // value, batteryLow).
    const newHumidity = api.registered.find(a => a.context.device.uniqueId === `${MAC}-humidity`)!;
    expect(newHumidity).toBeDefined();
    const ctx = newHumidity.context.device as Record<string, unknown>;
    expect(ctx.type).toBe('Humidity');            // legacy determineSensorType string
    expect(ctx.displayName).toBe('Outdoor Humidity');
    expect(ctx.value).toBe(40);
    // humidity shares battout with tempf but is NOT canonical → no battery.
    expect(ctx.batteryLow).toBeUndefined();

    // AWN value routed through to the HAP characteristic (seed).
    const tempSvc = cachedTemp.getService(MockServices.TemperatureSensor)!;
    expect(tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(68), 4);
  });

  it('reuses the v1.7 cached UUID without deregistration or a UUID change', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    const uuidBefore = mockUuidGenerate(`${MAC}-tempf`);
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    expect(cached.UUID).toBe(uuidBefore);
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();

    await reconcile(platform, 'legacy');

    expect(api.unregistered).toHaveLength(0);
    // No brand-new accessory for tempf — the cached one was reused.
    expect(api.registered.some(a => a.context.device.uniqueId === `${MAC}-tempf`)).toBe(false);
    expect(cached.UUID).toBe(uuidBefore);
    expect(platform.accessories).toContain(cached);
  });

  it('polling and realtime each route a fresh AWN value through distributeViaRouting', async () => {
    const { platform } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();
    await reconcile(platform, 'legacy');
    const tempSvc = cached.getService(MockServices.TemperatureSensor)!;

    // --- Polling: fetch a NEW value and run one poll tick.
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 50 } }]);
    await (platform as unknown as { pollAndDistribute(): Promise<void> }).pollAndDistribute();
    expect(tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(50), 4);

    // --- Realtime: the source's onUpdates convergence point is distribute().
    (platform as unknown as { distribute(u: Array<{ uniqueId: string; value: number }>): void })
      .distribute([{ uniqueId: `${MAC}-tempf`, value: 32 }]);
    expect(tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(32), 4);
  });

  it('battery status flows (canonical owner) and extended wrappers get their initial seed', async () => {
    const { platform, api } = makePlatform({
      _sensorMapV2: true, temperatureSensors: true, extendedSensors: true, pressureSensors: true,
    });
    // tempf is canonical for battout → owns the Battery sub-service.
    const temp = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1, baromabsin: 29.92 } }]);
    stubTimer();
    await reconcile(platform, 'legacy');

    // Battery sub-service attached + seeded NORMAL (battout=1 → not low).
    const battSvc = temp.getService(MockServices.Battery)!;
    expect(battSvc).toBeDefined();
    expect(battSvc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(0);

    // Extended pressure wrapper got its post-construction initial seed
    // (its MotionSensor Value characteristic is non-empty). A newly
    // registered accessory lands in api.registered, not platform.accessories
    // (which Homebridge repopulates via configureAccessory on next boot).
    const pressAcc = api.registered.find(a => a.context.device.uniqueId === `${MAC}-baromabsin`)!;
    const motion = pressAcc.getService(MockServices.MotionSensor)!;
    const valueChar = [...(motion as unknown as { characteristics: Map<string, { displayName: string; value: unknown }> })
      .characteristics.values()].find(c => c.displayName === 'Value');
    expect(valueChar?.value).toContain('inHg');

    // A subsequent low reading flips StatusLowBattery via the battery bridge.
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 0 } }]);
    await (platform as unknown as { pollAndDistribute(): Promise<void> }).pollAndDistribute();
    expect(battSvc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(1);
  });

  it('stationFilter drops non-matching stations and post-filter naming is bare (v1 parity)', async () => {
    // Regression for the adversarial-review finding: the v2 reconciler
    // must apply stationFilter BEFORE building the inventory, and
    // isMultiStation must be recomputed post-filter (one station left →
    // bare tile names), exactly as parseDevices does.
    const { platform, api } = makePlatform({
      _sensorMapV2: true, temperatureSensors: true, stationFilter: ['Cabin'],
    });
    mockFetch([
      { macAddress: '11:11:11:11:11:11', info: { name: 'Main House' }, lastData: { tempf: 70 } },
      { macAddress: '22:22:22:22:22:22', info: { name: 'Cabin' }, lastData: { tempf: 65 } },
    ]);
    stubTimer();
    await reconcile(platform, 'legacy');

    const r = routing(platform)!;
    expect(r.has('22:22:22:22:22:22|tempf')).toBe(true);
    expect(r.has('11:11:11:11:11:11|tempf')).toBe(false);
    // Only the matching station's accessory registered, with a BARE name
    // (post-filter single station → no station prefix).
    expect(api.registered).toHaveLength(1);
    expect(api.registered[0].context.device.uniqueId).toBe('22:22:22:22:22:22-tempf');
    expect(api.registered[0].context.device.displayName).toBe('Outdoor Temperature');
  });

  it('pressure naming pins display name, AccessoryInformation Name/Model, and MotionSensor Name/ConfiguredName', async () => {
    const { platform } = makePlatform({ _sensorMapV2: true, extendedSensors: true, pressureSensors: true });
    // Cache baromabsin so the restore branch sets AccessoryInformation.Name.
    const press = cacheAccessory(platform, `${MAC}-baromabsin`, 'PressureAbsolute', 'Pressure Station');
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { baromabsin: 29.92 } }]);
    stubTimer();
    await reconcile(platform, 'legacy');

    // 1. Platform-owned display name (sanitized: parens stripped by hapClean).
    expect(press.context.device.displayName).toBe('Pressure Station');
    expect(press.displayName).toBe('Pressure Station');

    // 2. AccessoryInformation.Name (set by the restore branch to the display name).
    const info = press.getService(MockServices.AccessoryInformation)!;
    expect(info.getCharacteristic(MockCharacteristics.Name).value).toBe('Pressure Station');

    // 3. AccessoryInformation.Model — the extended-service label, parens PRESERVED.
    expect(info.getCharacteristic(MockCharacteristics.Model).value).toBe('Pressure (Station)');

    // 4. MotionSensor Name + ConfiguredName — composeStaticName sanitizes the label.
    const motion = press.getService(MockServices.MotionSensor)!;
    expect(motion.getCharacteristic(MockCharacteristics.Name).value).toBe('Pressure Station');
    expect(motion.getCharacteristic(MockCharacteristics.ConfiguredName).value).toBe('Pressure Station');
  });
});

describe('discoverDevicesV2 — malformed AWN responses (failed snapshot, not empty inventory)', () => {
  function malformedCases(): Array<{ label: string; payload: unknown }> {
    return [
      { label: 'wholly malformed: [{}]', payload: [{}] },
      { label: 'partially malformed: [valid, {}]', payload: [
        { macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } },
        {},
      ] },
      { label: 'station without macAddress', payload: [{ info: { name: 'Home' }, lastData: { tempf: 68 } }] },
      { label: 'station without lastData', payload: [{ macAddress: MAC, info: { name: 'Home' } }] },
      { label: 'non-array body', payload: { error: 'maintenance' } },
    ];
  }

  it('fetchRawStations returns undefined for every malformed shape (empty array stays valid)', async () => {
    const { platform } = makePlatform({ _sensorMapV2: true });
    const fetchRaw = (platform as unknown as { fetchRawStations(): Promise<unknown> });
    for (const { label, payload } of malformedCases()) {
      mockFetch(payload);
      expect(await fetchRaw.fetchRawStations(), label).toBeUndefined();
      vi.restoreAllMocks();
    }
    // Contrast: [] is an authoritative empty inventory (AWN healthy, no
    // devices) — same as v1.7.
    mockFetch([]);
    expect(await fetchRaw.fetchRawStations()).toEqual([]);
  });

  it('a transient malformed snapshot never unregisters the cache; the retry reconciles normally', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });

    // First fetch: AWN incident shape [{}] — v1.7 threw and retried;
    // v2 must also fail the snapshot. Second fetch: healthy payload.
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      const body = call === 1 ? [{}] : [{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // Collapse the 60s retry backoff.
    vi.spyOn(platform as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue(undefined);
    stubTimer();

    await reconcile(platform, 'legacy');

    // The malformed tick performed ZERO reconciliation...
    expect(api.unregistered).toHaveLength(0);
    // ...and the retry restored the cached accessory normally.
    expect(platform.accessories).toContain(cached);
    expect(routing(platform)!.has(`${MAC}|tempf`)).toBe(true);
  });

  it('a malformed poll-tick payload is dropped without touching wrappers', async () => {
    const { platform } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();
    await reconcile(platform, 'legacy');
    const tempSvc = cached.getService(MockServices.TemperatureSensor)!;
    const before = tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature);

    mockFetch([{}]);
    await (platform as unknown as { pollAndDistribute(): Promise<void> }).pollAndDistribute();
    // Value untouched by the malformed tick.
    expect(tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBe(before);
  });
});

describe('discoverDevicesV2 — safe mode and custom rows', () => {
  it('safe mode (flag on) performs no register/unregister/update and keeps cached-wrapper bindings', () => {
    const { platform, api } = makePlatform({
      _sensorMapV2: true, configVersion: 999, temperatureSensors: true,
    });
    cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Cached', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    stubTimer();

    // didFinishLaunching detects safe mode BEFORE any v2 reconcile or
    // persistence read — safeModeStart runs the reduced pipeline instead.
    api.emit('didFinishLaunching');

    expect(api.registered).toHaveLength(0);
    expect(api.unregistered).toHaveLength(0);
    expect(api.updated).toHaveLength(0);
    expect(routing(platform)).toBeUndefined();
    // Reduced pipeline still bound the cached native accessory.
    const bindings = (platform as unknown as { safeModeBindings: Map<string, unknown> }).safeModeBindings;
    expect(bindings.has(`${MAC}-tempf`)).toBe(true);
    // No persistence side effects: the plugin-data dir was never created
    // (safe mode is gated BEFORE any read that could quarantine or write).
    const storageRoot = (api as unknown as { user: { storagePath(): string } }).user.storagePath();
    expect(existsSync(nodePath.join(storageRoot, 'plugin-data', 'ambient-weather'))).toBe(false);
  });

  it('a custom dataPoint produces no-wrapper and never registers while the table is empty', async () => {
    const { platform, api, log } = makePlatform({
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'my_barn', kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit' }],
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { my_barn: 50 } }]);
    stubTimer();

    await reconcile(platform, 'v2');

    // No accessory registered for the custom dataPoint.
    expect(api.registered.some(a => a.context.device.uniqueId === `${MAC}-my_barn`)).toBe(false);
    // Routing has no entry for it.
    expect(routing(platform)!.has(`${MAC}|my_barn`)).toBe(false);
    // The rejection is surfaced.
    expect(log.find('info', 'no-wrapper').length).toBeGreaterThan(0);
  });
});

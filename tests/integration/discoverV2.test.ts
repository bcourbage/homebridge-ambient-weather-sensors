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

import { existsSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Realistic v1.7 cache shape for a canonical temperature accessory:
 * TemperatureSensor + Battery sub-service (canonical rows host the
 * battery, and v1.7 attached it whenever AWN reported battout — the
 * overwhelmingly common case). The v2 row model treats battery
 * ownership as a map property (`battery:1` in the signature), so a
 * canonical cache WITHOUT the Battery service is a structural mismatch
 * by design — see the P1-2 suite.
 */
function tempWithBattery(a: MockPlatformAccessory): void {
  const svc = a.addService(MockServices.TemperatureSensor);
  svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
  const batt = a.addService(MockServices.Battery);
  batt.addCharacteristic(MockCharacteristics.StatusLowBattery);
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
    cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
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
    const cachedTemp = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
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
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
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
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
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
    const temp = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
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

  it('a known-row rename override drives the platform display name and HAP Name (P1-1)', async () => {
    const { platform } = makePlatform({
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'tempf', name: 'Patio' }],
    });
    // Cached under the old default name — the rename must flow through
    // the restore branch (displayName + AccessoryInformation.Name).
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();

    await reconcile(platform, 'v2');

    expect(cached.displayName).toBe('Patio');
    expect(cached.context.device.displayName).toBe('Patio');
    const info = cached.getService(MockServices.AccessoryInformation)!;
    expect(info.getCharacteristic(MockCharacteristics.Name).value).toBe('Patio');
    // UUID untouched by the rename — identity is uniqueId, not the name.
    expect(cached.UUID).toBe(mockUuidGenerate(`${MAC}-tempf`));
  });

  it('multi-station rename composes station prefix + row name (P1-1)', async () => {
    const { platform, api } = makePlatform({
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'tempf', name: 'Patio' }],
    });
    mockFetch([
      { macAddress: '11:11:11:11:11:11', info: { name: 'Main House' }, lastData: { tempf: 70 } },
      { macAddress: '22:22:22:22:22:22', info: { name: 'Cabin' }, lastData: { tempf: 65 } },
    ]);
    stubTimer();
    await reconcile(platform, 'v2');

    const names = api.registered.map(a => a.context.device.displayName).sort();
    expect(names).toEqual(['Cabin Patio', 'Main House Patio']);
  });

  it('a 100-char rename respects the 64-char limit at EVERY HAP sink (R4-2)', async () => {
    const longName = 'L'.repeat(100);
    const { platform, api } = makePlatform({
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'baromabsin', name: longName }],
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { baromabsin: 29.92 } }]);
    stubTimer();
    await reconcile(platform, 'v2');

    const acc = api.registered.find(a => a.context.device.uniqueId === `${MAC}-baromabsin`)!;
    // Accessory displayName (platform sink).
    expect((acc.context.device.displayName as string).length).toBeLessThanOrEqual(64);
    // AccessoryInformation.Model (raw label, truncate-only).
    const info = acc.getService(MockServices.AccessoryInformation)!;
    expect(String(info.getCharacteristic(MockCharacteristics.Model).value).length).toBe(64);
    // MotionSensor Name + ConfiguredName (composeStaticName sink).
    const motion = acc.getService(MockServices.MotionSensor)!;
    expect(String(motion.getCharacteristic(MockCharacteristics.Name).value).length).toBeLessThanOrEqual(64);
    expect(String(motion.getCharacteristic(MockCharacteristics.ConfiguredName).value).length).toBeLessThanOrEqual(64);
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

describe('discoverDevicesV2 — discovery tracker ownership (review P1-4)', () => {
  function storageDir(api: MockAPI): string {
    return (api as unknown as { user: { storagePath(): string } }).user.storagePath();
  }
  function discoveryPath(api: MockAPI): string {
    return nodePath.join(storageDir(api), 'plugin-data', 'ambient-weather', 'discovery.json');
  }

  it('discovery writes discovery.json with post-filter observations (incl. batt* + unknown fields)', async () => {
    const { platform, api } = makePlatform({
      _sensorMapV2: true, temperatureSensors: true, stationFilter: ['Home'],
    });
    mockFetch([
      { macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1, weird_new_field: 3 } },
      { macAddress: '99:99:99:99:99:99', info: { name: 'Neighbor' }, lastData: { tempf: 50 } },
    ]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      // The discovery-time flush is fire-and-forget; drain it so the
      // on-disk assertion is deterministic.
      await (platform as unknown as { v2Tracker: { flush(force: boolean): Promise<void> } }).v2Tracker.flush(true);
      expect(existsSync(discoveryPath(api))).toBe(true);
      const store = JSON.parse(readFileSync(discoveryPath(api), 'utf8')) as {
        entries: Array<{ stationMac: string; dataPoint: string }>;
      };
      const pairs = new Set(store.entries.map(e => `${e.stationMac}|${e.dataPoint}`));
      // Every raw field of the MATCHING station is observed — including
      // battery fields and fields the map doesn't know.
      expect(pairs.has(`${MAC}|tempf`)).toBe(true);
      expect(pairs.has(`${MAC}|battout`)).toBe(true);
      expect(pairs.has(`${MAC}|weird_new_field`)).toBe(true);
      // The filtered-out station is NOT recorded.
      expect([...pairs].some(p => p.startsWith('99:99:99:99:99:99'))).toBe(false);
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
  });

  it('a poll tick flushes a newly-appearing field to disk IMMEDIATELY (structural, unthrottled)', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      // Poll tick reports a field the discovery store has never seen —
      // ALONGSIDE the existing field, the exact mix that used to trip
      // the lastSeen throttle and defer the structural write (R3-7).
      mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, brand_new: 1 } }]);
      await (platform as unknown as { pollAndDistribute(): Promise<void> }).pollAndDistribute();

      // In-memory registry has it immediately.
      const tracker = (platform as unknown as { v2Tracker: { snapshot(): { entries: Array<{ dataPoint: string }> } } }).v2Tracker;
      expect(tracker.snapshot().entries.some(e => e.dataPoint === 'brand_new')).toBe(true);

      // ON DISK before any shutdown: a crash after this tick must not
      // lose the discovery. (The platform's flush is fire-and-forget,
      // so poll for the write completing — the point is that it happens
      // NOW, not at shutdown or after the 15-minute throttle.)
      await vi.waitFor(() => {
        const store = JSON.parse(readFileSync(discoveryPath(api), 'utf8')) as {
          entries: Array<{ dataPoint: string }>;
        };
        expect(store.entries.some(e => e.dataPoint === 'brand_new')).toBe(true);
      }, { timeout: 3000, interval: 25 });

      // Shutdown force-flush still runs cleanly afterwards.
      api.emit('shutdown');
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
  });

  it('flag-off and safe mode never create the tracker', async () => {
    // Flag off: v1 path.
    const off = makePlatform({ temperatureSensors: true });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68 } }]);
    stubTimer();
    await reconcile(off.platform, 'legacy');
    expect((off.platform as unknown as { v2Tracker: unknown }).v2Tracker).toBeUndefined();
    vi.restoreAllMocks();

    // Safe mode with flag on: didFinishLaunching gates before persistence.
    const safe = makePlatform({ _sensorMapV2: true, configVersion: 999 });
    stubTimer();
    safe.api.emit('didFinishLaunching');
    expect((safe.platform as unknown as { v2Tracker: unknown }).v2Tracker).toBeUndefined();
    expect(existsSync(nodePath.join(storageDir(safe.api), 'plugin-data'))).toBe(false);
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
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);

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
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
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

describe('discoverDevicesV2 — bootstrap + structural-signature reconciliation (review P1-2)', () => {
  function storageDir(api: MockAPI): string {
    return (api as unknown as { user: { storagePath(): string } }).user.storagePath();
  }

  it('batteryField:null is a structural change: re-register + notice, never an in-place graph mutation', async () => {
    const { platform, api } = makePlatform({
      _sensorMapV2: true,
      configVersion: 2,
      sensorMap: [{ dataPoint: 'tempf', batteryField: null }],
    });
    // v1.7-written cache: tempf WITH a Battery sub-service (no stored
    // signature — the derived path must detect battery:1 vs battery:0).
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
      const batt = a.addService(MockServices.Battery);
      batt.addCharacteristic(MockCharacteristics.StatusLowBattery);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'v2');

      // Old accessory re-registered: unregister + fresh registration.
      expect(api.unregistered).toContain(cached);
      const fresh = api.registered.find(a => a.context.device.uniqueId === `${MAC}-tempf`)!;
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(cached);
      // The fresh accessory has NO Battery sub-service and carries the
      // new signature + row identity fields alongside the legacy type.
      expect(fresh.getService(MockServices.Battery)).toBeUndefined();
      const ctx = fresh.context.device as Record<string, unknown>;
      expect(ctx.type).toBe('Temperature');
      expect(ctx.kind).toBe('temperature');
      expect(ctx.measurement).toBe('temperature');
      expect(String(ctx.structuralSignature)).toContain('battery:0');

      // Structural-change notice persisted.
      const noticesFile = nodePath.join(storageDir(api), 'plugin-data', 'ambient-weather', 'notices.json');
      const store = JSON.parse(readFileSync(noticesFile, 'utf8')) as {
        notices: Array<{ dataPoint: string; oldSignature?: string; newSignature: string }>;
      };
      const notice = store.notices.find(n => n.dataPoint === 'tempf')!;
      expect(notice).toBeDefined();
      expect(notice.oldSignature).toContain('battery:1');
      expect(notice.newSignature).toContain('battery:0');
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
  });

  it('a matching cached graph restores in place and adopts the row identity fields', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    // v1.7 cache: canonical tempf WITH battery — matches the default
    // row's battery:1 signature, so no re-registration.
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
      const batt = a.addService(MockServices.Battery);
      batt.addCharacteristic(MockCharacteristics.StatusLowBattery);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      expect(api.unregistered).toHaveLength(0);
      expect(api.updated).toContain(cached);
      const ctx = cached.context.device as Record<string, unknown>;
      expect(ctx.kind).toBe('temperature');
      expect(ctx.measurement).toBe('temperature');
      expect(String(ctx.structuralSignature)).toContain('battery:1');
      // Battery sub-service intact.
      expect(cached.getService(MockServices.Battery)).toBeDefined();
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
  });

  it('legacy normalization (R3-4): a signature-less cache missing only the telemetry-conditioned Battery adopts in place', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    // v1.7 cache whose discovery tick happened to omit battout: NO
    // Battery sub-service, NO stored signature. The user changed
    // nothing — this must NOT be a destructive re-registration.
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', (a) => {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      // Adopted in place: zero unregisters, same accessory object.
      expect(api.unregistered).toHaveLength(0);
      expect(api.updated).toContain(cached);
      expect(platform.accessories).toContain(cached);
      // The row-driven wrapper attached the Battery sub-service in
      // place (what v1.7 itself did on the next battery-reporting tick).
      expect(cached.getService(MockServices.Battery)).toBeDefined();
      // Context adopted the row's battery:1 signature.
      expect(String((cached.context.device as Record<string, unknown>).structuralSignature)).toContain('battery:1');
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
  });

  it('a v2-written cache with a stale STORED signature also re-registers', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
    // Simulate a v2-written cache whose stored signature predates a
    // structural change (battery:0 stored; the default row owns battery:1).
    (cached.context.device as Record<string, unknown>).structuralSignature =
      'temperature|measurement:temperature|battery:0|wrapper:temperature:v1';
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');
      expect(api.unregistered).toContain(cached);
      const fresh = api.registered.find(a => a.context.device.uniqueId === `${MAC}-tempf`)!;
      expect(String((fresh.context.device as Record<string, unknown>).structuralSignature)).toContain('battery:1');
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
  });

  it('preserve-cached: an uninferable cached accessory is NEVER unregistered; inferable orphans still are', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    // Uninferable: unknown type, dataPoint outside the default map.
    const mystery = cacheAccessory(platform, `${MAC}-mystery_dp`, 'MysteryFutureType', 'Mystery');
    // Inferable orphan: a Humidity accessory whose category is off.
    const humidity = cacheAccessory(platform, `${MAC}-humidity`, 'Humidity', 'Outdoor Humidity', (a) => {
      const svc = a.addService(MockServices.HumiditySensor);
      svc.addCharacteristic(MockCharacteristics.CurrentRelativeHumidity);
    });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, humidity: 40 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      // The uninferable cache is preserved in HomeKit...
      expect(api.unregistered).not.toContain(mystery);
      expect(platform.accessories).toContain(mystery);
      // ...while the inferable disabled-category orphan is removed,
      // exactly as v1.7 would.
      expect(api.unregistered).toContain(humidity);
    } finally {
      rmSync(storageDir(api), { recursive: true, force: true });
    }
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

  it('a wrapper-constructor failure drops ONLY that new accessory from registration (finding 8)', async () => {
    const { platform, api, log } = makePlatform({
      _sensorMapV2: true, temperatureSensors: true, humiditySensors: true,
    });
    // Poison the humidity factory so its constructor throws; tempf's
    // stays healthy. Both rows are NEW (no cache).
    const { FACTORIES } = await import('../../src/sensorMap/wrapperFactories');
    const original = FACTORIES.humidity;
    (FACTORIES as Record<string, unknown>).humidity = () => {
      throw new Error('boom: constructor failure under test');
    };
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, humidity: 40, battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      // The healthy row registered; the failed row did NOT - no
      // incomplete-graph accessory reaches HAP.
      expect(api.registered.some(a => a.context.device.uniqueId === `${MAC}-tempf`)).toBe(true);
      expect(api.registered.some(a => a.context.device.uniqueId === `${MAC}-humidity`)).toBe(false);
      // Routing has only the healthy row; both failures were surfaced.
      expect(routing(platform)!.has(`${MAC}|tempf`)).toBe(true);
      expect(routing(platform)!.has(`${MAC}|humidity`)).toBe(false);
      expect(log.find('error', 'failed to instantiate wrapper').length).toBeGreaterThan(0);
      expect(log.find('warn', 'Not registering new accessory').length).toBeGreaterThan(0);
    } finally {
      (FACTORIES as Record<string, unknown>).humidity = original;
      rmSync((api as unknown as { user: { storagePath(): string } }).user.storagePath(), { recursive: true, force: true });
    }
  });

  it('an uncoercible reading preserves the cached value instead of fabricating 0 (finding 7)', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
    // Cached last-known reading: 20°F.
    (cached.context.device as Record<string, unknown>).value = 20;
    // AWN reports garbage for tempf this tick (plus a healthy battery).
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 'garbage', battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      // Context keeps the cached numeric value - never a fabricated 0.
      expect((cached.context.device as Record<string, unknown>).value).toBe(20);
      // The wrapper was seeded with the preserved 20°F (-6.67°C), not 0°F.
      const svc = cached.getService(MockServices.TemperatureSensor)!;
      expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo((20 - 32) * 5 / 9, 3);
    } finally {
      rmSync((api as unknown as { user: { storagePath(): string } }).user.storagePath(), { recursive: true, force: true });
    }
  });

  it('an uncoercible reading with NO cache leaves the value unset - no seed at all (finding 7)', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, temperatureSensors: true });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 'garbage' } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');

      const fresh = api.registered.find(a => a.context.device.uniqueId === `${MAC}-tempf`)!;
      expect(fresh).toBeDefined();
      expect((fresh.context.device as Record<string, unknown>).value).toBeUndefined();
      // CurrentTemperature was never seeded (mock default = null).
      const svc = fresh.getService(MockServices.TemperatureSensor)!;
      expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature) ?? null).toBeNull();
    } finally {
      rmSync((api as unknown as { user: { storagePath(): string } }).user.storagePath(), { recursive: true, force: true });
    }
  });

  it('timestamp rows keep the v1.7 invalid-lastRain behavior: unparseable string seeds 0 (finding 7)', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, extendedSensors: true, rainSensors: true });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { lastRain: 'not-a-date' } }]);
    stubTimer();
    try {
      await reconcile(platform, 'legacy');
      const lr = api.registered.find(a => a.context.device.uniqueId === `${MAC}-lastRain`)!;
      expect(lr).toBeDefined();
      expect((lr.context.device as Record<string, unknown>).value).toBe(0);
    } finally {
      rmSync((api as unknown as { user: { storagePath(): string } }).user.storagePath(), { recursive: true, force: true });
    }
  });

  it('a malformed (non-array) sensorMap freezes: no reconciliation, cache preserved (finding 6)', async () => {
    for (const bad of ['oops', { dataPoint: 'tempf' }, 42, null]) {
      const { platform, api, log } = makePlatform({
        _sensorMapV2: true, configVersion: 2, sensorMap: bad,
      });
      const cached = cacheAccessory(platform, `${MAC}-tempf`, 'Temperature', 'Outdoor Temperature', tempWithBattery);
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
        throw new Error('no network under the freeze');
      });
      stubTimer();

      await reconcile(platform, 'v2');

      // Cache-preserving hard stop: zero HAP calls, zero fetches, no
      // routing, no persist dir - and the full default exposure was
      // NOT registered off the config error.
      expect(api.registered, String(bad)).toHaveLength(0);
      expect(api.unregistered, String(bad)).toHaveLength(0);
      expect(api.updated, String(bad)).toHaveLength(0);
      expect(fetchSpy, String(bad)).not.toHaveBeenCalled();
      expect(routing(platform), String(bad)).toBeUndefined();
      expect(platform.accessories).toContain(cached);
      expect(log.find('error', 'not an array').length, String(bad)).toBeGreaterThan(0);
      const storageRoot = (api as unknown as { user: { storagePath(): string } }).user.storagePath();
      expect(existsSync(nodePath.join(storageRoot, 'plugin-data'))).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it('an ABSENT sensorMap in v2 mode still reconciles the default exposure (finding 6 contrast)', async () => {
    const { platform, api } = makePlatform({ _sensorMapV2: true, configVersion: 2 });
    mockFetch([{ macAddress: MAC, info: { name: 'Home' }, lastData: { tempf: 68, battout: 1 } }]);
    stubTimer();
    try {
      await reconcile(platform, 'v2');
      expect(routing(platform)!.has(`${MAC}|tempf`)).toBe(true);
      expect(api.registered.some(a => a.context.device.uniqueId === `${MAC}-tempf`)).toBe(true);
    } finally {
      const storageRoot = (api as unknown as { user: { storagePath(): string } }).user.storagePath();
      rmSync(storageRoot, { recursive: true, force: true });
    }
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

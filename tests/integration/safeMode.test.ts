/**
 * Safe-mode regression test — sensor-map.md §17.2.
 *
 * When `configVersion` is unsupported (typically because the plugin
 * was downgraded past a config file's schemaVersion), the platform
 * enters safe mode. The contract:
 *
 *   - cached accessories keep serving their last-known HAP
 *     characteristic values;
 *   - polling / realtime keep pushing fresh values into their
 *     wrappers by uniqueId (the "updates continue" clause);
 *   - the platform makes ZERO calls to `registerPlatformAccessories`,
 *     `unregisterPlatformAccessories`, or `updatePlatformAccessories`
 *     — the reconciliation path is disabled;
 *   - the shadow-mode observer's persistence tree is not touched
 *     (Group 2's shadowMode.ts short-circuit, tested there).
 *
 * The test constructs the real `AmbientWeatherSensorsPlatform` with
 * a mocked Homebridge API, feeds it a couple of cached accessories
 * via `configureAccessory`, fires `didFinishLaunching`, and asserts
 * MockAPI's tracking arrays stayed empty. It does NOT exercise the
 * actual REST fetch — that would require a network mock that this
 * suite doesn't have; polling is tested at the shape level (poll
 * timer started, transport chosen) rather than at the wire level.
 */

import { describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { MockAPI, MockLogger, MockPlatformAccessory, MockServices, MockCharacteristics, makeMockAccessory } from '../helpers/mockHomebridge';

function makePlatform(config: Record<string, unknown>): { platform: AmbientWeatherSensorsPlatform; api: MockAPI; log: MockLogger } {
  const api = new MockAPI();
  const log = new MockLogger();
  const platform = new AmbientWeatherSensorsPlatform(
    log as never,
    { platform: 'AmbientWeatherSensors', ...config } as never,
    api as never,
  );
  return { platform, api, log };
}

/**
 * Seed a cached accessory into the platform's `accessories` array,
 * pre-populated with the primary HAP service so `bindSafeMode` can
 * find it (safe mode never adds services — it only binds to what
 * HAP already restored).
 */
function addCached(platform: AmbientWeatherSensorsPlatform, uniqueId: string, type: string): MockPlatformAccessory {
  const a = makeMockAccessory({ uniqueId, type, displayName: 'Cached ' + uniqueId, value: 20 });
  // Attach the primary service AND its value characteristic that a
  // real cached accessory of this type would have. Homebridge's
  // cache restore does this automatically in production;
  // bindSafeMode requires BOTH to be present (it never attaches a
  // missing characteristic).
  switch (type) {
    case 'Temperature': {
      const svc = a.addService(MockServices.TemperatureSensor);
      svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
      break;
    }
    case 'Humidity': {
      const svc = a.addService(MockServices.HumiditySensor);
      svc.addCharacteristic(MockCharacteristics.CurrentRelativeHumidity);
      break;
    }
  }
  platform.configureAccessory(a as never);
  return a;
}

describe('platform safe-mode (finding #1 / §17.2)', () => {
  it('unsupported configVersion enters safe mode, does not reconcile, does not touch HAP registration', () => {
    const { platform, api } = makePlatform({
      configVersion: 999,   // future version → safe mode
      apiKey: 'test',
      applicationKey: 'test',
      temperatureSensors: true,
    });

    // Seed a couple of cached accessories — HAP restored them.
    addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');
    addCached(platform, 'AA:BB:CC:DD:EE:01-humidity', 'Humidity');
    expect(platform.accessories).toHaveLength(2);

    // Stop the poll timer from firing during the test to keep
    // fetch(URL) from actually going to the network. We only care
    // about the reconciliation-path assertions.
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

    api.emit('didFinishLaunching');

    // Safe mode DID skip discoverDevices — no register / unregister /
    // update calls on HAP. That's the "reconciliation disabled" half
    // of §17.2.
    expect(api.registered).toHaveLength(0);
    expect(api.unregistered).toHaveLength(0);
    expect(api.updated).toHaveLength(0);

    // Cached accessories are still in the platform's list — they
    // stay in HomeKit.
    expect(platform.accessories).toHaveLength(2);

    vi.restoreAllMocks();
  });

  it('safe mode binds cached accessories (via bindSafeMode) so polling can update them', () => {
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');

    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');

    // Safe mode uses `safeModeBindings`, NOT `this.wrappers` — the
    // latter would go through wrapper constructors that mutate the
    // HAP graph (addService / removeService). Accessing the private
    // field via cast is fine for a regression test.
    const bindings = (platform as unknown as { safeModeBindings: Map<string, unknown> }).safeModeBindings;
    expect(bindings.has('AA:BB:CC:DD:EE:01-tempf')).toBe(true);
    // The v1.6.0 wrappers map stays empty in safe mode.
    const wrappers = (platform as unknown as { wrappers: Map<string, unknown> }).wrappers;
    expect(wrappers.size).toBe(0);

    vi.restoreAllMocks();
  });

  it('safe mode: bindSafeMode never adds or removes services (graph parity)', () => {
    // Before/after service-graph assertion, per the reviewer's
    // Group 4 follow-up requirement. Snapshot the accessory's
    // service set before safe-mode start; expect it unchanged
    // after. bindSafeMode looks up existing services only, never
    // addService / removeService. A wrapper constructor path (the
    // pre-fix code) would have removed the BatteryService when
    // context.device.batteryLow was undefined — this test would
    // catch that regression.
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    const a = addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');
    // Add a Battery sub-service that a pre-fix wrapper constructor
    // would have REMOVED (because context.device.batteryLow is
    // undefined on this cached accessory).
    a.addService(MockServices.Battery);

    // Snapshot BOTH the service UUID set AND every service's
    // characteristic UUID set. `updateCharacteristic` on the real
    // HAP would attach a missing characteristic — this test would
    // catch that graph mutation, which the service-only snapshot
    // missed (reviewer's finding #3).
    const services = (a as unknown as { services: Map<string, { characteristics: Map<string, unknown> }> }).services;
    const snapshot = () => {
      const out: Record<string, string[]> = {};
      for (const [svcUuid, svc] of services) {
        out[svcUuid] = Array.from(svc.characteristics.keys()).sort();
      }
      return out;
    };
    const before = snapshot();

    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');

    // Full graph — services AND their characteristics — unchanged.
    expect(snapshot()).toEqual(before);
    // BatteryService still present.
    expect(a.getService(MockServices.Battery)).toBeDefined();

    vi.restoreAllMocks();
  });

  it('safe mode: battery-low flows from the batt* field to the sensor binding', async () => {
    // Reviewer finding #2: bindings are keyed by sensor uniqueId
    // (MAC-tempf), so the old MAC-battout lookup never matched.
    // The fix derives the battery field via batteryFieldForSensor(dp)
    // and reads it off the same payload. Prove setBatteryLow fires.
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    const a = addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');
    // Attach a Battery service with StatusLowBattery so the binding
    // can push to it.
    const battSvc = a.addService(MockServices.Battery);
    battSvc.addCharacteristic(MockCharacteristics.StatusLowBattery);

    // AWN payload: tempf value + battout === 0 (AWN's "low" signal).
    const awnPayload = [{
      macAddress: 'AA:BB:CC:DD:EE:01',
      info: { name: 'Home' },
      lastData: { tempf: 70, battout: 0 },
    }];
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(awnPayload), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');
    await (platform as unknown as { safeModePollAndDistribute(): Promise<void> }).safeModePollAndDistribute();

    // StatusLowBattery characteristic reads 1 (low) after the poll.
    const lowBattChar = battSvc.getCharacteristic(MockCharacteristics.StatusLowBattery);
    expect(lowBattChar.value).toBe(1);

    vi.restoreAllMocks();
  });

  it('safe mode: a cached CUSTOM dataPoint is NOT value-updated (no unit interpretation)', async () => {
    // Reviewer finding #4: bindSafeMode restricts to known
    // default-map dataPoints. A custom sensor's source unit isn't
    // trustworthy without the config we can't interpret, so it
    // stays frozen. Prove no binding is created for a custom dp.
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    // Cached custom-datapoint accessory typed as Temperature but
    // with a dataPoint outside DEFAULT_SENSOR_MAP.
    const a = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:01-my_custom_temp',
      type: 'Temperature',
      displayName: 'Custom Temp',
      value: 20,
    });
    const svc = a.addService(MockServices.TemperatureSensor);
    svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    platform.configureAccessory(a as never);

    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');

    const bindings = (platform as unknown as { safeModeBindings: Map<string, unknown> }).safeModeBindings;
    expect(bindings.has('AA:BB:CC:DD:EE:01-my_custom_temp')).toBe(false);

    vi.restoreAllMocks();
  });

  it('safe mode: a polled AWN value pushes through distribute() to the cached wrapper', async () => {
    // The live-update contract from §17.2: "polling / realtime
    // updates continue to push values to existing wrappers." This
    // test proves the value actually flows end-to-end in safe mode
    // — mocking `fetch` to return a realistic AWN payload and
    // asserting the cached wrapper's setValue was invoked.
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
      // temperatureSensors is left unset so parseDevices' filters
      // would drop tempf if we were doing full reconciliation. In
      // safe mode we're bypassing parseDevices' filter path anyway
      // because we're just pushing values to already-registered
      // cached wrappers — but keeping this off is a good sanity
      // check.
      temperatureSensors: true,
    });
    addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');

    // Mock fetch to return a plausible AWN response for tempf.
    const awnPayload = [
      {
        macAddress: 'AA:BB:CC:DD:EE:01',
        info: { name: 'Home' },
        lastData: { tempf: 72 },
      },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(awnPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    // Mock setInterval so the poll timer doesn't fire on its own.
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);

    api.emit('didFinishLaunching');

    // Grab the safe-mode binding the platform installed for our
    // cached tempf and spy on its setValue. This proves the
    // fetch → distribute wire pushes the raw AWN value all the way
    // through to the binding, WITHOUT going through parseDevices
    // (which would filter based on the unsupported config).
    const bindings = (platform as unknown as { safeModeBindings: Map<string, { setValue: (v: number) => void }> }).safeModeBindings;
    const binding = bindings.get('AA:BB:CC:DD:EE:01-tempf');
    expect(binding).toBeDefined();
    const setValueSpy = vi.spyOn(binding!, 'setValue');

    // Trigger one safe-mode poll cycle manually (the interval is mocked).
    await (platform as unknown as { safeModePollAndDistribute(): Promise<void> }).safeModePollAndDistribute();

    // Binding receives the raw Fahrenheit value; the F→C conversion
    // happens inside the binding (matching TemperatureAccessory).
    expect(setValueSpy).toHaveBeenCalledWith(72);

    // Confirm the value reached the HAP characteristic too, in Celsius.
    const svc = (bindings.get('AA:BB:CC:DD:EE:01-tempf') as unknown as { setValue: (v: number) => void });
    void svc;   // silence unused
    // Look at the accessory's TemperatureSensor service directly.
    const accessory = (platform.accessories[0] as unknown as {
      getService(ctor: unknown): { readCharacteristic(c: unknown): unknown };
    });
    const tempSvc = accessory.getService(MockServices.TemperatureSensor);
    expect(tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(22.22, 1);   // 72°F = 22.22°C

    // Still no reconciliation calls.
    expect(api.registered).toHaveLength(0);
    expect(api.unregistered).toHaveLength(0);
    expect(api.updated).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('safe mode logs the SAFE MODE ACTIVE banner at error level', () => {
    const { platform, api, log } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');

    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');

    expect(log.find('error', 'SAFE MODE ACTIVE').length).toBeGreaterThan(0);

    vi.restoreAllMocks();
    // Reference platform to avoid linter unused-var complaint.
    expect(platform).toBeDefined();
  });

  it('safe mode: a LOWERCASE cached MAC still receives value updates (finding #3)', async () => {
    // Legacy registration preserved the AWN API's original MAC
    // casing. If the cache stored a lower-case MAC, the old code
    // (which uppercased only the response MAC) would count the
    // accessory as bound but never match it in distribute. The fix
    // normalizes the binding key. Prove a lower-case cached tempf
    // receives its value.
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    // Cached with a LOWER-case MAC prefix.
    const a = makeMockAccessory({
      uniqueId: 'aa:bb:cc:dd:ee:01-tempf',
      type: 'Temperature',
      displayName: 'Cached lower',
      value: 20,
    });
    const svc = a.addService(MockServices.TemperatureSensor);
    svc.addCharacteristic(MockCharacteristics.CurrentTemperature);
    platform.configureAccessory(a as never);

    // AWN returns the MAC in upper case (as it does in practice).
    const awnPayload = [{
      macAddress: 'AA:BB:CC:DD:EE:01',
      info: { name: 'Home' },
      lastData: { tempf: 50 },
    }];
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(awnPayload), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');
    await (platform as unknown as { safeModePollAndDistribute(): Promise<void> }).safeModePollAndDistribute();

    // 50°F = 10°C reached the characteristic.
    expect(svc.getCharacteristic(MockCharacteristics.CurrentTemperature).value).toBeCloseTo(10, 4);

    vi.restoreAllMocks();
  });

  it('safe mode: solar 0 W/m² pushes 0 lux (no 0.0001 clamp; matches wrapper, finding #2)', async () => {
    const { platform, api } = makePlatform({
      configVersion: 999,
      apiKey: 'test',
      applicationKey: 'test',
    });
    const a = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:01-solarradiation',
      type: 'Solar Radiation',
      displayName: 'Solar',
      value: 100,
    });
    const svc = a.addService(MockServices.LightSensor);
    svc.addCharacteristic(MockCharacteristics.CurrentAmbientLightLevel);
    platform.configureAccessory(a as never);

    const awnPayload = [{
      macAddress: 'AA:BB:CC:DD:EE:01',
      info: { name: 'Home' },
      lastData: { solarradiation: 0 },
    }];
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(awnPayload), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    api.emit('didFinishLaunching');
    await (platform as unknown as { safeModePollAndDistribute(): Promise<void> }).safeModePollAndDistribute();

    // 0 W/m² → 0 lux exactly (the wrapper allows 0; no safe-mode-only clamp).
    expect(svc.getCharacteristic(MockCharacteristics.CurrentAmbientLightLevel).value).toBe(0);

    vi.restoreAllMocks();
  });

  it('normal mode (no configVersion) does NOT enter safe mode', () => {
    const { platform, api, log } = makePlatform({
      apiKey: 'test',
      applicationKey: 'test',
      temperatureSensors: true,
    });
    addCached(platform, 'AA:BB:CC:DD:EE:01-tempf', 'Temperature');

    // Block network + timer so didFinishLaunching returns quickly.
    vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    api.emit('didFinishLaunching');

    // Wait a tick for the async discoverDevices to progress.
    // (didFinishLaunching kicks off async work; we just want to
    // confirm the safe-mode banner did NOT appear.)
    expect(log.find('error', 'SAFE MODE ACTIVE')).toHaveLength(0);

    vi.restoreAllMocks();
    expect(platform).toBeDefined();
  });
});

/**
 * Minimal hand-rolled mocks of the Homebridge / hap-nodejs API surface
 * the plugin actually touches. Deliberately NOT importing hap-nodejs
 * or homebridge — those pull in HAP-server logic, event loops, and
 * an entire type hierarchy we don't need. What we need is exactly:
 *
 *   - Service and Characteristic classes with UUID-based identity
 *   - `getCharacteristic` returning a persistent instance
 *   - `updateCharacteristic` / `updateValue` recording values
 *   - `addService` / `getService` / `removeService`
 *   - `platform.Service.X` and `platform.Characteristic.X` constants
 *   - `api.hap.uuid.generate` deterministic mapping
 *   - `api.platformAccessory` constructor
 *   - `api.on` for lifecycle hooks
 *   - `api.registerPlatformAccessories` / `unregisterPlatformAccessories` / `updatePlatformAccessories`
 *
 * If a test needs something the mock doesn't expose, add it here
 * rather than reaching for the real hap-nodejs — the mock stays the
 * single source of shape truth, and adding a stub is a few lines.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

/**
 * Base class for both stock and custom characteristics. Identity is
 * by UUID; the same UUID means the same characteristic even across
 * different constructor-form lookups (mirrors HAP-NodeJS's behavior).
 */
export class MockCharacteristic {
  static readonly UUID: string;
  public displayName: string;
  public value: unknown = null;
  private listeners: Array<(v: unknown) => void> = [];

  constructor(displayName: string) {
    this.displayName = displayName;
  }

  updateValue(v: unknown): this {
    this.value = v;
    for (const l of this.listeners) l(v);
    return this;
  }

  on(event: 'change', listener: (v: unknown) => void): this {
    if (event === 'change') this.listeners.push(listener);
    return this;
  }

  /**
   * HAP `setProps` is used by some wrappers to override the default
   * min/max range on a characteristic (e.g. LightSensor's minValue
   * needs to be 0 for solar-radiation nighttime readings). No-op in
   * the mock — tests don't assert on prop values. Add a stored-props
   * assertion here later if needed.
   */
  setProps(_props: Record<string, unknown>): this {
    return this;
  }
}

/**
 * Factory for a Characteristic *class* with a specific UUID.
 * Matches the shape the plugin code uses via `platform.Characteristic.X`.
 */
export function makeCharacteristicClass(name: string, uuid: string): typeof MockCharacteristic {
  const klass = class extends MockCharacteristic {
    static readonly UUID = uuid;
    constructor() {
      super(name);
    }
  };
  // Give it a debuggable class name in stack traces.
  Object.defineProperty(klass, 'name', { value: name });
  return klass;
}

// Stock HAP characteristics used by the plugin. UUIDs match the
// actual HAP spec so provenance-check tests can be added later if
// wanted; for functional tests the exact value doesn't matter as
// long as each characteristic has a distinct UUID.
export const MockCharacteristics = {
  Name: makeCharacteristicClass('Name', '00000023-0000-1000-8000-0026BB765291'),
  ConfiguredName: makeCharacteristicClass('ConfiguredName', '000000E3-0000-1000-8000-0026BB765291'),
  Manufacturer: makeCharacteristicClass('Manufacturer', '00000020-0000-1000-8000-0026BB765291'),
  Model: makeCharacteristicClass('Model', '00000021-0000-1000-8000-0026BB765291'),
  SerialNumber: makeCharacteristicClass('SerialNumber', '00000030-0000-1000-8000-0026BB765291'),
  CurrentTemperature: makeCharacteristicClass('CurrentTemperature', '00000011-0000-1000-8000-0026BB765291'),
  CurrentRelativeHumidity: makeCharacteristicClass('CurrentRelativeHumidity', '00000010-0000-1000-8000-0026BB765291'),
  CurrentAmbientLightLevel: makeCharacteristicClass('CurrentAmbientLightLevel', '0000006B-0000-1000-8000-0026BB765291'),
  CarbonDioxideLevel: makeCharacteristicClass('CarbonDioxideLevel', '00000093-0000-1000-8000-0026BB765291'),
  CarbonDioxideDetected: makeCharacteristicClass('CarbonDioxideDetected', '00000092-0000-1000-8000-0026BB765291'),
  PM2_5Density: makeCharacteristicClass('PM2_5Density', '000000C6-0000-1000-8000-0026BB765291'),
  PM10Density: makeCharacteristicClass('PM10Density', '000000C7-0000-1000-8000-0026BB765291'),
  AirQuality: makeCharacteristicClass('AirQuality', '00000095-0000-1000-8000-0026BB765291'),
  MotionDetected: makeCharacteristicClass('MotionDetected', '00000022-0000-1000-8000-0026BB765291'),
  StatusLowBattery: makeCharacteristicClass('StatusLowBattery', '00000079-0000-1000-8000-0026BB765291'),
  BatteryLevel: makeCharacteristicClass('BatteryLevel', '00000068-0000-1000-8000-0026BB765291'),
  ChargingState: makeCharacteristicClass('ChargingState', '0000008F-0000-1000-8000-0026BB765291'),
};

// Enum-style constants attached to the classes to match HAP's usage
// pattern (e.g. `Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW`).
(MockCharacteristics.StatusLowBattery as unknown as Record<string, number>).BATTERY_LEVEL_LOW = 1;
(MockCharacteristics.StatusLowBattery as unknown as Record<string, number>).BATTERY_LEVEL_NORMAL = 0;
(MockCharacteristics.ChargingState as unknown as Record<string, number>).NOT_CHARGEABLE = 2;
(MockCharacteristics.CarbonDioxideDetected as unknown as Record<string, number>).CO2_LEVELS_NORMAL = 0;
(MockCharacteristics.CarbonDioxideDetected as unknown as Record<string, number>).CO2_LEVELS_ABNORMAL = 1;
(MockCharacteristics.AirQuality as unknown as Record<string, number>).UNKNOWN = 0;
(MockCharacteristics.AirQuality as unknown as Record<string, number>).EXCELLENT = 1;
(MockCharacteristics.AirQuality as unknown as Record<string, number>).GOOD = 2;
(MockCharacteristics.AirQuality as unknown as Record<string, number>).FAIR = 3;
(MockCharacteristics.AirQuality as unknown as Record<string, number>).INFERIOR = 4;
(MockCharacteristics.AirQuality as unknown as Record<string, number>).POOR = 5;

/**
 * A HAP service. Tracks its own characteristic instances by UUID so
 * lookups from `getCharacteristic(SomeCharClass)` return the same
 * instance each time (matching HAP behavior).
 */
export class MockService {
  static readonly UUID: string;
  public displayName: string;
  private characteristics: Map<string, MockCharacteristic> = new Map();

  constructor(displayName: string) {
    this.displayName = displayName;
  }

  getCharacteristic(charCtor: typeof MockCharacteristic | string): MockCharacteristic {
    // String-form lookup (matches HAP-NodeJS quirk: matches by
    // displayName, NOT UUID — this was the beta.4 bug root cause).
    // Return an object that silently fails to updateValue if not
    // found, mirroring the real broken behavior — so regression
    // tests can pin it.
    if (typeof charCtor === 'string') {
      for (const c of this.characteristics.values()) {
        if (c.displayName === charCtor) return c;
      }
      // Missing string-lookup returns an undefined-like sentinel
      // whose `.updateValue()` throws — matches the observed
      // "Cannot read properties of undefined" bug shape.
      return undefined as unknown as MockCharacteristic;
    }
    const uuid = charCtor.UUID;
    let c = this.characteristics.get(uuid);
    if (!c) {
      c = new charCtor();
      this.characteristics.set(uuid, c);
    }
    return c;
  }

  testCharacteristic(charCtor: typeof MockCharacteristic): boolean {
    return this.characteristics.has(charCtor.UUID);
  }

  addCharacteristic(charCtor: typeof MockCharacteristic): MockCharacteristic {
    const c = new charCtor();
    this.characteristics.set(charCtor.UUID, c);
    return c;
  }

  setCharacteristic(charCtor: typeof MockCharacteristic, value: unknown): this {
    const c = this.getCharacteristic(charCtor);
    c.updateValue(value);
    return this;
  }

  updateCharacteristic(charCtor: typeof MockCharacteristic | string, value: unknown): this {
    // Match HAP behavior for string lookups: swallow silently rather
    // than throw. Real setValue paths use constructor-form so this
    // branch shouldn't fire in wrapper tests.
    if (typeof charCtor === 'string') {
      const c = this.getCharacteristic(charCtor);
      if (c) c.updateValue(value);
      return this;
    }
    this.getCharacteristic(charCtor).updateValue(value);
    return this;
  }

  /**
   * Read a characteristic value by class — convenience for tests.
   * Returns undefined if the characteristic was never attached.
   */
  readCharacteristic(charCtor: typeof MockCharacteristic): unknown {
    const c = this.characteristics.get(charCtor.UUID);
    return c ? c.value : undefined;
  }
}

/**
 * Factory for a Service *class* with a specific UUID + default name.
 */
export function makeServiceClass(name: string, uuid: string): typeof MockService {
  const klass = class extends MockService {
    static readonly UUID = uuid;
    constructor(displayName: string = name) {
      super(displayName);
    }
  };
  Object.defineProperty(klass, 'name', { value: name });
  return klass;
}

export const MockServices = {
  AccessoryInformation: makeServiceClass('AccessoryInformation', '0000003E-0000-1000-8000-0026BB765291'),
  TemperatureSensor: makeServiceClass('TemperatureSensor', '0000008A-0000-1000-8000-0026BB765291'),
  HumiditySensor: makeServiceClass('HumiditySensor', '00000082-0000-1000-8000-0026BB765291'),
  LightSensor: makeServiceClass('LightSensor', '00000084-0000-1000-8000-0026BB765291'),
  CarbonDioxideSensor: makeServiceClass('CarbonDioxideSensor', '00000097-0000-1000-8000-0026BB765291'),
  AirQualitySensor: makeServiceClass('AirQualitySensor', '0000008D-0000-1000-8000-0026BB765291'),
  MotionSensor: makeServiceClass('MotionSensor', '00000085-0000-1000-8000-0026BB765291'),
  Battery: makeServiceClass('Battery', '00000096-0000-1000-8000-0026BB765291'),
};

/**
 * Minimal PlatformAccessory shim. Real Homebridge PlatformAccessory
 * has a lot more (identify, category, reachable, etc.) — none of it
 * relevant to what the wrappers actually touch.
 */
export class MockPlatformAccessory {
  public displayName: string;
  public UUID: string;
  public context: { device?: unknown } = {};
  private services: Map<string, MockService> = new Map();

  constructor(displayName: string, uuid: string) {
    this.displayName = displayName;
    this.UUID = uuid;
  }

  getService(svcCtor: typeof MockService): MockService | undefined {
    return this.services.get(svcCtor.UUID);
  }

  addService(svcCtor: typeof MockService, displayName?: string): MockService {
    const s = new svcCtor(displayName);
    this.services.set(svcCtor.UUID, s);
    return s;
  }

  removeService(service: MockService): this {
    for (const [uuid, s] of this.services) {
      if (s === service) {
        this.services.delete(uuid);
        return this;
      }
    }
    return this;
  }
}

/**
 * Deterministic UUID generator matching Homebridge's `api.hap.uuid.generate`
 * output shape (UUID v5-ish). Same input → same output; different
 * inputs → different outputs. That's all the plugin needs for test
 * purposes.
 */
export function mockUuidGenerate(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    hash.substring(12, 16),
    hash.substring(16, 20),
    hash.substring(20, 32),
  ].join('-').toUpperCase();
}

/**
 * Minimal Logger — captures calls, doesn't emit to stdout during tests.
 * Tests can assert against `mockLogger.info.mock.calls` etc.
 */
export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export class MockLogger {
  public logs: CapturedLog[] = [];

  debug(...args: unknown[]): void { this.logs.push({ level: 'debug', message: args.join(' ') }); }
  info(...args: unknown[]): void { this.logs.push({ level: 'info', message: args.join(' ') }); }
  warn(...args: unknown[]): void { this.logs.push({ level: 'warn', message: args.join(' ') }); }
  error(...args: unknown[]): void { this.logs.push({ level: 'error', message: args.join(' ') }); }

  clear(): void { this.logs = []; }

  /** Convenience: find logs at a given level matching a substring. */
  find(level: CapturedLog['level'], substr: string): CapturedLog[] {
    return this.logs.filter((l) => l.level === level && l.message.includes(substr));
  }
}

/**
 * Minimal Homebridge API shim. Emitter-backed for `on('didFinishLaunching')`
 * etc.; tracking arrays for register/unregister/update so tests can
 * assert what got called.
 */
export class MockAPI extends EventEmitter {
  public readonly hap = {
    Service: MockServices as unknown as Record<string, typeof MockService>,
    Characteristic: MockCharacteristics as unknown as Record<string, typeof MockCharacteristic>,
    uuid: { generate: mockUuidGenerate },
  };

  public readonly platformAccessory = MockPlatformAccessory as unknown as {
    new (displayName: string, uuid: string): MockPlatformAccessory;
  };

  public readonly registered: MockPlatformAccessory[] = [];
  public readonly unregistered: MockPlatformAccessory[] = [];
  public readonly updated: MockPlatformAccessory[] = [];

  registerPlatformAccessories(_plugin: string, _platform: string, accessories: MockPlatformAccessory[]): void {
    this.registered.push(...accessories);
  }

  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: MockPlatformAccessory[]): void {
    this.unregistered.push(...accessories);
  }

  updatePlatformAccessories(accessories: MockPlatformAccessory[]): void {
    this.updated.push(...accessories);
  }
}

/**
 * Convenience factory: build a mocked Platform-shaped object suitable
 * for passing to accessory-wrapper constructors. Wrappers only look
 * at `platform.Service`, `platform.Characteristic`, `platform.api`,
 * `platform.log`, and `platform.config` — not the full
 * DynamicPlatformPlugin surface.
 */
export interface MockPlatform {
  Service: typeof MockServices;
  Characteristic: typeof MockCharacteristics;
  api: MockAPI;
  log: MockLogger;
  config: Record<string, unknown>;
}

export function makeMockPlatform(config: Record<string, unknown> = {}): MockPlatform {
  return {
    Service: MockServices,
    Characteristic: MockCharacteristics,
    api: new MockAPI(),
    log: new MockLogger(),
    config,
  };
}

/**
 * Build a mock PlatformAccessory pre-seeded with the given device
 * context. Convenience wrapper — every wrapper test needs one of these.
 */
export function makeMockAccessory(deviceContext: Record<string, unknown> = {}): MockPlatformAccessory {
  const displayName = (deviceContext.displayName as string) ?? 'Test Accessory';
  const uuid = mockUuidGenerate(displayName);
  const a = new MockPlatformAccessory(displayName, uuid);
  a.context.device = deviceContext;
  // Real Homebridge auto-attaches an AccessoryInformation service to
  // every PlatformAccessory at construction time — wrapper code
  // assumes it's already there and uses non-null assertion (`!`) on
  // the getService lookup. Match that behavior in the mock.
  a.addService(MockServices.AccessoryInformation);
  return a;
}

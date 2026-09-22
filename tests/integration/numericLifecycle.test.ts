/**
 * Generic numeric passthrough platform lifecycle (issue #63 P3.1 —
 * sensor-map.md §19.9). Real HAP through the platform: the value renders
 * with its literal label and no invented precision, the inclusive-level
 * threshold drives motion over BOTH transports, no Intensity is
 * attached, the accessory honors enable/disable across a cached restart,
 * a future catalog stamp enters protective mode (retaining the
 * accessory), a catalog-3 config leaves the pair no-wrapper, and the
 * assignment never appears in the legacy mirror.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import hap from '@homebridge/hap-nodejs';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { RealtimeSource } from '../../src/realtimeSource';
import {
  VALUE_CHARACTERISTIC_UUID,
  INTENSITY_CHARACTERISTIC_UUID,
} from '../../src/extendedSensors/customCharacteristics';
import { HapMockAPI, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';
const silentDeps = { info() {}, debug() {}, warn() {}, error() {}, log() {} };

const NUMERIC_ROW = {
  dataPoint: 'flow1', kind: 'motion', measurement: 'numeric', sourceUnit: 'raw',
  unitLabel: 'L/min', threshold: 5, triggerEnabled: true, triggerDirection: 'above', enabled: true,
};

const block = (sensorMap: unknown[], catalogAdopted = 4) => ({
  platform: 'AmbientWeatherSensors', name: 'Review', apiKey: 'k', applicationKey: 'a',
  dataSource: 'polling', _sensorMapV2: true, configVersion: 2,
  catalogBaseline: 1, catalogAdopted, sensorMap,
});

const roots: string[] = [];
async function boot(
  config: Record<string, unknown>,
  cached: HapLifecyclePlatformAccessory[] = [],
  raw: Record<string, unknown> = { flow1: 3 },
) {
  const api = new HapMockAPI();
  const logger = new MockLogger();
  roots.push(api.user.storagePath());
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify([
    { macAddress: MAC, info: { name: 'Review Station' }, lastData: raw },
  ]), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const platform = new AmbientWeatherSensorsPlatform(logger as never, config as never, api as never);
  for (const accessory of cached) {
    platform.configureAccessory(accessory as never);
  }
  api.emit('didFinishLaunching');
  await vi.waitFor(
    () => expect(api.registered.length + api.unregistered.length + api.updated.length).toBeGreaterThan(0),
    { timeout: 10000 },
  );
  return { api, platform, logger };
}

/**
 * Safe mode skips device discovery entirely, so it makes no
 * register/unregister/update calls and the boot counter never advances.
 * Set up, fire didFinishLaunching, and return WITHOUT waiting — the
 * protective-posture decisions are synchronous (see safeMode.test.ts).
 */
function bootSync(config: Record<string, unknown>, cached: HapLifecyclePlatformAccessory[] = []) {
  const api = new HapMockAPI();
  const logger = new MockLogger();
  roots.push(api.user.storagePath());
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]', {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const platform = new AmbientWeatherSensorsPlatform(logger as never, config as never, api as never);
  for (const accessory of cached) {
    platform.configureAccessory(accessory as never);
  }
  api.emit('didFinishLaunching');
  return { api, platform, logger };
}

afterEach(() => {
  vi.restoreAllMocks();
  const { rmSync } = require('node:fs');
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const motionOf = (acc: { getService(s: unknown): unknown }): unknown => {
  const svc = acc.getService(hap.Service.MotionSensor) as hap.Service;
  return svc.getCharacteristic(hap.Characteristic.MotionDetected).value;
};
const valueOf = (acc: { getService(s: unknown): unknown }): unknown => {
  const svc = acc.getService(hap.Service.MotionSensor) as hap.Service;
  const ch = svc.characteristics.find(c => c.UUID === VALUE_CHARACTERISTIC_UUID);
  return ch?.value;
};
const hasIntensity = (acc: { getService(s: unknown): unknown }): boolean => {
  const svc = acc.getService(hap.Service.MotionSensor) as hap.Service;
  return svc.characteristics.some(c => c.UUID === INTENSITY_CHARACTERISTIC_UUID);
};

describe('numeric passthrough registers and renders honestly (§19.9)', () => {
  it('renders the finite value with its label, no Intensity, and an inclusive-level trigger', async () => {
    const live = await boot(block([NUMERIC_ROW]), [], { flow1: 3 });
    expect(live.api.registered).toHaveLength(1);
    const acc = live.api.registered[0];
    // 3 < threshold 5: below the level, motion clear; label appended.
    expect(valueOf(acc)).toBe('3 L/min');
    expect(motionOf(acc)).toBe(false);
    // Raw number is a generic reading — no qualitative bucket.
    expect(hasIntensity(acc)).toBe(false);
  });

  it('formats extremes in ordinary string form (no forced decimals, scientific allowed)', async () => {
    const cases: Array<[number, string]> = [
      [0, '0 L/min'],
      [5, '5 L/min'],           // trailing-zero-free integer
      [3.5, '3.5 L/min'],
      [-2.25, '-2.25 L/min'],
      [1e-9, '1e-9 L/min'],     // scientific for extremes is acceptable
    ];
    for (const [raw, expected] of cases) {
      const live = await boot(block([NUMERIC_ROW]), [], { flow1: raw });
      expect(valueOf(live.api.registered[0]), String(raw)).toBe(expected);
    }
  });

  it('renders a maximum-length label', async () => {
    const label = 'x'.repeat(16);
    const live = await boot(block([{ ...NUMERIC_ROW, unitLabel: label }]), [], { flow1: 7 });
    expect(valueOf(live.api.registered[0])).toBe(`7 ${label}`);
  });

  it('a numeric row with no label renders the bare number', async () => {
    const { unitLabel: _drop, ...noLabel } = NUMERIC_ROW;
    const live = await boot(block([noLabel]), [], { flow1: 42 });
    expect(valueOf(live.api.registered[0])).toBe('42');
  });
});

describe('numeric inclusive-level trigger over both transports (§19.9 / F5)', () => {
  it('activates AT the threshold (>=) and compares the unrounded raw value', async () => {
    // 5 == threshold 5: inclusive, so motion is active at the boundary.
    const live = await boot(block([NUMERIC_ROW]), [], { flow1: 5 });
    expect(motionOf(live.api.registered[0])).toBe(true);
  });

  it('the below direction is inclusive (<=): active at or under the threshold', async () => {
    const belowRow = { ...NUMERIC_ROW, triggerDirection: 'below', threshold: 5 };
    const atLevel = await boot(block([belowRow]), [], { flow1: 5 });
    expect(motionOf(atLevel.api.registered[0])).toBe(true);   // 5 <= 5
    const under = await boot(block([belowRow]), [], { flow1: 4 });
    expect(motionOf(under.api.registered[0])).toBe(true);     // 4 <= 5
    const over = await boot(block([belowRow]), [], { flow1: 6 });
    expect(motionOf(over.api.registered[0])).toBe(false);     // 6 > 5
  });

  it('tracks the level across realtime updates without formatting affecting the compare', async () => {
    const live = await boot(block([NUMERIC_ROW]), [], { flow1: 2 });
    const acc = live.api.registered[0];
    expect(motionOf(acc)).toBe(false);
    const source = new RealtimeSource({
      apiKey: 'k', applicationKey: 'a', log: silentDeps as never, catalogAdopted: 4,
      onUpdates: updates => (live.platform as unknown as { distribute(u: unknown[]): void }).distribute(updates),
    });
    const push = (v: unknown) =>
      (source as unknown as { handleDevicePayload(d: Record<string, unknown>): void })
        .handleDevicePayload({ macAddress: MAC, flow1: v });
    push(4.999);
    expect(motionOf(acc)).toBe(false);
    expect(valueOf(acc)).toBe('4.999 L/min');
    push(5);
    expect(motionOf(acc)).toBe(true);
    // A non-finite tick is dropped: value and motion are unchanged.
    push(null);
    expect(motionOf(acc)).toBe(true);
    expect(valueOf(acc)).toBe('5 L/min');
  });
});

describe('numeric lifecycle: enable/disable across a cached restart (§19.9)', () => {
  it('registers when enabled and unregisters when explicitly disabled', async () => {
    const first = await boot(block([NUMERIC_ROW]));
    expect(first.api.registered).toHaveLength(1);
    expect(first.api.unregistered).toHaveLength(0);

    const second = await boot(block([{ ...NUMERIC_ROW, enabled: false }]), first.api.registered);
    const removed = second.api.unregistered.map(a => (a.context.device as { uniqueId?: string }).uniqueId);
    expect(removed).toEqual([`${MAC}-flow1`]);
    expect(second.platform.accessories).toHaveLength(0);
  });
});

describe('numeric stamps: fail-closed and protective mode (§19.9 / F1)', () => {
  it('a flag-off (opt-out) config ignores the numeric row entirely', async () => {
    // _sensorMapV2:false is the legacy runtime: the sensorMap is not
    // consulted at all, so an authored numeric row registers nothing and
    // a legacy tempf toggle still drives its own accessory.
    const flagOff = {
      platform: 'AmbientWeatherSensors', name: 'Review', apiKey: 'k', applicationKey: 'a',
      dataSource: 'polling', _sensorMapV2: false, temperatureSensors: true,
      sensorMap: [NUMERIC_ROW],
    };
    const live = await boot(flagOff, [], { tempf: 70, flow1: 3 });
    const ids = live.api.registered.map(a => (a.context.device as { uniqueId?: string }).uniqueId);
    expect(ids).not.toContain(`${MAC}-flow1`);
  });

  it('a catalog-3 config leaves motion|numeric no-wrapper (registers nothing for it)', async () => {
    // A native tempf default registers so the boot resolves; the
    // authored numeric row resolves no-wrapper at catalog 3 and is
    // dropped, exactly as before P3.1 shipped.
    const live = await boot(block([NUMERIC_ROW], 3), [], { tempf: 70, flow1: 3 });
    const ids = live.api.registered.map(a => (a.context.device as { uniqueId?: string }).uniqueId);
    expect(ids).toContain(`${MAC}-tempf`);
    expect(ids).not.toContain(`${MAC}-flow1`);
  });

  it('a FUTURE catalog stamp enters protective mode: the cached accessory is retained, none removed', async () => {
    const first = await boot(block([NUMERIC_ROW]));
    expect(first.api.registered).toHaveLength(1);

    // A stamp newer than this build supports (the older-binary case):
    // parseCatalogStamps rejects it, detectConfigMode enters safe mode,
    // which is reconciliation-free — the decisions are synchronous.
    const future = {
      platform: 'AmbientWeatherSensors', name: 'Review', apiKey: 'k', applicationKey: 'a',
      dataSource: 'polling', _sensorMapV2: true, configVersion: 2,
      catalogBaseline: 1, catalogAdopted: 99, sensorMap: [NUMERIC_ROW],
    };
    const second = bootSync(future, first.api.registered);
    expect(second.api.registered).toEqual([]);             // nothing registered
    expect(second.api.unregistered).toEqual([]);           // nothing removed
    expect(second.platform.accessories).toHaveLength(1);    // retained
    expect((second.platform.accessories[0].context.device as { uniqueId?: string }).uniqueId)
      .toBe(`${MAC}-flow1`);
  });
});

describe('numeric assignments stay out of the legacy mirror (§19.9)', () => {
  it('the cached device carries the catalog-4 marker type, not a legacy sensor type', async () => {
    // The legacy `context.device.type` a downgrade would read is the
    // catalog-4 marker 'Numeric', deliberately OUTSIDE 1.7's
    // createSensorWrapper vocabulary — so a numeric assignment is never
    // reconstructable as a legacy field on downgrade.
    const live = await boot(block([NUMERIC_ROW]), [], { flow1: 3 });
    const acc = live.api.registered.find(
      a => (a.context.device as { uniqueId?: string }).uniqueId === `${MAC}-flow1`,
    );
    expect(acc, 'numeric accessory registered').toBeDefined();
    expect((acc!.context.device as { type?: string }).type).toBe('Numeric');
  });
});

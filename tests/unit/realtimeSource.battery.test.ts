/**
 * RealtimeSource battery-field resolution (finding-#4 Stage 4, final
 * commit): the platform injects the shared row-aware
 * `resolveBatteryField` reader at construction; a bare construction
 * keeps the v1.6.0 static lookup, so the flag-off realtime path is
 * untouched.
 *
 * These tests drive the private `handleDevicePayload` directly — the
 * socket lifecycle is irrelevant to resolution and never started.
 */
import { describe, expect, it } from 'vitest';

import { RealtimeSource, type RealtimeUpdate } from '../../src/realtimeSource';

const MAC = 'AA:BB:CC:DD:EE:01';

const silentLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {},
  success: () => {},
} as unknown as import('homebridge').Logger;

function collectUpdates(source: RealtimeSource, payload: unknown): RealtimeUpdate[] {
  (source as unknown as { handleDevicePayload(p: unknown): void }).handleDevicePayload(payload);
  return collected;
}

let collected: RealtimeUpdate[] = [];
function makeSource(resolveBatteryField?: (mac: string, dp: string) => string | null): RealtimeSource {
  collected = [];
  return new RealtimeSource({
    apiKey: 'k', applicationKey: 'a', log: silentLog,
    onUpdates: (u) => { collected = u; },
    resolveBatteryField,
  });
}

describe('RealtimeSource battery-field resolution', () => {
  it('without an injected resolver, keeps the v1.6.0 static lookup (flag-off parity)', () => {
    const source = makeSource();
    const updates = collectUpdates(source, { macAddress: MAC, tempf: 68, battout: 0 });
    const temp = updates.find(u => u.uniqueId === `${MAC}-tempf`);
    expect(temp?.batteryLow).toBe(true);
  });

  it('an injected resolver drives per-update battery resolution (custom field)', () => {
    const source = makeSource((mac, dp) => (dp === 'my_barn' ? 'barn_batt' : null));
    const updates = collectUpdates(source, { macAddress: MAC, my_barn: 21, barn_batt: 0, battout: 1 });
    const barn = updates.find(u => u.uniqueId === `${MAC}-my_barn`);
    expect(barn?.batteryLow).toBe(true);
  });

  it('a resolver returning null suppresses the batteryLow the static lookup would have produced', () => {
    // Simulates the v2 suppressed-owner case (tempf batteryField: null):
    // the payload carries battout=0, but the resolver says NO field.
    const source = makeSource(() => null);
    const updates = collectUpdates(source, { macAddress: MAC, tempf: 68, battout: 0 });
    const temp = updates.find(u => u.uniqueId === `${MAC}-tempf`);
    expect(temp).toBeDefined();
    expect(temp?.batteryLow).toBeUndefined();
  });

  it('passes the payload MAC and sensor key through to the resolver', () => {
    const seen: Array<[string, string]> = [];
    const source = makeSource((mac, dp) => { seen.push([mac, dp]); return null; });
    collectUpdates(source, { macAddress: MAC, tempf: 68 });
    expect(seen).toContainEqual([MAC, 'tempf']);
  });
});

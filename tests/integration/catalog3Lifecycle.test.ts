/**
 * Catalog-3 platform lifecycle (issue #63 P3 — sensor-map.md §19.7,
 * PR #67 review F1). The reviewer's headline scenario asserted at the
 * CORRECTED outcome: with catalog 3 adopted, every new wrapper type
 * registers when enabled and UNREGISTERS when explicitly disabled and
 * the platform reboots against its own v2-written cache. Before the
 * fix these evaded removal (their novel dataPoints/types fell to the
 * legacy-only measurement inference → preserve-cached).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { HapMockAPI, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';

// One accessory per catalog-3 wrapper type: the boolean state kinds
// (custom dataPoints), and the numeric catalog-3 default rows.
const ENABLED = [
  { dataPoint: 'leak1', enabled: true },
  { dataPoint: 'my_contact', kind: 'contact', measurement: 'boolean', enabled: true },
  { dataPoint: 'my_occupancy', kind: 'occupancy', measurement: 'boolean', enabled: true },
  { dataPoint: 'my_smoke', kind: 'smoke', measurement: 'boolean', enabled: true },
  { dataPoint: 'my_motion', kind: 'motion', measurement: 'boolean', enabled: true },
  { dataPoint: 'soilhum1', enabled: true },
  { dataPoint: 'leafwetness1', enabled: true },
  { dataPoint: 'soiltens1', enabled: true },
  { dataPoint: 'etos', enabled: true },
  { dataPoint: 'aqi_pm25_aqin', enabled: true },
];
const RAW: Record<string, unknown> = Object.fromEntries(ENABLED.map(p => [p.dataPoint, 1]));

const block = (sensorMap: unknown[]) => ({
  platform: 'AmbientWeatherSensors', name: 'Review', apiKey: 'k', applicationKey: 'a',
  dataSource: 'polling', _sensorMapV2: true, configVersion: 2,
  catalogBaseline: 1, catalogAdopted: 3, sensorMap,
});

const roots: string[] = [];
async function boot(config: Record<string, unknown>, cached: HapLifecyclePlatformAccessory[] = []) {
  const api = new HapMockAPI();
  const logger = new MockLogger();
  roots.push(api.user.storagePath());
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify([
    { macAddress: MAC, info: { name: 'Review Station' }, lastData: RAW },
  ]), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as never);
  const platform = new AmbientWeatherSensorsPlatform(logger as never, config as never, api as never);
  for (const accessory of cached) {
    platform.configureAccessory(accessory as never);
  }
  api.emit('didFinishLaunching');
  await vi.waitFor(() => expect(api.registered.length + api.unregistered.length).toBeGreaterThan(0), { timeout: 10000 });
  return { api, platform, logger };
}

afterEach(() => {
  vi.restoreAllMocks();
  const { rmSync } = require('node:fs');
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe('catalog-3 accessories honor an explicit disable across a cached restart (§19.7 / review F1)', () => {
  it('all ten new wrapper types register when enabled and unregister when disabled', async () => {
    const first = await boot(block(ENABLED));
    expect(first.api.registered).toHaveLength(ENABLED.length);
    expect(first.api.unregistered).toHaveLength(0);

    // Disable every row; reboot the platform against its own
    // v2-written cache from the first run.
    const disabled = ENABLED.map(p => ({ ...p, enabled: false }));
    const second = await boot(block(disabled), first.api.registered);

    // Every disabled accessory is now explicitly removed — none is
    // silently preserved as an un-inferable orphan.
    const removed = second.api.unregistered
      .map(a => (a.context.device as { uniqueId?: string }).uniqueId).sort();
    expect(removed).toEqual(ENABLED.map(p => `${MAC}-${p.dataPoint}`).sort());
    expect(second.platform.accessories).toHaveLength(0);
    expect(second.logger.logs.filter(l => l.message.startsWith('Preserving cached accessory'))).toHaveLength(0);
  });
});

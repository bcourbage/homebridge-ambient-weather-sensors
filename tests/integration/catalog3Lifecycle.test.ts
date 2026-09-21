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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import hap from '@homebridge/hap-nodejs';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { handlePreviewSave, handleComposeSave, handleCommitSave } from '../../homebridge-ui/handlers';
import { HapMockAPI, type HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';
import { MockLogger } from '../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';
const silentDeps = { info() {}, debug() {}, warn() {}, error() {}, log() {} };

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
async function boot(
  config: Record<string, unknown>,
  cached: HapLifecyclePlatformAccessory[] = [],
  raw: Record<string, unknown> = RAW,
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
  await vi.waitFor(() => expect(api.registered.length + api.unregistered.length + api.updated.length).toBeGreaterThan(0), { timeout: 10000 });
  return { api, platform, logger };
}

/** A save-pipeline deps rig (config.json + discovery on disk). */
function rig(base: Record<string, unknown>, fields: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'awn-c3lc-'));
  roots.push(root);
  const persistDir = path.join(root, 'plugin-data', 'ambient-weather');
  mkdirSync(persistDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: [base] }));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({
    schemaVersion: 1,
    entries: fields.map(dataPoint => ({
      stationMac: MAC, stationName: 'Review Station', dataPoint,
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
    })),
  }));
  return { persistDir, configPath, log: silentDeps, version: 'review' };
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

describe('pure conversion never silently flips battery polarity (§19.6 / review R2-F2)', () => {
  // A legacy-shaped block (no configVersion) with the v2 flag ON and a
  // valid catalog-3 stamp runs the v2 compat pipeline BEFORE conversion
  // and genuine v2 AFTER. Both must decode the vendor-inverted
  // batt_lightning at catalog 3, so conversion changes nothing.
  it.each([[1, 0], [1, 1], [3, 0], [3, 1]] as const)(
    'baseline %i / raw batt_lightning %i: decode is unchanged across conversion, preview lists no polarity change',
    async (baseline, batteryRaw) => {
      const base = {
        platform: 'AmbientWeatherSensors', name: 'Review', apiKey: 'k', applicationKey: 'a',
        dataSource: 'polling', _sensorMapV2: true, catalogBaseline: baseline, catalogAdopted: 3,
        extendedSensors: true, lightningSensors: true,
      };
      const raw = { lightning_day: 1, batt_lightning: batteryRaw };
      const before = await boot(base, [], raw);
      expect(before.api.registered).toHaveLength(1);
      const battery = before.api.registered[0].getService(hap.Service.Battery) as hap.Service;
      const priorLow = battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value;

      const deps = rig(base, Object.keys(raw));
      const preview = await handlePreviewSave(deps, { base });
      expect(preview.ok, preview.ok ? '' : JSON.stringify((preview as { error: unknown }).error)).toBe(true);
      if (!preview.ok) return;
      expect(preview.changes).toEqual([]);
      expect(preview.batteryPolarity).toEqual([]);
      const validated = await handleComposeSave(deps, { base, confirmDigest: preview.digest });
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const committed = await handleCommitSave(deps, { base, confirmDigest: preview.digest, validationToken: validated.validationToken });
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect((committed.nextConfig as Record<string, unknown>).catalogAdopted).toBe(3);

      const after = await boot(committed.nextConfig as Record<string, unknown>, before.api.registered, raw);
      expect(after.api.unregistered).toEqual([]);
      expect(battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value).toBe(priorLow);
    });
});

describe('an unknown battery reading never erases a retained low condition (review R2-F3)', () => {
  it('cached restart with an invalid batleak reading keeps LOW/5', async () => {
    const config = block([{ dataPoint: 'leak1', enabled: true }]);
    const first = await boot(config, [], { leak1: 0, batleak1: 1 });
    expect(first.api.registered).toHaveLength(1);
    // The persistent accessory objects — a restart RESTORES these (via
    // configureAccessory), it does not re-register, so the same objects
    // carry across every reboot.
    const persistent = first.api.registered;
    const battery = persistent[0].getService(hap.Service.Battery) as hap.Service;
    expect(battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value).toBe(1);
    expect(battery.getCharacteristic(hap.Characteristic.BatteryLevel).value).toBe(5);

    // Restart with an INVALID vendor battery reading (2): the reader
    // returns unknown, and the retained LOW/5 must survive.
    const second = await boot(config, persistent, { leak1: 0, batleak1: 2 });
    expect(second.api.unregistered).toEqual([]);
    expect(battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value).toBe(1);
    expect(battery.getCharacteristic(hap.Characteristic.BatteryLevel).value).toBe(5);

    // A valid OK reading later recovers to NORMAL.
    const third = await boot(config, persistent, { leak1: 0, batleak1: 0 });
    expect(third.api.unregistered).toEqual([]);
    expect(battery.getCharacteristic(hap.Characteristic.StatusLowBattery).value).toBe(0);
  });
});

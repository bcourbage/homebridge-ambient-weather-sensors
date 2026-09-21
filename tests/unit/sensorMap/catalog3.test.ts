/**
 * Catalog-3 behavior proofs (issue #63 P3 — sensor-map.md §19.7):
 * the explicit tri-state decode through the REAL wrappers, the
 * adoption-gated battery polarity, catalog-3 exposure arithmetic, and
 * the §18.4 preservation invariants re-run against catalog 3.
 */
import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { buildWrapperRouting, distributeViaRouting } from '../../../src/sensorMap/routing';
import { instantiateWrapper } from '../../../src/sensorMap/wrapperFactories';
import { RealtimeSource } from '../../../src/realtimeSource';
import { readBatteryLow, VENDOR_INVERTED_BATTERY_FIELDS } from '../../../src/batteryFields';
import { CATALOG_V3_ROWS, catalogRowFor, defaultRowFor, staticDefaultRowFor } from '../../../src/sensorMap/defaultMap';
import type { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';
import type {
  DiscoveryStore,
  EffectiveSensorRow,
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../../../src/sensorMap/types';

const MAC = 'AA:BB:CC:DD:EE:01';
const STATIONS: StationInventory = [{ macAddress: MAC, name: 'Home' }];

function emptyDiscovery(): DiscoveryStore {
  return { schemaVersion: 1, entries: [] };
}
function emptyUiState(): UiStateStore {
  return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}
function input(overrides: unknown[], stamps: { baseline: number; adopted: number }) {
  return {
    userOverrides: overrides,
    discovery: emptyDiscovery(),
    uiState: emptyUiState(),
    stations: STATIONS,
    configMode: 'v2' as const,
    catalogBaseline: stamps.baseline,
    catalogAdopted: stamps.adopted,
  };
}
type ConfiguredRow = Exclude<EffectiveSensorRow, { kind: 'unrecognized' }>;
function configured(map: { rows: EffectiveSensorRow[] }, dp: string): ConfiguredRow {
  const r = map.rows.find(x => x.stationMac === MAC && x.dataPoint === dp);
  if (!r || r.kind === 'unrecognized') throw new Error(`no configured row for ${dp}`);
  return r;
}

/** Route one raw value through the REAL wrapper for a resolved row. */
function routeThrough(row: ConfiguredRow, raw: number) {
  const platform = makeMockPlatform();
  const accessory = makeMockAccessory({ uniqueId: `${MAC}-${row.dataPoint}`, displayName: row.name ?? row.dataPoint });
  const routing = buildWrapperRouting(
    platform as unknown as AmbientWeatherSensorsPlatform,
    { rows: [row], errors: [], warnings: [], notes: [] },
    () => accessory as never,
  );
  distributeViaRouting(
    platform as unknown as AmbientWeatherSensorsPlatform,
    routing,
    [{ macAddress: MAC, lastData: { [row.dataPoint]: raw } }],
  );
  return accessory;
}

describe('§19.1 tri-state decode through the real wrappers — offline never reads active', () => {
  const STATE_CASES = [
    ['leak', 'leak', MockServices.LeakSensor, MockCharacteristics.LeakDetected, 1, 0],
    ['contact', 'contact', MockServices.ContactSensor, MockCharacteristics.ContactSensorState, 1, 0],
    ['occupancy', 'occupancy', MockServices.OccupancySensor, MockCharacteristics.OccupancyDetected, 1, 0],
    ['smoke', 'smoke', MockServices.SmokeSensor, MockCharacteristics.SmokeDetected, 1, 0],
    ['motion', 'motion-bool', MockServices.MotionSensor, MockCharacteristics.MotionDetected, true, false],
  ] as const;

  for (const [kind, label, service, characteristic, active, clear] of STATE_CASES) {
    it(`${kind}: 0 clear, 1 active, 2 FAULT with the alert forced clear`, () => {
      const override: SensorMapOverride = {
        dataPoint: `test_${label}`, kind, measurement: 'boolean', name: `Test ${label}`,
      };
      const map = buildEffectiveSensorMap(input([override], { baseline: 1, adopted: 3 }));
      expect(map.errors).toEqual([]);
      const row = configured(map, `test_${label}`);

      const at = (raw: number) => {
        const accessory = routeThrough(row, raw);
        const svc = accessory.getService(service)!;
        return {
          state: svc.readCharacteristic(characteristic),
          fault: svc.readCharacteristic(MockCharacteristics.StatusFault),
        };
      };
      expect(at(0)).toEqual({ state: clear, fault: 0 });
      expect(at(1)).toEqual({ state: active, fault: 0 });
      // The declared leak '2 = offline' and any other out-of-contract
      // value: StatusFault, alert CLEAR — never active.
      expect(at(2)).toEqual({ state: clear, fault: 1 });
      expect(at(7)).toEqual({ state: clear, fault: 1 });
    });
  }

  it('the catalog leak1 definition itself decodes 2 as offline, not leak', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'leak1', enabled: true }], { baseline: 1, adopted: 3 }));
    expect(map.errors).toEqual([]);
    const row = configured(map, 'leak1');
    expect(row.kind).toBe('leak');
    const accessory = routeThrough(row, 2);
    const svc = accessory.getService(MockServices.LeakSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.LeakDetected)).toBe(0);
    expect(svc.readCharacteristic(MockCharacteristics.StatusFault)).toBe(1);
  });

  it('a clean reading clears the fault', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'leak1', enabled: true }], { baseline: 1, adopted: 3 }));
    const row = configured(map, 'leak1');
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-leak1`, displayName: 'Leak 1' });
    const routing = buildWrapperRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      { rows: [row], errors: [], warnings: [], notes: [] },
      () => accessory as never,
    );
    const push = (raw: number) => distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform, routing,
      [{ macAddress: MAC, lastData: { leak1: raw } }]);
    push(2);
    const svc = accessory.getService(MockServices.LeakSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.StatusFault)).toBe(1);
    push(1);
    expect(svc.readCharacteristic(MockCharacteristics.StatusFault)).toBe(0);
    expect(svc.readCharacteristic(MockCharacteristics.LeakDetected)).toBe(1);
  });
});

describe('§19.1 present-invalid state faults, and a restart preserves it (PR #67 review F3)', () => {
  const SERVICES = {
    leak: MockServices.LeakSensor,
    contact: MockServices.ContactSensor,
    occupancy: MockServices.OccupancySensor,
    smoke: MockServices.SmokeSensor,
    motion: MockServices.MotionSensor,
  } as const;

  it.each(['leak', 'contact', 'occupancy', 'smoke', 'motion'] as const)('%s: a valid reading then a present-invalid one raises StatusFault', kind => {
    const dp = `my_${kind}`;
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: dp, kind, measurement: 'boolean', name: `My ${kind}` }], { baseline: 1, adopted: 3 }));
    expect(map.errors).toEqual([]);
    const row = configured(map, dp);
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-${dp}`, displayName: `My ${kind}` });
    const routing = buildWrapperRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      { rows: [row], errors: [], warnings: [], notes: [] },
      () => accessory as never,
    );
    const push = (raw: unknown) => distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform, routing,
      [{ macAddress: MAC, lastData: { [dp]: raw } }]);
    const svc = accessory.getService(SERVICES[kind])!;
    const fault = () => svc.readCharacteristic(MockCharacteristics.StatusFault);
    push(1);
    expect(fault()).toBe(0);
    // Each present-but-invalid value raises the fault (never dropped).
    for (const invalid of [null, 'offline', {}, Number.NaN, Infinity]) {
      push(1); // reset to a clean state first
      expect(fault()).toBe(0);
      push(invalid);
      expect(fault(), `${kind} invalid ${String(invalid)}`).toBe(1);
    }
  });

  it('a retained leak fault survives a cached restart with no valid recovery reading', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'leak1', enabled: true }], { baseline: 1, adopted: 3 }));
    const row = configured(map, 'leak1');
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-leak1`, displayName: 'Leak 1' });
    const routing = buildWrapperRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      { rows: [row], errors: [], warnings: [], notes: [] },
      () => accessory as never,
    );
    distributeViaRouting(platform as unknown as AmbientWeatherSensorsPlatform, routing,
      [{ macAddress: MAC, lastData: { leak1: 2 } }]);
    const leak = accessory.getService(MockServices.LeakSensor)!;
    expect(leak.readCharacteristic(MockCharacteristics.StatusFault)).toBe(1);
    // Re-construct the wrapper on the SAME accessory (a restart) with
    // no valid cached reading: the fault must NOT be cleared.
    instantiateWrapper(platform as unknown as AmbientWeatherSensorsPlatform, accessory as never, row);
    expect(leak.readCharacteristic(MockCharacteristics.StatusFault)).toBe(1);
  });
});

describe('§19.3 CO is deferred past P3 (native co|co mapping unavailable)', () => {
  it('an assigned co row fails no-wrapper even at adopted 3 (kind reserved, PR #67 review F2)', () => {
    const at3 = buildEffectiveSensorMap(input(
      [{ dataPoint: 'my_co', kind: 'co', measurement: 'co', sourceUnit: 'ppm', name: 'My CO' }],
      { baseline: 1, adopted: 3 }));
    expect(at3.errors.map(e => e.code)).toContain('no-wrapper');
    expect(at3.rows.filter(r => r.dataPoint === 'my_co' && r.kind !== 'unrecognized')).toHaveLength(0);
  });
});

describe('§19.1 realtime forwards boolean readings the same as polling (PR #67 review F4)', () => {
  it('a RealtimeSource true/false event reaches the state wrapper (parity with the poll path)', () => {
    const dp = 'my_leak';
    const row = configured(buildEffectiveSensorMap(input(
      [{ dataPoint: dp, kind: 'leak', measurement: 'boolean', name: 'My Leak' }],
      { baseline: 1, adopted: 3 })), dp);
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-${dp}`, displayName: 'My Leak' });
    const routing = buildWrapperRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      { rows: [row], errors: [], warnings: [], notes: [] },
      () => accessory as never,
    );
    const push = (raw: unknown) => distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform, routing,
      [{ macAddress: MAC, lastData: { [dp]: raw } }]);
    const leak = accessory.getService(MockServices.LeakSensor)!;

    let updateCalls = 0;
    const source = new RealtimeSource({
      apiKey: 'k', applicationKey: 'a', log: { info() {}, debug() {}, warn() {}, error() {} } as never,
      catalogAdopted: 3,
      onUpdates(updates) { updateCalls++; for (const u of updates) push(u.value); },
    });
    // A boolean true must produce an update (pre-fix it was filtered
    // out at the transport, zero callbacks, HomeKit left clear).
    (source as unknown as { handleDevicePayload(d: Record<string, unknown>): void })
      .handleDevicePayload({ macAddress: MAC, [dp]: true });
    expect(updateCalls).toBe(1);
    expect(leak.readCharacteristic(MockCharacteristics.LeakDetected)).toBe(1);
    (source as unknown as { handleDevicePayload(d: Record<string, unknown>): void })
      .handleDevicePayload({ macAddress: MAC, [dp]: false });
    expect(leak.readCharacteristic(MockCharacteristics.LeakDetected)).toBe(0);
  });
});

describe('§19.6 adoption-gated battery polarity', () => {
  const data = { batt_lightning: 0, batleak1: 0, battout: 0, batt_co2: 1 };

  it('names exactly the vendor-declared inverted fields', () => {
    expect([...VENDOR_INVERTED_BATTERY_FIELDS].sort()).toEqual([
      'batleak1', 'batleak2', 'batleak3', 'batleak4', 'batt_lightning',
    ]);
  });

  it.each([1, 2])('adopted %d keeps the historical uniform decode (spurious lightning low preserved)', (adopted) => {
    expect(readBatteryLow(data, 'batt_lightning', adopted)).toBe(true);
    expect(readBatteryLow(data, 'batleak1', adopted)).toBe(true);
    expect(readBatteryLow(data, 'battout', adopted)).toBe(true);
  });

  it('adopted 3 decodes the inverted fields vendor-correct and leaves standard fields alone', () => {
    // Payload 0 on the lightning detector = OK per the vendor (the
    // README observation: healthy device, dashboard OK).
    expect(readBatteryLow(data, 'batt_lightning', 3)).toBe(false);
    expect(readBatteryLow({ batt_lightning: 1 }, 'batt_lightning', 3)).toBe(true);
    expect(readBatteryLow(data, 'batleak1', 3)).toBe(false);
    // Standard convention unchanged: 0 = low.
    expect(readBatteryLow(data, 'battout', 3)).toBe(true);
    expect(readBatteryLow(data, 'batt_co2', 3)).toBe(false);
  });

  it('the default (no stamp) is the historical decode — bare callers keep legacy behavior', () => {
    expect(readBatteryLow(data, 'batt_lightning')).toBe(true);
  });
});

describe('§19.5 catalog-3 exposure arithmetic and preservation', () => {
  it('catalog-3 definitions are invisible below adopted 3 (including at adopted 2)', () => {
    for (const dp of ['soilhum1', 'leak1', 'aqi_pm25_aqin', 'etos']) {
      expect(staticDefaultRowFor(dp), dp).toBeUndefined();
      expect(catalogRowFor(dp, 1), dp).toBeUndefined();
      expect(catalogRowFor(dp, 2), dp).toBeUndefined();
      expect(catalogRowFor(dp, 3), dp).toBeDefined();
    }
    const map2 = buildEffectiveSensorMap(input([], { baseline: 1, adopted: 2 }));
    expect(map2.rows.find(r => r.dataPoint === 'leak1')).toBeUndefined();
  });

  it('adopted catalog-3 definitions arrive DISABLED from every baseline, including a fresh catalog-3 install', () => {
    for (const baseline of [1, 2, 3]) {
      const map = buildEffectiveSensorMap(input([], { baseline, adopted: 3 }));
      for (const dp of ['soilhum1', 'leak1', 'aqi_pm25_aqin', 'etos', 'leafwetness1', 'soiltens1']) {
        expect(configured(map, dp).enabled, `${dp} at baseline ${baseline}`).toBe(false);
      }
    }
  });

  it('an enabled catalog-3 battery probe owns its battery field through the claims adjudication', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'soilhum1', enabled: true }, { dataPoint: 'leak1', enabled: true }],
      { baseline: 1, adopted: 3 }));
    expect(configured(map, 'soilhum1').hasBatterySubService).toBe(true);
    expect(configured(map, 'soilhum1').batteryField).toBe('battsm1');
    expect(configured(map, 'leak1').hasBatterySubService).toBe(true);
    expect(configured(map, 'leak1').batteryField).toBe('batleak1');
  });

  it('an authored custom claimant outranks the catalog default for the same battery field', () => {
    const map = buildEffectiveSensorMap(input([
      { dataPoint: 'soilhum1', enabled: true },
      {
        dataPoint: 'my_probe', kind: 'temperature', measurement: 'temperature',
        sourceUnit: 'celsius', name: 'My Probe', batteryField: 'battsm1',
      },
    ], { baseline: 1, adopted: 3 }));
    expect(configured(map, 'my_probe').hasBatterySubService).toBe(true);
    expect(configured(map, 'soilhum1').hasBatterySubService).toBe(false);
    expect(map.notes.map(n => n.code)).toContain('duplicate-battery-owner');
  });

  it('AP-1 at catalog 3: an explicit assignment on a catalog-3 dataPoint resolves identically across adoption', () => {
    const assignment: SensorMapOverride = {
      dataPoint: 'soilhum1', stationMac: MAC,
      kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent',
      name: 'My Odd Soil Row',
    };
    const before = buildEffectiveSensorMap(input([assignment], { baseline: 1, adopted: 2 }));
    const after = buildEffectiveSensorMap(input([assignment], { baseline: 1, adopted: 3 }));
    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(configured(after, 'soilhum1')).toEqual(configured(before, 'soilhum1'));
    expect(configured(after, 'soilhum1').kind).toBe('humidity');
  });

  it('a dormant authored leak assignment stays no-wrapper below adopted 3 and resolves at 3', () => {
    const dormant: SensorMapOverride = {
      dataPoint: 'my_leak', kind: 'leak', measurement: 'boolean', name: 'My Leak',
    };
    const below = buildEffectiveSensorMap(input([dormant], { baseline: 1, adopted: 2 }));
    expect(below.errors.map(e => e.code)).toContain('no-wrapper');
    expect(below.rows.filter(r => r.dataPoint === 'my_leak' && r.kind !== 'unrecognized')).toHaveLength(0);
    const at3 = buildEffectiveSensorMap(input([dormant], { baseline: 1, adopted: 3 }));
    expect(at3.errors).toEqual([]);
    expect(configured(at3, 'my_leak').kind).toBe('leak');
  });

  it('the fallback still does not recognize any catalog-3 key (they were gaps, not compat)', () => {
    for (const dp of ['soilhum1', 'leafwetness1', 'soiltens1', 'etos', 'leak1', 'aqi_pm25_aqin', 'gdd']) {
      expect(defaultRowFor(dp), dp).toBeUndefined();
    }
  });

  it('gdd deliberately stays a gap at catalog 3', () => {
    expect(catalogRowFor('gdd', 3)).toBeUndefined();
    expect(CATALOG_V3_ROWS.find(r => r.dataPoint === 'gdd')).toBeUndefined();
  });
});

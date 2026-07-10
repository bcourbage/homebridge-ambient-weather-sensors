import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { DEFAULT_SENSOR_MAP } from '../../../src/sensorMap/defaultMap';
import type {
  DiscoveryStore,
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../../../src/sensorMap/types';

const MAC1 = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';

const STATIONS: StationInventory = [
  { macAddress: MAC1, name: 'Home' },
  { macAddress: MAC2, name: 'Cabin' },
];

function emptyDiscovery(): DiscoveryStore {
  return { schemaVersion: 1, entries: [] };
}
function emptyUiState(): UiStateStore {
  return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}

function baseInput() {
  return {
    userOverrides: [] as SensorMapOverride[],
    discovery: emptyDiscovery(),
    uiState: emptyUiState(),
    stations: STATIONS,
    configMode: 'v2' as const,
  };
}

describe('buildEffectiveSensorMap — safe mode', () => {
  it('returns zero rows in safe mode regardless of input', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      configMode: 'safe-mode',
      userOverrides: [{ dataPoint: 'tempf', name: 'Custom' }],
    });
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('buildEffectiveSensorMap — default expansion', () => {
  it('emits one row per (station, defaultDataPoint) pair', () => {
    const result = buildEffectiveSensorMap(baseInput());
    expect(result.rows.length).toBe(DEFAULT_SENSOR_MAP.length * STATIONS.length);
  });

  it('uppercases stationMac consistently on emitted rows', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      stations: [{ macAddress: 'aa:bb:cc:dd:ee:01', name: 'Home' }],
    });
    for (const row of result.rows) {
      expect(row.stationMac).toBe('AA:BB:CC:DD:EE:01');
    }
  });

  it('preserves default names when no override applies', () => {
    const result = buildEffectiveSensorMap(baseInput());
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    expect(tempf?.kind === 'unrecognized' ? null : (tempf as { name: string }).name).toBe('Outdoor Temperature');
  });

  it('produces a valid structural signature for every configured row', () => {
    const result = buildEffectiveSensorMap(baseInput());
    for (const row of result.rows) {
      if (row.kind === 'unrecognized') continue;
      expect(row.structuralSignature).toMatch(/\|measurement:.+\|battery:[01]\|wrapper:.+:v\d+$/);
    }
  });
});

describe('buildEffectiveSensorMap — override precedence', () => {
  it('applies a global name override to every station', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', name: 'Outside' },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const tempfRows = result.rows.filter(r => r.dataPoint === 'tempf');
    expect(tempfRows).toHaveLength(2);
    for (const row of tempfRows) {
      if (row.kind !== 'unrecognized') {
        expect(row.name).toBe('Outside');
      }
    }
  });

  it('station-specific override wins over global on same field', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', name: 'Outside' },
      { dataPoint: 'tempf', stationMac: MAC2, name: 'Deck' },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const home = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const cabin = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC2);
    if (home?.kind !== 'unrecognized') expect((home as { name: string }).name).toBe('Outside');
    if (cabin?.kind !== 'unrecognized') expect((cabin as { name: string }).name).toBe('Deck');
  });

  it('later-in-array duplicate overrides field-wise merge', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', name: 'First' },
      { dataPoint: 'tempf', threshold: 80 },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const row = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (row && row.kind !== 'unrecognized') {
      expect(row.name).toBe('First');
      // threshold gets merged in but threshold on temperature is warn-and-ignore
      // so it's not actually stored on the row (temperature kind, not motion).
    }
  });

  it('unknown-field override cannot invert measurement', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', kind: 'humidity' },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/not compatible/);
  });

  it('enabled: false does emit the row (accessory-registration decision happens later)', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', enabled: false },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const rows = result.rows.filter(r => r.dataPoint === 'tempf');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      if (r.kind !== 'unrecognized') expect(r.enabled).toBe(false);
    }
  });
});

describe('buildEffectiveSensorMap — battery attachment', () => {
  it('canonical rows have hasBatterySubService=true; non-canonical false', () => {
    const result = buildEffectiveSensorMap(baseInput());
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const humidity = result.rows.find(r => r.dataPoint === 'humidity' && r.stationMac === MAC1);
    if (tempf?.kind !== 'unrecognized') expect(tempf?.hasBatterySubService).toBe(true);
    if (humidity?.kind !== 'unrecognized') expect(humidity?.hasBatterySubService).toBe(false);
  });

  it('override batteryField: null suppresses battery attachment', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', batteryField: null },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (tempf?.kind !== 'unrecognized') {
      expect(tempf?.batteryField).toBeNull();
      expect(tempf?.hasBatterySubService).toBe(false);
    }
  });

  it('battery flag flips the structural signature 0/1 segment', () => {
    const rWith = buildEffectiveSensorMap(baseInput());
    const rWithout = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'tempf', batteryField: null }],
    });
    const withRow = rWith.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const withoutRow = rWithout.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (withRow?.kind !== 'unrecognized' && withoutRow?.kind !== 'unrecognized') {
      expect(withRow!.structuralSignature).toContain('|battery:1|');
      expect(withoutRow!.structuralSignature).toContain('|battery:0|');
    }
  });
});

describe('buildEffectiveSensorMap — unrecognized (auto-discovery)', () => {
  it('emits an unrecognized row for a discovered field with no default', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'foo_bar_new',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
    });
    const row = result.rows.find(r => r.dataPoint === 'foo_bar_new');
    expect(row).toBeDefined();
    expect(row!.kind).toBe('unrecognized');
    if (row!.kind === 'unrecognized') {
      expect(row.firstSeen).toBe('2026-07-01T00:00:00Z');
      expect(row.lastSeen).toBe('2026-07-09T21:00:00Z');
    }
  });

  it('forgottenFields entry suppresses the unrecognized row', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'foo_bar_new',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
      uiState: {
        schemaVersion: 1,
        dismissedNoticeIds: [],
        forgottenFields: [{
          stationMac: MAC1,
          dataPoint: 'foo_bar_new',
          forgottenAt: '2026-07-09T20:00:00Z',
        }],
      },
    });
    expect(result.rows.find(r => r.dataPoint === 'foo_bar_new')).toBeUndefined();
  });

  it('a custom (kind + measurement) override upgrades an unrecognized field to a configured row', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'custom_moisture',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
      userOverrides: [{
        dataPoint: 'custom_moisture',
        kind: 'humidity',
        measurement: 'humidity',
        sourceUnit: 'percent',
        name: 'Soil Moisture',
      }],
    });
    const row = result.rows.find(r => r.dataPoint === 'custom_moisture');
    expect(row?.kind).toBe('humidity');
    if (row && row.kind !== 'unrecognized') {
      expect(row.name).toBe('Soil Moisture');
    }
  });
});

describe('buildEffectiveSensorMap — idempotency', () => {
  it('running twice with the same input produces byte-equal rows arrays', () => {
    const input = {
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 'Deck' },
        { dataPoint: 'humidity', stationMac: MAC2, displayUnit: 'percent' as const },
      ],
    };
    const r1 = buildEffectiveSensorMap(input);
    const r2 = buildEffectiveSensorMap(input);
    expect(JSON.stringify(r1.rows)).toBe(JSON.stringify(r2.rows));
  });
});

describe('buildEffectiveSensorMap — error accumulation', () => {
  it('records row-level errors without dropping other rows', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', stationMac: 'Cabin' },       // bad MAC
        { dataPoint: 'tempf', name: 'Outside' },            // valid
      ],
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/is not a MAC address/);
    // Valid override still applied.
    const home = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (home?.kind !== 'unrecognized') expect(home?.name).toBe('Outside');
  });
});

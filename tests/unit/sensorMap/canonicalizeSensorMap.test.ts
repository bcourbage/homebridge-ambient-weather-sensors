/**
 * Canonical serializer (§11.3 / §17.4): minimal diff vs the v2
 * baseline, station collapse, fixed ordering, and STRUCTURAL
 * idempotency — canonicalize(load(canonicalize(x))) must be
 * byte-identical, across a fixture battery (§17.4's test).
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeSensorMap } from '../../../src/sensorMap/canonicalizeSensorMap';
import type {
  DiscoveryStore,
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../../../src/sensorMap/types';

const MAC1 = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';
const ONE: StationInventory = [{ macAddress: MAC1, name: 'Home' }];
const TWO: StationInventory = [
  { macAddress: MAC1, name: 'Home' },
  { macAddress: MAC2, name: 'Cabin' },
];

function discovery(): DiscoveryStore {
  return { schemaVersion: 1, entries: [] };
}
function uiState(): UiStateStore {
  return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}
function canon(overrides: SensorMapOverride[], stations: StationInventory = ONE): SensorMapOverride[] {
  return canonicalizeSensorMap({ overrides, stations, discovery: discovery(), uiState: uiState() });
}

describe('minimal diff vs the v2 baseline', () => {
  it('an empty proposal serializes to an empty sensorMap', () => {
    expect(canon([])).toEqual([]);
  });

  it('a default-valued override field is dropped (no-op diff)', () => {
    // tempf's default name IS 'Outdoor Temperature' — restating it is
    // not a difference from baseline.
    expect(canon([{ dataPoint: 'tempf', name: 'Outdoor Temperature' }])).toEqual([]);
  });

  it('only the changed field survives', () => {
    expect(canon([{ dataPoint: 'tempf', name: 'Patio', enabled: true }]))
      .toEqual([{ dataPoint: 'tempf', name: 'Patio' }]);
  });

  it('batteryField: null suppression is preserved (meaningful null)', () => {
    const out = canon([{ dataPoint: 'tempf', batteryField: null }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveProperty('batteryField', null);
  });

  it('a custom row always declares identity (kind, measurement, sourceUnit) plus only its non-default extras', () => {
    const out = canon([{
      dataPoint: 'barn_baro', kind: 'motion', measurement: 'pressure',
      sourceUnit: 'mmHg', threshold: 765,
      // triggerEnabled: true is the derived default — must vanish.
      triggerEnabled: true,
    }]);
    expect(out).toEqual([{
      dataPoint: 'barn_baro', kind: 'motion', measurement: 'pressure',
      sourceUnit: 'mmHg', threshold: 765,
    }]);
  });
});

describe('station collapse (§11.3 rules 2–3)', () => {
  it('identical per-station values across ALL stations collapse to one global entry', () => {
    const out = canon([
      { dataPoint: 'tempf', stationMac: MAC1, name: 'Patio' },
      { dataPoint: 'tempf', stationMac: MAC2, name: 'Patio' },
    ], TWO);
    expect(out).toEqual([{ dataPoint: 'tempf', name: 'Patio' }]);
  });

  it('divergent stations keep per-station entries, only for non-empty diffs', () => {
    const out = canon([
      { dataPoint: 'tempf', stationMac: MAC1, name: 'Patio' },
      { dataPoint: 'tempf', stationMac: MAC2, name: 'Deck' },
    ], TWO);
    expect(out).toEqual([
      { dataPoint: 'tempf', stationMac: MAC1, name: 'Patio' },
      { dataPoint: 'tempf', stationMac: MAC2, name: 'Deck' },
    ]);
  });

  it('a single-station diff on a two-station inventory stays station-scoped', () => {
    const out = canon([{ dataPoint: 'tempf', stationMac: MAC2, name: 'Deck' }], TWO);
    expect(out).toEqual([{ dataPoint: 'tempf', stationMac: MAC2, name: 'Deck' }]);
  });
});

describe('ordering (§17.4 rules 3–4)', () => {
  it('entries sort by dataPoint, global before station, MACs ascending', () => {
    const out = canon([
      { dataPoint: 'windspeedmph', stationMac: MAC2, threshold: 30 },
      { dataPoint: 'humidity', name: 'RH' },
      { dataPoint: 'windspeedmph', stationMac: MAC1, threshold: 20 },
      { dataPoint: 'tempf', name: 'Patio' },
    ], TWO);
    expect(out.map(o => `${o.dataPoint}|${o.stationMac ?? 'GLOBAL'}`)).toEqual([
      'humidity|GLOBAL',
      'tempf|GLOBAL',
      `windspeedmph|${MAC1}`,
      `windspeedmph|${MAC2}`,
    ]);
  });

  it('fields appear in the fixed §17.4 order', () => {
    const out = canon([{
      dataPoint: 'barn_baro', kind: 'motion', measurement: 'pressure',
      sourceUnit: 'mmHg', threshold: 765, name: 'Barn Baro', enabled: false,
    }]);
    expect(Object.keys(out[0])).toEqual(
      ['dataPoint', 'enabled', 'kind', 'measurement', 'name', 'sourceUnit', 'threshold'],
    );
  });
});

describe('idempotency + byte stability (§11.3 / §17.4 rule 5)', () => {
  const FIXTURES: Array<{ name: string; overrides: SensorMapOverride[]; stations: StationInventory }> = [
    { name: 'empty', overrides: [], stations: ONE },
    { name: 'rename', overrides: [{ dataPoint: 'tempf', name: 'Patio' }], stations: ONE },
    { name: 'disable', overrides: [{ dataPoint: 'humidity', enabled: false }], stations: ONE },
    { name: 'battery-suppress', overrides: [{ dataPoint: 'tempf', batteryField: null }], stations: ONE },
    { name: 'display-unit', overrides: [{ dataPoint: 'baromrelin', displayUnit: 'mmHg' }], stations: ONE },
    { name: 'threshold+direction', overrides: [{ dataPoint: 'windspeedmph', threshold: 30, triggerDirection: 'below' }], stations: ONE },
    {
      name: 'custom-numeric',
      overrides: [{ dataPoint: 'barn_wind', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'fps', threshold: 20, name: 'Barn Wind' }],
      stations: ONE,
    },
    {
      name: 'custom-native',
      overrides: [{ dataPoint: 'barn_light', kind: 'light', measurement: 'illuminance', sourceUnit: 'fc' }],
      stations: ONE,
    },
    {
      name: 'multi-station-collapse',
      overrides: [
        { dataPoint: 'tempf', stationMac: MAC1, name: 'Patio' },
        { dataPoint: 'tempf', stationMac: MAC2, name: 'Patio' },
        { dataPoint: 'uv', stationMac: MAC2, threshold: 9 },
      ],
      stations: TWO,
    },
    {
      name: 'kitchen-sink',
      overrides: [
        { dataPoint: 'tempf', name: 'Patio', batteryField: null },
        { dataPoint: 'windspeedmph', displayUnit: 'kph', threshold: 40 },
        { dataPoint: 'hourlyrainin', embedName: true },
        { dataPoint: 'barn_baro', kind: 'motion', measurement: 'pressure', sourceUnit: 'mmHg', threshold: 765 },
        { dataPoint: 'lightning_day', enabled: false },
      ],
      stations: TWO,
    },
  ];

  it.each(FIXTURES)('$name: canonicalize(load(canonicalize(x))) is byte-identical', ({ overrides, stations }) => {
    const first = canonicalizeSensorMap({ overrides, stations, discovery: discovery(), uiState: uiState() });
    const second = canonicalizeSensorMap({ overrides: first, stations, discovery: discovery(), uiState: uiState() });
    expect(JSON.stringify(second, null, 2)).toBe(JSON.stringify(first, null, 2));
  });

  it('repeated calls with the same input are deterministic', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'windspeedmph', threshold: 30 },
      { dataPoint: 'tempf', name: 'Patio' },
    ];
    const a = canon(overrides);
    const b = canon(overrides);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

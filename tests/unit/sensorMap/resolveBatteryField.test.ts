/**
 * Shared row-aware battery-field resolver (finding-#4 Stage 4, final
 * commit). The discriminating claims:
 *
 * 1. NO effective map (legacy flag-off callers) → exactly the v1.6.0
 *    static `batteryFieldForSensor` lookup.
 * 2. WITH a map, the adjudicated row is the SOLE authority: owners
 *    resolve their field (including novel custom fields), while
 *    collision losers, suppressed owners (`batteryField: null`), and
 *    unmapped dataPoints resolve to null — never the legacy fallback,
 *    which would resurrect exactly the field the map removed.
 */
import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { resolveBatteryField } from '../../../src/sensorMap/resolveBatteryField';
import type {
  DiscoveryStore,
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
function mapWith(userOverrides: SensorMapOverride[]) {
  return buildEffectiveSensorMap({
    userOverrides,
    discovery: emptyDiscovery(),
    uiState: emptyUiState(),
    stations: STATIONS,
    configMode: 'v2' as const,
  });
}

describe('resolveBatteryField — legacy fallback (no effective map)', () => {
  it('delegates to the v1.6.0 static lookup', () => {
    expect(resolveBatteryField(undefined, MAC, 'tempf')).toBe('battout');
    expect(resolveBatteryField(undefined, MAC, 'tempinf')).toBe('battin');
    expect(resolveBatteryField(undefined, MAC, 'humidity3')).toBe('batt3');
    expect(resolveBatteryField(undefined, MAC, 'co2')).toBe('batt_co2');
  });

  it('returns null (not undefined) for keys the static lookup does not know', () => {
    expect(resolveBatteryField(undefined, MAC, 'my_barn_wind')).toBeNull();
    expect(resolveBatteryField(undefined, MAC, 'pm25')).toBeNull();
  });
});

describe('resolveBatteryField — effective map is the sole authority', () => {
  it('resolves a default-map owner to its reserved field', () => {
    const map = mapWith([]);
    expect(resolveBatteryField(map, MAC, 'tempf')).toBe('battout');
  });

  it('resolves a custom row owning a NOVEL field to that field', () => {
    const map = mapWith([
      {
        dataPoint: 'my_barn',
        kind: 'temperature',
        measurement: 'temperature',
        sourceUnit: 'fahrenheit',
        batteryField: 'barn_batt',
      },
    ]);
    expect(resolveBatteryField(map, MAC, 'my_barn')).toBe('barn_batt');
  });

  it('a suppressed owner (batteryField: null) resolves to null — NOT the legacy battout fallback', () => {
    const map = mapWith([{ dataPoint: 'tempf', batteryField: null }]);
    expect(resolveBatteryField(map, MAC, 'tempf')).toBeNull();
  });

  it('a collision LOSER resolves to null even though its row states a batteryField', () => {
    const map = mapWith([
      // Earliest override wins 'shared_batt'; the later claimant loses.
      { dataPoint: 'custom_a', kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit', batteryField: 'shared_batt' },
      { dataPoint: 'custom_b', kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent', batteryField: 'shared_batt' },
    ]);
    expect(resolveBatteryField(map, MAC, 'custom_a')).toBe('shared_batt');
    expect(resolveBatteryField(map, MAC, 'custom_b')).toBeNull();
  });

  it('a non-canonical known row resolves to null, not its probe field (dedup preserved)', () => {
    const map = mapWith([]);
    // humidity shares battout with tempf, whose default row is the
    // canonical owner — humidity must NOT surface a second battery.
    expect(resolveBatteryField(map, MAC, 'humidity')).toBeNull();
  });

  it('a dataPoint absent from the map resolves to null — no legacy resurrection', () => {
    const map = mapWith([]);
    // DISCRIMINATING key: the static lookup KNOWS feelsLike7 (numbered
    // probe regex → 'batt7'), but the default map only generates
    // feelsLike channels 1..4 — so a fall-through to the legacy lookup
    // here would wrongly resurrect 'batt7'. A never-known custom key
    // could not tell the two implementations apart (both null).
    expect(resolveBatteryField(undefined, MAC, 'feelsLike7')).toBe('batt7');
    expect(resolveBatteryField(map, MAC, 'feelsLike7')).toBeNull();
    expect(resolveBatteryField(map, MAC, 'not_a_mapped_point')).toBeNull();
  });

  it('a station absent from the map resolves to null even for a statically-known dataPoint', () => {
    const map = mapWith([]);
    // tempf WOULD resolve to battout via the static lookup AND via any
    // mapped station's row — but this station has no rows in the map.
    expect(resolveBatteryField(map, 'FF:FF:FF:FF:FF:FF', 'tempf')).toBeNull();
  });

  it('station MAC lookup is case-insensitive', () => {
    const map = mapWith([]);
    expect(resolveBatteryField(map, MAC.toLowerCase(), 'tempf')).toBe('battout');
  });
});

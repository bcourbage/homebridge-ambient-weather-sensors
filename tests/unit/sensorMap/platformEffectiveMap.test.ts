import { describe, expect, it } from 'vitest';

import {
  buildPlatformEffectiveMap,
  selectUserOverrides,
} from '../../../src/sensorMap/platformEffectiveMap';
import { emptyDiscoveryStore } from '../../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../../src/sensorMap/persistence/uiStateStore';
import type { StationInventory } from '../../../src/sensorMap/types';

/**
 * finding-#4 Stage 4 — the PURE platform-level effective-map assembler.
 * It performs no I/O; these tests pin the override-source selection for
 * each config mode and that a known default row survives round-trip.
 */
describe('selectUserOverrides', () => {
  const stations: StationInventory = [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }];

  it('safe-mode selects no overrides', () => {
    expect(selectUserOverrides({ temperatureSensors: true }, 'safe-mode', stations)).toEqual([]);
  });

  it('v2 mode reads config.sensorMap as a raw array', () => {
    const rows = [{ dataPoint: 'tempf', enabled: false }];
    expect(selectUserOverrides({ sensorMap: rows }, 'v2', stations)).toBe(rows);
  });

  it('v2 mode treats a non-array sensorMap as empty (hand-edit guard)', () => {
    expect(selectUserOverrides({ sensorMap: 'oops' as unknown }, 'v2', stations)).toEqual([]);
    expect(selectUserOverrides({ sensorMap: undefined }, 'v2', stations)).toEqual([]);
  });

  it('legacy mode synthesises overrides from the compat layer', () => {
    // temperatureSensors OFF → compat emits an enabled:false override for
    // the temperature rows. Presence of any override proves the compat
    // path ran (vs. the empty v2/safe branches).
    const overrides = selectUserOverrides({ temperatureSensors: false }, 'legacy', stations) as Array<Record<string, unknown>>;
    expect(overrides.some(o => o.dataPoint === 'tempf' && o.enabled === false)).toBe(true);
  });
});

describe('buildPlatformEffectiveMap', () => {
  const stations: StationInventory = [{ macAddress: 'AA:BB:CC:DD:EE:01', name: 'Home' }];

  it('resolves an enabled known row in legacy mode with the category on', () => {
    const map = buildPlatformEffectiveMap({
      config: { temperatureSensors: true },
      configMode: 'legacy',
      stations,
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
    });
    const tempf = map.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === 'AA:BB:CC:DD:EE:01');
    expect(tempf).toBeDefined();
    expect(tempf!.enabled).toBe(true);
    expect(tempf!.kind).toBe('temperature');
  });

  it('safe-mode yields an empty map', () => {
    const map = buildPlatformEffectiveMap({
      config: { temperatureSensors: true },
      configMode: 'safe-mode',
      stations,
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
    });
    expect(map.rows).toEqual([]);
  });

  it('v2 mode rejects a custom dataPoint with no-wrapper while the table is empty', () => {
    const map = buildPlatformEffectiveMap({
      config: { sensorMap: [{ dataPoint: 'my_barn', kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit' }] },
      configMode: 'v2',
      stations,
      discovery: emptyDiscoveryStore(),
      uiState: emptyUiStateStore(),
    });
    expect(map.rows.some(r => r.dataPoint === 'my_barn')).toBe(false);
    expect(map.errors.some(e => e.code === 'no-wrapper' && e.dataPoint === 'my_barn')).toBe(true);
  });
});

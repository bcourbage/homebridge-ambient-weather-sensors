import { describe, expect, it } from 'vitest';

import { DEFAULT_SENSOR_MAP } from '../../../src/sensorMap/defaultMap';
import {
  composeDisplayName,
  composeRowDisplayName,
  HAP_NAME_MAX,
} from '../../../src/sensorMap/displayName';

/**
 * finding-#4 Stage 4, review P1-1 — row-driven display-name composition.
 *
 * The load-bearing invariant: for every default-map row (no rename
 * override), the row-driven recipe produces EXACTLY the v1.7 recipe's
 * output, in both single- and multi-station layouts. Otherwise flag-on
 * triggers a rename storm across every cached accessory on upgrade.
 */
describe('composeRowDisplayName', () => {
  const named = { macAddress: 'AA:BB:CC:DD:EE:01', name: 'Backyard' };
  const unnamed = { macAddress: 'AA:BB:CC:DD:EE:01', name: '' };

  it('parity: every DEFAULT_SENSOR_MAP row name matches the v1.7 friendly-name recipe', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      for (const isMulti of [false, true]) {
        for (const station of [named, unnamed]) {
          expect(
            composeRowDisplayName(station, row.name, isMulti),
            `${row.dataPoint} (multi=${isMulti}, station=${station.name || 'unnamed'})`,
          ).toBe(composeDisplayName(station, row.dataPoint, isMulti));
        }
      }
    }
  });

  it('single-station: bare renamed label, hapClean applied', () => {
    expect(composeRowDisplayName(named, 'Patio', false)).toBe('Patio');
    expect(composeRowDisplayName(named, 'Patio (South)', false)).toBe('Patio South');
  });

  it('multi-station: station prefix + renamed label', () => {
    expect(composeRowDisplayName(named, 'Patio', true)).toBe('Backyard Patio');
  });

  it('multi-station MAC fallback when the station is unnamed', () => {
    expect(composeRowDisplayName(unnamed, 'Patio', true)).toBe('AABBCCDDEE01 Patio');
  });

  it('truncates from the right at the HAP 64-char limit', () => {
    const long = 'X'.repeat(100);
    const out = composeRowDisplayName(named, long, true);
    expect(out.length).toBeLessThanOrEqual(HAP_NAME_MAX);
    expect(out.startsWith('Backyard X')).toBe(true);
  });

  it('pressure parens distinction: display name sanitized, raw row name preserved for labels', () => {
    // The platform display name strips the parens (hapClean); the
    // extended-service label keeps them because wrappers read row.name
    // raw. Both derive from the SAME row.name — the P1-1 consistency fix.
    expect(composeRowDisplayName(named, 'Pressure (Station)', false)).toBe('Pressure Station');
  });
});

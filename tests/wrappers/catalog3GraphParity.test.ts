/**
 * HAP graph parity for the CATALOG-3 wrappers (sensor-map.md §19.7).
 *
 * The v1.7.0 golden stays frozen at its 25 ids; the §19 wrappers pin
 * against their own baseline, generated ONCE from the dist that first
 * shipped them (tests/helpers/genCatalog3Graph.mjs). From that moment
 * a diff here is a cache-migration event for the affected wrapper —
 * bump its schemaVersion with a migration plan, regenerate the
 * fixture, and update the provenance hash below consciously.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { instantiateWrapper } from '../../src/sensorMap/wrapperFactories';
import type { AmbientWeatherSensorsPlatform } from '../../src/platform';
import type { EffectiveSensorRow } from '../../src/sensorMap/types';
// eslint-disable-next-line
import { makeHapPlatform, makeHapAccessory, serializeHapGraph } from '../helpers/hapGraph.mjs';
// eslint-disable-next-line
import { catalog3Rows, seedFor } from '../helpers/genCatalog3Graph.mjs';
import golden from '../fixtures/graph/catalog3-v1.json';

const CATALOG3_IDS = [
  'leak', 'contact', 'occupancy', 'smoke', 'motion-boolean', 'co',
  'soil-moisture', 'leaf-wetness', 'soil-tension', 'evapotranspiration', 'aqi',
] as const;

describe('HAP graph parity vs the catalog-3 golden (§19.7)', () => {
  it('golden covers all 11 catalog-3 WrapperIds × 2 battery variants', () => {
    expect(Object.keys(golden).sort()).toEqual([...CATALOG3_IDS].sort());
    for (const id of CATALOG3_IDS) {
      expect((golden as Record<string, unknown>)[id]).toHaveProperty('0');
      expect((golden as Record<string, unknown>)[id]).toHaveProperty('1');
    }
  });

  const rows = catalog3Rows() as Record<string, EffectiveSensorRow>;
  const cases: Array<[string, 0 | 1]> = CATALOG3_IDS.flatMap(id => [[id, 0], [id, 1]] as Array<[string, 0 | 1]>);

  it.each(cases)('%s (battery=%d): ROW-DRIVEN build === catalog-3 golden', (wrapperId, battery) => {
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory({
      uniqueId: `MAC-${(rows[wrapperId] as { dataPoint: string }).dataPoint}`,
      displayName: 'Parity Sensor',
      value: seedFor(wrapperId),
      batteryLow: battery ? false : undefined,
    });
    instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      { ...(rows[wrapperId] as object), hasBatterySubService: battery === 1 } as EffectiveSensorRow,
    );
    expect(serializeHapGraph(accessory)).toEqual((golden as never)[wrapperId][battery]);
  });

  it('the catalog-3 golden fixture is the byte-exact file generated at first ship', () => {
    // Provenance tripwire (same pattern as the v1.7.0 golden):
    // regenerating from a LATER dist would make the parity cases above
    // tautological. Updating this hash requires a conscious
    // cache-migration decision for the affected wrapper(s).
    const bytes = readFileSync(new URL('../fixtures/graph/catalog3-v1.json', import.meta.url));
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(hash).toBe('ab31bbf7b1161efab24deed0100ece51495fbe2e10c69d6e4ff142db4c930a22');
  });
});

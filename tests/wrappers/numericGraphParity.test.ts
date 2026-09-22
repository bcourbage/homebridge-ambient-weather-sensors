/**
 * HAP graph parity for the CATALOG-4 generic-numeric wrapper
 * (sensor-map.md §19.9).
 *
 * The catalog-3 golden stays frozen and untouched; the `numeric`
 * wrapper pins against its OWN baseline, generated once from the dist
 * that first shipped it (tests/helpers/genNumericGraph.mjs). From that
 * moment a diff here is a cache-migration event: bump the wrapper's
 * schemaVersion with a migration plan, regenerate the fixture, and
 * update the provenance hash below consciously.
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
import { numericRow, NUMERIC_SEED } from '../helpers/genNumericGraph.mjs';
import golden from '../fixtures/graph/numeric-v1.json';

const VALUE_NAME = 'Value';
const INTENSITY_NAME = 'Intensity';
const LAST_UPDATED_NAME = 'Last Updated';

describe('HAP graph parity vs the numeric golden (§19.9)', () => {
  it('golden covers the numeric WrapperId × 2 battery variants', () => {
    expect(Object.keys(golden)).toEqual(['numeric']);
    expect(golden.numeric).toHaveProperty('0');
    expect(golden.numeric).toHaveProperty('1');
  });

  const cases: Array<[0 | 1]> = [[0], [1]];
  it.each(cases)('numeric (battery=%d): ROW-DRIVEN build === numeric golden', battery => {
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory({
      uniqueId: `MAC-${numericRow().dataPoint}`,
      displayName: 'Parity Sensor',
      value: NUMERIC_SEED,
      batteryLow: battery ? false : undefined,
    });
    instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      { ...numericRow(), hasBatterySubService: battery === 1 } as unknown as EffectiveSensorRow,
    );
    expect(serializeHapGraph(accessory)).toEqual((golden as never).numeric[battery]);
  });

  it('exposes Value and Last Updated but NEVER Intensity (§19.9 / F5)', () => {
    const serialized = JSON.stringify(golden.numeric);
    expect(serialized).toContain(`"name":"${VALUE_NAME}"`);
    expect(serialized).toContain(`"name":"${LAST_UPDATED_NAME}"`);
    // No invented qualitative bucket for a raw number.
    expect(serialized).not.toContain(`"name":"${INTENSITY_NAME}"`);
  });

  it('the numeric golden fixture is the byte-exact file generated at first ship', () => {
    // Provenance tripwire (same pattern as the catalog-3 golden):
    // regenerating from a LATER dist would make the parity cases above
    // tautological. Updating this hash requires a conscious
    // cache-migration decision for the numeric wrapper.
    const bytes = readFileSync(new URL('../fixtures/graph/numeric-v1.json', import.meta.url));
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(hash).toBe('6f61da4fab60233f13f77cd19d8ab2f280dc32cd44fcb05c290f4e69d4e3480d');
  });
});

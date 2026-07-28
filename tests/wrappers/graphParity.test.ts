import { describe, expect, it } from 'vitest';

import { WRAPPER_SPEC, instantiateWrapper } from '../../src/sensorMap/wrapperFactories';
import { ALL_WRAPPERS } from '../../src/sensorMap/wrappers';
import { DEFAULT_SENSOR_MAP } from '../../src/sensorMap/defaultMap';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import type { DefaultSensorRow, EffectiveSensorRow, WrapperId } from '../../src/sensorMap/types';
// Real-HAP harness + serializer (shared with the golden generator).
// eslint-disable-next-line
import { makeHapPlatform, makeHapAccessory, serializeHapGraph, contextFor } from '../helpers/hapGraph.mjs';
import { makeNumericRow, makeTimestampRow } from '../helpers/effectiveRow';
import golden from '../fixtures/graph/v1.7.0.json';

/**
 * finding-#4 review (P1-C): the cache-migration gate.
 *
 * Golden fixtures were generated ONCE from the v1.7.0 tag's shipping
 * wrappers (`tests/helpers/genGraphFixtures.mjs`) using REAL
 * @homebridge/hap-nodejs objects, capturing the full behavior-affecting
 * graph: service subtype/primary/hidden/linked/optional sets and every
 * characteristic's full `CharacteristicProps` (format, perms, unit,
 * ranges, step) + seeded values. This test constructs HEAD's builds with
 * the SAME real-HAP harness and asserts they equal the v1.7.0 golden —
 * for EVERY structural variant (wrapperId × battery 0|1), and for BOTH
 * the legacy 2-arg build AND the row-driven build. That catches:
 *   - HEAD's LEGACY path drifting from v1.7.0 (a regression shared by
 *     both HEAD paths that a HEAD-legacy-vs-HEAD-row test would miss);
 *   - HEAD's ROW-DRIVEN path diverging from v1.7.0.
 *
 * A diff here is a HAP cache-migration event and requires a
 * structuralSignature migration plan, not a fixture regen.
 */

type Variant = 0 | 1;

function airQualityType(wrapperId: WrapperId): string | undefined {
  return wrapperId === 'air-quality-pm10' ? 'PM10'
    : wrapperId === 'air-quality-pm25' ? 'PM25' : undefined;
}

function representativeDefaultRow(wrapperId: WrapperId): DefaultSensorRow {
  const row = DEFAULT_SENSOR_MAP.find(r => r.wrapper.id === wrapperId);
  if (!row) throw new Error(`no DEFAULT_SENSOR_MAP row uses wrapper '${wrapperId}'`);
  return row;
}

/** Build a resolved row from a default row, toggling battery attachment. */
function rowFromDefault(dr: DefaultSensorRow, battery: Variant): EffectiveSensorRow {
  const common = {
    kind: dr.kind, dataPoint: dr.dataPoint, name: dr.name, wrapperId: dr.wrapper.id,
    threshold: dr.threshold, triggerDirection: dr.triggerDirection,
    hasBatterySubService: battery === 1, batteryField: dr.batteryField ?? 'battout',
  } as const;
  if (dr.measurement === 'timestamp') {
    return makeTimestampRow({ ...common });
  }
  return makeNumericRow({
    ...common,
    measurement: dr.measurement as Exclude<typeof dr.measurement, 'timestamp' | 'boolean'>,
    sourceUnit: dr.sourceUnit, displayUnit: dr.displayUnit,
  });
}

function legacyCtor(wrapperId: WrapperId): new (p: unknown, a: unknown) => unknown {
  const desc = ALL_WRAPPERS.find(w => w.id === wrapperId);
  if (!desc) throw new Error(`no descriptor for ${wrapperId}`);
  return desc.constructor as new (p: unknown, a: unknown) => unknown;
}

const wrapperIds = Object.keys(WRAPPER_SPEC) as WrapperId[];
const cases: Array<[WrapperId, Variant]> = wrapperIds.flatMap(id => [[id, 0], [id, 1]] as Array<[WrapperId, Variant]>);

describe('HAP graph parity vs the v1.7.0 golden (finding-#4 review P1-C)', () => {
  it('golden covers all 25 WrapperIds × 2 battery variants', () => {
    expect(Object.keys(golden)).toHaveLength(25);
    for (const id of wrapperIds) {
      expect(golden, `golden missing ${id}`).toHaveProperty(id);
      expect((golden as Record<string, unknown>)[id]).toHaveProperty('0');
      expect((golden as Record<string, unknown>)[id]).toHaveProperty('1');
    }
  });

  it.each(cases)('%s (battery=%d): LEGACY 2-arg build === v1.7.0 golden', (wrapperId, battery) => {
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory(contextFor(wrapperId, { battery: battery === 1, type: airQualityType(wrapperId) }));
    const Ctor = legacyCtor(wrapperId);
    new Ctor(platform as unknown as AmbientWeatherSensorsPlatform, accessory);
    expect(serializeHapGraph(accessory)).toEqual((golden as never)[wrapperId][battery]);
  });

  it.each(cases)('%s (battery=%d): ROW-DRIVEN build === v1.7.0 golden', (wrapperId, battery) => {
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory(contextFor(wrapperId, { battery: battery === 1, type: airQualityType(wrapperId) }));
    instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      rowFromDefault(representativeDefaultRow(wrapperId), battery),
    );
    expect(serializeHapGraph(accessory)).toEqual((golden as never)[wrapperId][battery]);
  });
});

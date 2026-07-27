import { describe, expect, it } from 'vitest';

import { WRAPPER_SPEC, instantiateWrapper } from '../../src/sensorMap/wrapperFactories';
import { ALL_WRAPPERS } from '../../src/sensorMap/wrappers';
import { DEFAULT_SENSOR_MAP } from '../../src/sensorMap/defaultMap';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import type {
  DefaultSensorRow,
  EffectiveSensorRow,
  WrapperId,
} from '../../src/sensorMap/types';
import { makeMockAccessory, makeMockPlatform } from '../helpers/mockHomebridge';
import { makeNumericRow, makeTimestampRow } from '../helpers/effectiveRow';

/**
 * finding-#4 review (P1-C): graph-parity gate. For EVERY one of the 25
 * WrapperIds, the row-driven build (the v2 path, via instantiateWrapper
 * with a resolved default row) must produce a HAP graph byte-identical
 * to the legacy 2-arg build (the shipping v1.7 path). This is the
 * cache-migration gate: a divergence would silently invalidate every
 * user's cached accessory.
 *
 * The serializer (MockPlatformAccessory.serviceShape) captures, per
 * service: uuid + displayName, and per characteristic: uuid, name,
 * setProps-recorded props, and the seeded value (with the volatile
 * "Last Updated" timestamp normalized). Class-level characteristic
 * metadata (format / perms / unit) is identical BY CONSTRUCTION — both
 * paths instantiate the exact same characteristic classes — so the
 * capturable differentiators are structure (which services /
 * characteristics attach), setProps overrides, and seeded values.
 */

const SEED = 1;   // benign value valid for every family's seed path

function representativeDefaultRow(wrapperId: WrapperId): DefaultSensorRow {
  const row = DEFAULT_SENSOR_MAP.find(r => r.wrapper.id === wrapperId);
  if (!row) {
    throw new Error(`no DEFAULT_SENSOR_MAP row uses wrapper '${wrapperId}' — cannot build a parity fixture`);
  }
  return row;
}

/** Build a resolved effective row from a default row, forcing battery attach. */
function rowFromDefault(dr: DefaultSensorRow): EffectiveSensorRow {
  const common = {
    kind: dr.kind, dataPoint: dr.dataPoint, name: dr.name,
    wrapperId: dr.wrapper.id,
    threshold: dr.threshold, triggerDirection: dr.triggerDirection,
    hasBatterySubService: true, batteryField: dr.batteryField ?? 'battout',
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

/** The legacy 2-arg constructor for a wrapperId (from the descriptor registry). */
function legacyCtor(wrapperId: WrapperId): new (p: unknown, a: unknown) => unknown {
  const desc = ALL_WRAPPERS.find(w => w.id === wrapperId);
  if (!desc) throw new Error(`no descriptor for ${wrapperId}`);
  return desc.constructor as new (p: unknown, a: unknown) => unknown;
}

describe('HAP graph parity — row-driven vs legacy build, ALL 25 WrapperIds', () => {
  const wrapperIds = Object.keys(WRAPPER_SPEC) as WrapperId[];

  it('covers all 25 WrapperIds', () => {
    expect(wrapperIds).toHaveLength(25);
  });

  it.each(wrapperIds)('%s: row-driven graph === legacy graph', (wrapperId) => {
    const dr = representativeDefaultRow(wrapperId);
    // Air-quality reads context.device.type in the legacy path; give the
    // legacy build the variant matching this wrapperId so both agree.
    const type = wrapperId === 'air-quality-pm10' ? 'PM10'
      : wrapperId === 'air-quality-pm25' ? 'PM25' : undefined;

    const ctx = { uniqueId: `MAC-${dr.dataPoint}`, displayName: 'Parity Sensor', value: SEED, batteryLow: false, type };

    const platform = makeMockPlatform();

    // Legacy 2-arg build (shipping v1.7 path).
    const legacyAcc = makeMockAccessory({ ...ctx });
    const Ctor = legacyCtor(wrapperId);
    new Ctor(platform as unknown as AmbientWeatherSensorsPlatform, legacyAcc as never);

    // Row-driven build (v2 path).
    const rowAcc = makeMockAccessory({ ...ctx });
    instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      rowAcc as never,
      rowFromDefault(dr),
    );

    expect(rowAcc.serviceShape()).toEqual(legacyAcc.serviceShape());
  });
});

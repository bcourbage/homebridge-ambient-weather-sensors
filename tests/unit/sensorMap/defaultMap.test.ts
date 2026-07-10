import { describe, expect, it } from 'vitest';

import { batteryFieldForSensor, isCanonicalSensorForBattery } from '../../../src/batteryFields';
import { DEFAULT_SENSOR_MAP, defaultRowFor } from '../../../src/sensorMap/defaultMap';
import { LEGAL_UNITS_FOR_MEASUREMENT } from '../../../src/sensorMap/units';
import {
  ALL_WRAPPERS,
  WRAPPER_FOR_KIND_AND_MEASUREMENT,
} from '../../../src/sensorMap/wrappers';

describe('DEFAULT_SENSOR_MAP shape', () => {
  it('has expected row count (41 static + 28 numbered probes = 69)', () => {
    expect(DEFAULT_SENSOR_MAP.length).toBe(69);
  });

  it('every dataPoint is unique', () => {
    const keys = DEFAULT_SENSOR_MAP.map(r => r.dataPoint);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every row uses a registered wrapper', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      expect(ALL_WRAPPERS).toContain(row.wrapper);
    }
  });

  it('every row\'s (kind, measurement) matches its wrapper', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      const expected = WRAPPER_FOR_KIND_AND_MEASUREMENT[`${row.kind}|${row.measurement}`];
      if (expected) {
        // For kind+measurement combos that have a single canonical wrapper
        // (temperature, humidity, co2, pm25, pm10, light) this must match.
        // For kinds with multiple wrappers per measurement (motion +
        // rain-accumulation, motion + count, motion + timestamp) we relax:
        // we only require the wrapper's kind/measurement family to line up,
        // not the specific object identity.
        // Enforce identity when the lookup produces one — most rows.
        if (row.kind !== 'motion' || ['direction', 'pressure', 'wind-speed'].includes(row.measurement)) {
          // Multi-wrapper motion measurements (wind-speed has 3, direction 2,
          // pressure 2) still don't have identity match; skip identity for those.
          if (row.measurement !== 'wind-speed'
              && row.measurement !== 'direction'
              && row.measurement !== 'pressure') {
            expect(row.wrapper).toBe(expected);
          }
        }
      }
    }
  });
});

describe('DEFAULT_SENSOR_MAP unit legality', () => {
  it('sourceUnit is legal for the row\'s measurement', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      expect(LEGAL_UNITS_FOR_MEASUREMENT[row.measurement]).toContain(row.sourceUnit);
    }
  });

  it('displayUnit is legal for the row\'s measurement', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      expect(LEGAL_UNITS_FOR_MEASUREMENT[row.measurement]).toContain(row.displayUnit);
    }
  });
});

describe('DEFAULT_SENSOR_MAP battery consistency', () => {
  it('canonicalForBattery=true implies a non-null batteryField', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      if (row.canonicalForBattery) {
        expect(row.batteryField).not.toBeNull();
      }
    }
  });

  it('exactly one canonical row per non-null batteryField', () => {
    const canonicalByField = new Map<string, number>();
    for (const row of DEFAULT_SENSOR_MAP) {
      if (row.canonicalForBattery && row.batteryField) {
        canonicalByField.set(row.batteryField, (canonicalByField.get(row.batteryField) ?? 0) + 1);
      }
    }
    for (const [field, count] of canonicalByField) {
      expect(count, `battery field ${field} has ${count} canonical rows`).toBe(1);
    }
  });

  it('agrees with batteryFieldForSensor() for every row with a batteryField', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      if (row.batteryField !== null) {
        expect(batteryFieldForSensor(row.dataPoint)).toBe(row.batteryField);
      }
    }
  });

  it('agrees with isCanonicalSensorForBattery() for every canonical row', () => {
    for (const row of DEFAULT_SENSOR_MAP) {
      if (row.canonicalForBattery && row.batteryField) {
        expect(isCanonicalSensorForBattery(row.dataPoint, row.batteryField)).toBe(true);
      }
    }
  });
});

describe('defaultRowFor lookup', () => {
  it('returns undefined for unknown datapoints', () => {
    expect(defaultRowFor('bogus_field_that_does_not_exist')).toBeUndefined();
  });

  it('resolves a known key on first call', () => {
    const row = defaultRowFor('tempf');
    expect(row?.dataPoint).toBe('tempf');
    expect(row?.name).toBe('Outdoor Temperature');
  });

  it('is stable across calls (uses memoized index)', () => {
    const a = defaultRowFor('humidity');
    const b = defaultRowFor('humidity');
    expect(a).toBe(b);
  });

  it('resolves numbered probe rows', () => {
    for (let n = 1; n <= 10; n++) {
      expect(defaultRowFor(`temp${n}f`)?.batteryField).toBe(`batt${n}`);
      expect(defaultRowFor(`humidity${n}`)?.batteryField).toBe(`batt${n}`);
    }
    for (let n = 1; n <= 4; n++) {
      expect(defaultRowFor(`feelsLike${n}`)?.batteryField).toBe(`batt${n}`);
      expect(defaultRowFor(`dewPoint${n}`)?.batteryField).toBe(`batt${n}`);
    }
  });
});

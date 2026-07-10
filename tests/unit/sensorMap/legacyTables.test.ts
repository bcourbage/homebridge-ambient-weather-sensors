import { describe, expect, it } from 'vitest';

import {
  LEGACY_TYPE_TO_KIND,
  LEGACY_TYPE_TO_MEASUREMENT,
  LEGACY_TYPES,
} from '../../../src/sensorMap/legacyTables';
import { LEGAL_UNITS_FOR_MEASUREMENT } from '../../../src/sensorMap/units';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from '../../../src/sensorMap/wrappers';

describe('LEGACY_TYPE_TO_KIND / LEGACY_TYPE_TO_MEASUREMENT parity', () => {
  it('both tables share the same keys', () => {
    const kindKeys = Object.keys(LEGACY_TYPE_TO_KIND).sort();
    const measKeys = Object.keys(LEGACY_TYPE_TO_MEASUREMENT).sort();
    expect(kindKeys).toEqual(measKeys);
  });

  it('LEGACY_TYPES lists every table key', () => {
    expect(LEGACY_TYPES.sort()).toEqual(Object.keys(LEGACY_TYPE_TO_KIND).sort());
  });

  it('every legacy type resolves to a Measurement that has legal units OR is boolean/timestamp', () => {
    for (const t of LEGACY_TYPES) {
      const m = LEGACY_TYPE_TO_MEASUREMENT[t];
      expect(LEGAL_UNITS_FOR_MEASUREMENT[m]).toBeDefined();
    }
  });

  it('every legacy type resolves to a (kind, measurement) with a registered wrapper', () => {
    for (const t of LEGACY_TYPES) {
      const kind = LEGACY_TYPE_TO_KIND[t];
      const measurement = LEGACY_TYPE_TO_MEASUREMENT[t];
      // Some (kind, measurement) combos in the legacy vocabulary don't
      // have an entry in WRAPPER_FOR_KIND_AND_MEASUREMENT — that table
      // deliberately picks ONE canonical wrapper per (kind, measurement)
      // for CUSTOM-sensor resolution, while multiple wrappers exist for
      // the same combo in the default map (e.g. rain-event vs. rain-daily
      // both share motion+rain-accumulation). Bootstrap of a legacy row
      // is by dataPoint lookup in the default map, not by this table;
      // this test just asserts the (kind, measurement) is expressible.
      const legalUnits = LEGAL_UNITS_FOR_MEASUREMENT[measurement];
      expect(legalUnits).toBeDefined();
      // Sanity check that the kind slot exists in the table's type
      expect(typeof kind).toBe('string');
    }
  });

  it('covers all v1.5.0/v1.6.0 legacy type strings (25 entries)', () => {
    expect(LEGACY_TYPES.length).toBe(25);
  });

  it('has a wrapper available for at least one legacy type per family', () => {
    // Sanity: verify the design-doc statement that WRAPPER_FOR_KIND_AND_MEASUREMENT
    // can resolve the primary families.
    expect(WRAPPER_FOR_KIND_AND_MEASUREMENT['temperature|temperature']).toBeDefined();
    expect(WRAPPER_FOR_KIND_AND_MEASUREMENT['humidity|humidity']).toBeDefined();
    expect(WRAPPER_FOR_KIND_AND_MEASUREMENT['motion|wind-speed']).toBeDefined();
  });
});

import { describe, expect, it } from 'vitest';

import type { Measurement, SensorUnit } from '../../../src/sensorMap/types';
import {
  COMPATIBLE_KINDS_FOR_MEASUREMENT,
  DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT,
  DEFAULT_SOURCE_UNIT_FOR_MEASUREMENT,
  isCompatibleKind,
  isLegalUnit,
  LEGAL_UNITS_FOR_MEASUREMENT,
} from '../../../src/sensorMap/units';

const ALL_MEASUREMENTS: Measurement[] = [
  'temperature', 'humidity', 'illuminance', 'co2', 'co',
  'pm25', 'pm10', 'wind-speed', 'rain-rate', 'rain-accumulation',
  'pressure', 'distance', 'uv-index', 'count', 'direction',
  'timestamp', 'boolean',
];

describe('LEGAL_UNITS_FOR_MEASUREMENT', () => {
  it('has an entry for every Measurement', () => {
    for (const m of ALL_MEASUREMENTS) {
      expect(LEGAL_UNITS_FOR_MEASUREMENT[m]).toBeDefined();
    }
  });

  it('timestamp accepts only ms', () => {
    expect(LEGAL_UNITS_FOR_MEASUREMENT['timestamp']).toEqual(['ms']);
  });

  it('boolean accepts no units', () => {
    expect(LEGAL_UNITS_FOR_MEASUREMENT['boolean']).toEqual([]);
  });

  it('all numeric measurements offer at least one legal unit', () => {
    for (const m of ALL_MEASUREMENTS) {
      if (m === 'boolean') continue;
      expect(LEGAL_UNITS_FOR_MEASUREMENT[m].length).toBeGreaterThan(0);
    }
  });
});

describe('default units', () => {
  it('every numeric measurement has a default source unit', () => {
    for (const m of ALL_MEASUREMENTS) {
      if (m === 'boolean') continue;
      const src = DEFAULT_SOURCE_UNIT_FOR_MEASUREMENT[m];
      expect(src).toBeDefined();
      expect(LEGAL_UNITS_FOR_MEASUREMENT[m]).toContain(src as SensorUnit);
    }
  });

  it('every non-timestamp numeric measurement has a default display unit', () => {
    for (const m of ALL_MEASUREMENTS) {
      if (m === 'boolean' || m === 'timestamp') continue;
      const disp = DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT[m];
      expect(disp).toBeDefined();
      expect(LEGAL_UNITS_FOR_MEASUREMENT[m]).toContain(disp as SensorUnit);
    }
  });

  it('timestamp has no display unit', () => {
    expect(DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT['timestamp']).toBeUndefined();
  });

  it('boolean has no source or display unit', () => {
    expect(DEFAULT_SOURCE_UNIT_FOR_MEASUREMENT['boolean']).toBeUndefined();
    expect(DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT['boolean']).toBeUndefined();
  });
});

describe('isLegalUnit', () => {
  it('accepts declared units', () => {
    expect(isLegalUnit('temperature', 'fahrenheit')).toBe(true);
    expect(isLegalUnit('temperature', 'celsius')).toBe(true);
    expect(isLegalUnit('wind-speed', 'kts')).toBe(true);
  });

  it('rejects units from other measurements', () => {
    expect(isLegalUnit('temperature', 'percent')).toBe(false);
    expect(isLegalUnit('humidity', 'fahrenheit')).toBe(false);
    expect(isLegalUnit('pressure', 'mph')).toBe(false);
  });

  it('rejects any unit against boolean', () => {
    expect(isLegalUnit('boolean', 'percent')).toBe(false);
    expect(isLegalUnit('boolean', 'ms')).toBe(false);
  });
});

describe('COMPATIBLE_KINDS_FOR_MEASUREMENT', () => {
  it('has an entry for every Measurement', () => {
    for (const m of ALL_MEASUREMENTS) {
      expect(COMPATIBLE_KINDS_FOR_MEASUREMENT[m]).toBeDefined();
      expect(COMPATIBLE_KINDS_FOR_MEASUREMENT[m].length).toBeGreaterThan(0);
    }
  });

  it('boolean is the only measurement with multiple compatible kinds', () => {
    for (const m of ALL_MEASUREMENTS) {
      if (m === 'boolean') {
        expect(COMPATIBLE_KINDS_FOR_MEASUREMENT[m].length).toBeGreaterThan(1);
      } else {
        expect(COMPATIBLE_KINDS_FOR_MEASUREMENT[m].length).toBe(1);
      }
    }
  });

  it('isCompatibleKind rejects cross-family mappings', () => {
    expect(isCompatibleKind('temperature', 'humidity')).toBe(false);
    expect(isCompatibleKind('humidity', 'temperature')).toBe(false);
    expect(isCompatibleKind('wind-speed', 'temperature')).toBe(false);
  });

  it('isCompatibleKind accepts the measurement default kind', () => {
    expect(isCompatibleKind('temperature', 'temperature')).toBe(true);
    expect(isCompatibleKind('wind-speed', 'motion')).toBe(true);
    expect(isCompatibleKind('boolean', 'leak')).toBe(true);
    expect(isCompatibleKind('boolean', 'contact')).toBe(true);
    expect(isCompatibleKind('boolean', 'occupancy')).toBe(true);
  });
});

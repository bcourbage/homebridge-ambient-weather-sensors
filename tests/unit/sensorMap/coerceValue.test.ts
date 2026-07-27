import { describe, expect, it } from 'vitest';

import { coerceValue } from '../../../src/sensorMap/coerceValue';
import { makeNumericRow, makeTimestampRow } from '../../helpers/effectiveRow';
import type { UnrecognizedRow } from '../../../src/sensorMap/types';

describe('coerceValue', () => {
  const numericRow = makeNumericRow({
    kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit',
  });
  const tsRow = makeTimestampRow({ kind: 'motion', wrapperId: 'last-rain' });

  describe('numeric measurements', () => {
    it('passes a finite number through', () => {
      expect(coerceValue(numericRow, 68)).toBe(68);
      expect(coerceValue(numericRow, 0)).toBe(0);
      expect(coerceValue(numericRow, -3.2)).toBe(-3.2);
    });

    it('drops non-numbers and non-finite values (setValue never gets a string)', () => {
      expect(coerceValue(numericRow, '68')).toBeUndefined();
      expect(coerceValue(numericRow, NaN)).toBeUndefined();
      expect(coerceValue(numericRow, Infinity)).toBeUndefined();
      expect(coerceValue(numericRow, null)).toBeUndefined();
      expect(coerceValue(numericRow, undefined)).toBeUndefined();
    });
  });

  describe('timestamp measurements', () => {
    it('parses a valid ISO-8601 string to finite ms (lastRain round-trip)', () => {
      const iso = '2026-04-21T22:19:00.000Z';
      expect(coerceValue(tsRow, iso)).toBe(Date.parse(iso));
      expect(Number.isFinite(coerceValue(tsRow, iso)!)).toBe(true);
    });

    it('passes a finite ms number through (lightning_time form)', () => {
      expect(coerceValue(tsRow, 1_700_000_000_000)).toBe(1_700_000_000_000);
    });

    it('drops a malformed ISO string without throwing', () => {
      expect(coerceValue(tsRow, 'not a date')).toBeUndefined();
      expect(coerceValue(tsRow, '')).toBeUndefined();
    });

    it('drops non-finite ms numbers', () => {
      expect(coerceValue(tsRow, NaN)).toBeUndefined();
    });
  });

  describe('boolean measurements', () => {
    const boolRow = makeNumericRow({
      // boolean rows are built via makeNumericRow-shaped override then
      // measurement forced; simplest to hand-cast the measurement here.
      kind: 'leak', measurement: 'temperature', sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit',
    });
    // Re-tag measurement to boolean for the coercer's dispatch.
    const asBool = { ...boolRow, measurement: 'boolean' } as unknown as typeof boolRow;

    it('maps AWN 0/1 to 0/1', () => {
      expect(coerceValue(asBool, 1)).toBe(1);
      expect(coerceValue(asBool, 0)).toBe(0);
      expect(coerceValue(asBool, 5)).toBe(1);
      expect(coerceValue(asBool, true)).toBe(1);
      expect(coerceValue(asBool, false)).toBe(0);
    });
  });

  it('returns undefined for an unrecognized row (no wrapper)', () => {
    const unrec: UnrecognizedRow = {
      kind: 'unrecognized', enabled: false, dataPoint: 'x', stationMac: 'MAC',
      firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z',
    };
    expect(coerceValue(unrec, 5)).toBeUndefined();
  });
});

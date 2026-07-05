import { describe, expect, it } from 'vitest';

import {
  convertDistance,
  convertPressure,
  convertRain,
  convertSpeed,
} from '../../../src/extendedSensors/unitConversions';

describe('convertSpeed (input: mph)', () => {
  it('mph → mph is identity', () => {
    expect(convertSpeed(0, 'mph')).toBe(0);
    expect(convertSpeed(15, 'mph')).toBe(15);
    expect(convertSpeed(100, 'mph')).toBe(100);
  });

  it('mph → kph uses 1.60934 factor', () => {
    expect(convertSpeed(10, 'kph')).toBeCloseTo(16.0934, 4);
    expect(convertSpeed(60, 'kph')).toBeCloseTo(96.5604, 4);
  });

  it('mph → m/s uses 0.44704 factor', () => {
    expect(convertSpeed(10, 'mps')).toBeCloseTo(4.4704, 4);
    expect(convertSpeed(100, 'mps')).toBeCloseTo(44.704, 4);
  });

  it('mph → knots uses 0.86898 factor', () => {
    expect(convertSpeed(10, 'kts')).toBeCloseTo(8.6898, 4);
    expect(convertSpeed(60, 'kts')).toBeCloseTo(52.1388, 4);
  });

  it('handles zero cleanly for every unit', () => {
    expect(convertSpeed(0, 'mph')).toBe(0);
    expect(convertSpeed(0, 'kph')).toBe(0);
    expect(convertSpeed(0, 'mps')).toBe(0);
    expect(convertSpeed(0, 'kts')).toBe(0);
  });

  it('handles negative inputs symmetrically (though rarely produced by AWN)', () => {
    expect(convertSpeed(-10, 'kph')).toBeCloseTo(-16.0934, 4);
  });
});

describe('convertRain (input: inches)', () => {
  it('inches → in (identity)', () => {
    expect(convertRain(0, 'in')).toBe(0);
    expect(convertRain(1, 'in')).toBe(1);
    expect(convertRain(0.5, 'in')).toBe(0.5);
  });

  it('inches → mm uses 25.4 factor', () => {
    expect(convertRain(0, 'mm')).toBe(0);
    expect(convertRain(1, 'mm')).toBeCloseTo(25.4, 4);
    expect(convertRain(0.1, 'mm')).toBeCloseTo(2.54, 4);
  });
});

describe('convertPressure (input: inHg)', () => {
  it('inHg → inHg (identity)', () => {
    expect(convertPressure(29.92, 'inHg')).toBe(29.92);
    expect(convertPressure(30.0, 'inHg')).toBe(30.0);
  });

  it('inHg → hPa uses 33.8639 factor', () => {
    expect(convertPressure(29.92, 'hPa')).toBeCloseTo(1013.24, 1);
    expect(convertPressure(30.0, 'hPa')).toBeCloseTo(1015.92, 1);
  });
});

describe('convertDistance (input: statute miles)', () => {
  it('miles → mi (identity)', () => {
    expect(convertDistance(0, 'mi')).toBe(0);
    expect(convertDistance(10, 'mi')).toBe(10);
  });

  it('miles → km uses 1.60934 factor', () => {
    expect(convertDistance(10, 'km')).toBeCloseTo(16.0934, 4);
  });

  it('miles → nautical miles uses 0.868976 factor', () => {
    expect(convertDistance(10, 'nm')).toBeCloseTo(8.68976, 4);
  });

  /**
   * REGRESSION TEST for v1.5.0-beta.23 crash — see CHANGELOG.md.
   *
   * The bug: LightningDistanceAccessory called super() before
   * setting this.distanceUnit. super() triggered a setValue that
   * called formatValue that called convertDistance(rawMi, undefined).
   * Because convertDistance was a switch with no default case, it
   * returned undefined implicitly, which crashed downstream on
   * `.toFixed()`. The fix was moving the seed-from-cache logic out
   * of the base constructor and into the platform layer.
   *
   * The convertDistance function itself was NOT changed. These
   * tests pin that current behavior: passing an undefined unit
   * returns undefined (not a number). If we ever change
   * convertDistance to add a default case (which would mask this
   * class of bug), these assertions will fail — reminder that the
   * class was the fix, not the function.
   */
  describe('regression: undefined unit handling (beta.23)', () => {
    it('returns undefined when target is undefined', () => {
      expect(convertDistance(10, undefined as never)).toBeUndefined();
    });
  });
});

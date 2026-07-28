import { describe, expect, it } from 'vitest';

import {
  CANONICAL_UNIT_FOR_MEASUREMENT,
  toCanonical,
  toDisplayUnit,
} from '../../../src/sensorMap/unitConversions';
import { fahrenheitToCelsius, solarWm2ToLux } from '../../../src/nativeConversions';
import {
  convertSpeed,
  convertRain,
  convertPressure,
  convertDistance,
} from '../../../src/extendedSensors/unitConversions';
import { LEGAL_UNITS_FOR_MEASUREMENT } from '../../../src/sensorMap/units';
import type { Measurement } from '../../../src/sensorMap/types';

describe('CANONICAL_UNIT_FOR_MEASUREMENT', () => {
  it('names a canonical unit for every measurement', () => {
    const measurements = Object.keys(LEGAL_UNITS_FOR_MEASUREMENT) as Measurement[];
    for (const m of measurements) {
      expect(CANONICAL_UNIT_FOR_MEASUREMENT[m], m).toBeTruthy();
    }
  });

  it('the canonical unit is a legal unit for its measurement (except unit-free families)', () => {
    for (const [m, canonical] of Object.entries(CANONICAL_UNIT_FOR_MEASUREMENT) as [Measurement, string][]) {
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[m];
      // boolean has no legal units; its placeholder canonical is inert.
      if (m === 'boolean') continue;
      expect(legal, m).toContain(canonical);
    }
  });
});

describe('toCanonical — identity (AWN-native source units)', () => {
  it('passes imperial/native units through unchanged (byte-identical to v1.6.0)', () => {
    expect(toCanonical('temperature', 'celsius', 20)).toBe(20);
    expect(toCanonical('humidity', 'percent', 55)).toBe(55);
    expect(toCanonical('illuminance', 'lux', 12000)).toBe(12000);
    expect(toCanonical('co2', 'ppm', 800)).toBe(800);
    expect(toCanonical('pm25', 'ugm3', 12.3)).toBe(12.3);
    expect(toCanonical('wind-speed', 'mph', 14)).toBe(14);
    expect(toCanonical('rain-rate', 'in_per_hr', 0.12)).toBe(0.12);
    expect(toCanonical('rain-accumulation', 'in', 1.5)).toBe(1.5);
    expect(toCanonical('pressure', 'inHg', 29.9)).toBe(29.9);
    expect(toCanonical('distance', 'mi', 10.6)).toBe(10.6);
    expect(toCanonical('uv-index', 'index', 7)).toBe(7);
    expect(toCanonical('direction', 'degrees', 315)).toBe(315);
    expect(toCanonical('count', 'count', 3)).toBe(3);
    expect(toCanonical('timestamp', 'ms', 1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe('toCanonical — real conversions (custom metric source units)', () => {
  it('temperature fahrenheit → celsius matches fahrenheitToCelsius', () => {
    expect(toCanonical('temperature', 'fahrenheit', 68)).toBe(fahrenheitToCelsius(68));
    expect(toCanonical('temperature', 'fahrenheit', 32)).toBe(0);
  });

  it('illuminance wm2 → lux matches solarWm2ToLux (rounded, native-parity)', () => {
    expect(toCanonical('illuminance', 'wm2', 500)).toBe(solarWm2ToLux(500));
  });

  it('wind kph/mps/kts → mph is the inverse of convertSpeed', () => {
    // 40 kph, expressed as mph, then back to kph should round-trip.
    const mph = toCanonical('wind-speed', 'kph', 40);
    expect(convertSpeed(mph, 'kph')).toBeCloseTo(40, 6);
    expect(toCanonical('wind-speed', 'mps', convertSpeed(10, 'mps'))).toBeCloseTo(10, 6);
    expect(toCanonical('wind-speed', 'kts', convertSpeed(10, 'kts'))).toBeCloseTo(10, 6);
  });

  it('rain mm → in and rate mm/hr → in/hr use the 25.4 factor', () => {
    expect(toCanonical('rain-accumulation', 'mm', 25.4)).toBeCloseTo(1, 9);
    expect(toCanonical('rain-rate', 'mm_per_hr', 25.4)).toBeCloseTo(1, 9);
  });

  it('pressure hPa → inHg is the inverse of convertPressure', () => {
    const inHg = toCanonical('pressure', 'hPa', 1013);
    expect(convertPressure(inHg, 'hPa')).toBeCloseTo(1013, 6);
  });

  it('distance km/nm → mi is the inverse of convertDistance', () => {
    const miFromKm = toCanonical('distance', 'km', 16.0934);
    expect(miFromKm).toBeCloseTo(10, 6);
    const miFromNm = toCanonical('distance', 'nm', convertDistance(10, 'nm'));
    expect(miFromNm).toBeCloseTo(10, 6);
  });
});

describe('toDisplayUnit — inverse of toCanonical for imperial targets (v1.6.0 parity)', () => {
  it('wind canonical mph → display unit matches convertSpeed directly', () => {
    expect(toDisplayUnit('wind-speed', 14, 'mph')).toBe(convertSpeed(14, 'mph'));
    expect(toDisplayUnit('wind-speed', 14, 'kph')).toBe(convertSpeed(14, 'kph'));
    expect(toDisplayUnit('wind-speed', 14, 'kts')).toBe(convertSpeed(14, 'kts'));
  });

  it('rain / pressure / distance canonical → display match the shared helpers', () => {
    expect(toDisplayUnit('rain-accumulation', 1.5, 'mm')).toBe(convertRain(1.5, 'mm'));
    expect(toDisplayUnit('rain-rate', 1, 'mm_per_hr')).toBeCloseTo(25.4, 9);
    expect(toDisplayUnit('pressure', 29.9, 'hPa')).toBe(convertPressure(29.9, 'hPa'));
    expect(toDisplayUnit('distance', 10, 'km')).toBe(convertDistance(10, 'km'));
  });

  it('temperature celsius → fahrenheit is the exact inverse of F→C', () => {
    expect(toDisplayUnit('temperature', 20, 'fahrenheit')).toBeCloseTo(68, 9);
    expect(toDisplayUnit('temperature', fahrenheitToCelsius(50), 'fahrenheit')).toBeCloseTo(50, 9);
    expect(toDisplayUnit('temperature', 20, 'celsius')).toBe(20);
  });

  it('unit-free families pass canonical through unchanged', () => {
    expect(toDisplayUnit('uv-index', 7, 'index')).toBe(7);
    expect(toDisplayUnit('direction', 315, 'degrees')).toBe(315);
    expect(toDisplayUnit('count', 3, 'count')).toBe(3);
    expect(toDisplayUnit('timestamp', 123, 'ms')).toBe(123);
    expect(toDisplayUnit('humidity', 55, 'percent')).toBe(55);
  });
});

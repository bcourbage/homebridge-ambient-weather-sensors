/**
 * Parity tests for the shared native conversion functions. These
 * lock the arithmetic that BOTH the wrapper classes (normal mode)
 * and safeModeBinding.ts (safe mode) rely on, including the exact
 * boundary values the Group 4 second-follow-up review flagged as
 * divergent in the earlier standalone safe-mode implementation.
 */

import { describe, expect, it } from 'vitest';

import {
  CO2_DETECTED_PPM,
  airQualityLevel,
  airQualityReading,
  co2Reading,
  fahrenheitToCelsius,
  solarWm2ToLux,
} from '../../src/nativeConversions';

describe('fahrenheitToCelsius', () => {
  it.each([
    [32, 0],
    [68, 20],
    [212, 100],
    [-40, -40],
  ])('%d°F → %d°C', (f, c) => {
    expect(fahrenheitToCelsius(f)).toBeCloseTo(c, 6);
  });
});

describe('solarWm2ToLux — matches wrapper (÷ 0.0079, rounded)', () => {
  it('1 W/m² → 127 lux (NOT 126 — the review flagged the 126 divergence)', () => {
    // 1 / 0.0079 = 126.58… → Math.round → 127.
    expect(solarWm2ToLux(1)).toBe(127);
  });
  it('0 W/m² → 0 lux', () => {
    expect(solarWm2ToLux(0)).toBe(0);
  });
  it('790 W/m² → 100000 lux', () => {
    expect(solarWm2ToLux(790)).toBe(100000);
  });
});

describe('co2Reading — rounds before threshold compare', () => {
  it('999.6 ppm rounds to 1000 and marks abnormal (review boundary case)', () => {
    const r = co2Reading(999.6);
    expect(r.ppm).toBe(1000);
    expect(r.detected).toBe(true);
  });
  it('999.4 ppm rounds to 999 and stays normal', () => {
    const r = co2Reading(999.4);
    expect(r.ppm).toBe(999);
    expect(r.detected).toBe(false);
  });
  it('exactly at threshold is abnormal', () => {
    expect(co2Reading(CO2_DETECTED_PPM).detected).toBe(true);
  });
  it('clamps negatives to 0', () => {
    expect(co2Reading(-5).ppm).toBe(0);
  });
});

describe('airQualityLevel — EPA buckets, PM10 boundary the review flagged', () => {
  it('PM10 100 µg/m³ → level 2 (NOT 3 — the review flagged the level-3 divergence)', () => {
    // PM10 buckets: ≤54 → 1, ≤154 → 2. 100 is ≤154, so level 2.
    expect(airQualityLevel(100, 'PM10')).toBe(2);
  });
  it('PM2.5 100 µg/m³ → level 4', () => {
    // PM2.5 buckets: ≤55.4 → 3, ≤150.4 → 4. 100 is ≤150.4.
    expect(airQualityLevel(100, 'PM2.5')).toBe(4);
  });
  it.each([
    [0, 1], [12, 1], [12.1, 2], [35.4, 2], [35.5, 3], [55.4, 3], [55.5, 4], [150.4, 4], [150.5, 5],
  ])('PM2.5 %d → level %d', (density, level) => {
    expect(airQualityLevel(density, 'PM2.5')).toBe(level);
  });
  it.each([
    [0, 1], [54, 1], [55, 2], [154, 2], [155, 3], [254, 3], [255, 4], [354, 4], [355, 5],
  ])('PM10 %d → level %d', (density, level) => {
    expect(airQualityLevel(density, 'PM10')).toBe(level);
  });
});

describe('airQualityReading — density rounded to 1 decimal', () => {
  it('rounds density to one decimal place', () => {
    expect(airQualityReading(12.34, 'PM2.5').density).toBe(12.3);
    expect(airQualityReading(12.36, 'PM2.5').density).toBe(12.4);
  });
});

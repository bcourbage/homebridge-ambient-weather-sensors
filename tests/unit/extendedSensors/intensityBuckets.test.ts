import { describe, expect, it } from 'vitest';

import {
  beaufort,
  rainIntensity,
  toCardinal,
  timeSince,
  uvBucket,
} from '../../../src/extendedSensors/intensityBuckets';

describe('beaufort (wind mph → scale label)', () => {
  it.each([
    [0, 'Calm'],
    [0.5, 'Calm'],
    [1, 'Light air'],
    [3, 'Light air'],
    [4, 'Light breeze'],
    [7, 'Light breeze'],
    [8, 'Gentle breeze'],
    [12, 'Gentle breeze'],
    [13, 'Moderate breeze'],
    [18, 'Moderate breeze'],
    [19, 'Fresh breeze'],
    [24, 'Fresh breeze'],
    [25, 'Strong breeze'],   // the default WindSpeed threshold
    [31, 'Strong breeze'],
    [32, 'Near gale'],
    [38, 'Near gale'],
    [39, 'Gale'],
    [46, 'Gale'],
    [47, 'Strong gale'],
    [54, 'Strong gale'],
    [55, 'Storm'],
    [63, 'Storm'],
    [64, 'Violent storm'],
    [72, 'Violent storm'],
    [73, 'Hurricane'],
    [100, 'Hurricane'],
    [200, 'Hurricane'],
  ])('%d mph → %s', (mph, expected) => {
    expect(beaufort(mph)).toBe(expected);
  });
});

describe('rainIntensity (in/hr → label)', () => {
  it.each([
    [0, 'None'],
    [0.0009, 'None'],
    [0.001, 'Light'],
    [0.05, 'Light'],
    [0.099, 'Light'],
    [0.1, 'Moderate'],
    [0.2, 'Moderate'],
    [0.29, 'Moderate'],
    [0.3, 'Heavy'],
    [1.5, 'Heavy'],
    [1.99, 'Heavy'],
    [2.0, 'Violent'],
    [5, 'Violent'],
  ])('%d in/hr → %s', (rate, expected) => {
    expect(rainIntensity(rate)).toBe(expected);
  });
});

describe('uvBucket (index → label)', () => {
  it.each([
    [0, 'Low'],
    [1, 'Low'],
    [2, 'Low'],
    [2.9, 'Low'],
    [3, 'Moderate'],   // default threshold
    [5, 'Moderate'],
    [5.9, 'Moderate'],
    [6, 'High'],
    [7, 'High'],
    [7.9, 'High'],
    [8, 'Very High'],
    [10, 'Very High'],
    [10.9, 'Very High'],
    [11, 'Extreme'],
    [15, 'Extreme'],
  ])('UV %d → %s', (uv, expected) => {
    expect(uvBucket(uv)).toBe(expected);
  });
});

describe('toCardinal (degrees → 16-point compass)', () => {
  it.each([
    [0, 'N'],
    [11, 'N'],
    [12, 'NNE'],
    [22.5, 'NNE'],
    [45, 'NE'],
    [67.5, 'ENE'],
    [90, 'E'],
    [112.5, 'ESE'],
    [135, 'SE'],
    [157.5, 'SSE'],
    [180, 'S'],
    [202.5, 'SSW'],
    [225, 'SW'],
    [247.5, 'WSW'],
    [270, 'W'],
    [292.5, 'WNW'],
    [315, 'NW'],
    [337.5, 'NNW'],
    [349, 'N'],   // wraps back to N
    [360, 'N'],   // 360° == 0° == N
  ])('%d° → %s', (deg, expected) => {
    expect(toCardinal(deg)).toBe(expected);
  });

  it('handles fractional inputs correctly (rounds to nearest sector)', () => {
    // Sector boundaries are half-way between sector centers: NNE/E is at
    // (22.5+45)/2 = 33.75°, ENE/E is at (67.5+90)/2 = 78.75°.
    expect(toCardinal(11.2)).toBe('N');   // just under N/NNE boundary (11.25)
    expect(toCardinal(11.3)).toBe('NNE'); // just over
    expect(toCardinal(78.7)).toBe('ENE'); // just under ENE/E boundary (78.75)
    expect(toCardinal(78.75)).toBe('E');  // sector boundary — Math.round rounds .5 up
    expect(toCardinal(78.8)).toBe('E');   // just over
  });

  it('handles negative degrees by wrapping', () => {
    // -45 = 315 = NW
    expect(toCardinal(-45)).toBe('NW');
    // -90 = 270 = W
    expect(toCardinal(-90)).toBe('W');
  });

  it('handles values above 360 by wrapping', () => {
    expect(toCardinal(720)).toBe('N');
    expect(toCardinal(405)).toBe('NE');    // 405 - 360 = 45
  });
});

describe('timeSince (Unix ms → relative label)', () => {
  const NOW = new Date('2026-06-30T12:00:00Z').getTime();

  it('returns "never" for zero / undefined / NaN / negative', () => {
    expect(timeSince(0, NOW)).toBe('never');
    expect(timeSince(undefined, NOW)).toBe('never');
    expect(timeSince(NaN, NOW)).toBe('never');
    expect(timeSince(-1, NOW)).toBe('never');
  });

  it('returns "just now" for events under 30s ago', () => {
    expect(timeSince(NOW - 500, NOW)).toBe('just now');       // 0.5s
    expect(timeSince(NOW - 29 * 1000, NOW)).toBe('just now'); // 29s
  });

  it('returns "N seconds ago" for 30-59s', () => {
    expect(timeSince(NOW - 30 * 1000, NOW)).toBe('30 seconds ago');
    expect(timeSince(NOW - 59 * 1000, NOW)).toBe('59 seconds ago');
  });

  it('returns "N minutes ago" (singular / plural)', () => {
    expect(timeSince(NOW - 60 * 1000, NOW)).toBe('1 minute ago');
    expect(timeSince(NOW - 2 * 60 * 1000, NOW)).toBe('2 minutes ago');
    expect(timeSince(NOW - 59 * 60 * 1000, NOW)).toBe('59 minutes ago');
  });

  it('returns "N hours ago" (singular / plural)', () => {
    expect(timeSince(NOW - 60 * 60 * 1000, NOW)).toBe('1 hour ago');
    expect(timeSince(NOW - 3 * 60 * 60 * 1000, NOW)).toBe('3 hours ago');
    expect(timeSince(NOW - 23 * 60 * 60 * 1000, NOW)).toBe('23 hours ago');
  });

  it('returns "N days ago" (singular / plural)', () => {
    expect(timeSince(NOW - 24 * 60 * 60 * 1000, NOW)).toBe('1 day ago');
    expect(timeSince(NOW - 5 * 24 * 60 * 60 * 1000, NOW)).toBe('5 days ago');
    expect(timeSince(NOW - 29 * 24 * 60 * 60 * 1000, NOW)).toBe('29 days ago');
  });

  it('returns "N months ago" (singular / plural)', () => {
    expect(timeSince(NOW - 30 * 24 * 60 * 60 * 1000, NOW)).toBe('1 month ago');
    expect(timeSince(NOW - 90 * 24 * 60 * 60 * 1000, NOW)).toBe('3 months ago');
  });

  it('returns "N years ago" (singular / plural)', () => {
    expect(timeSince(NOW - 365 * 24 * 60 * 60 * 1000, NOW)).toBe('1 year ago');
    expect(timeSince(NOW - 3 * 365 * 24 * 60 * 60 * 1000, NOW)).toBe('3 years ago');
  });

  it('clamps future timestamps to "just now" (never negative-time output)', () => {
    // timestamp AFTER now shouldn't produce a negative "just now" — clamped to 0 delta.
    expect(timeSince(NOW + 5000, NOW)).toBe('just now');
  });
});

import { describe, expect, it } from 'vitest';

import { hapClean, normalizeMatchKey, toMatcherSet } from '../../src/platform';

describe('hapClean (HAP Name characteristic sanitizer)', () => {
  it('passes clean alphanumeric strings through unchanged', () => {
    expect(hapClean('Wind Speed')).toBe('Wind Speed');
    expect(hapClean('Outdoor Temperature')).toBe('Outdoor Temperature');
    expect(hapClean("Bruno's Station")).toBe("Bruno's Station");
  });

  it('replaces disallowed chars with spaces then collapses runs', () => {
    // Colons, hyphens, periods all disallowed by HAP 2.x's Name rule
    // (only alphanumeric, space, apostrophe survive).
    expect(hapClean('WS-2000')).toBe('WS 2000');
    expect(hapClean('Fairhills WS-2000')).toBe('Fairhills WS 2000');
    expect(hapClean('192.168.1.1')).toBe('192 168 1 1');
    expect(hapClean('a::b:::c')).toBe('a b c');
  });

  it('trims leading and trailing non-alphanumeric characters', () => {
    // The Name value MUST start and end with an alphanumeric character.
    expect(hapClean(' Wind Speed ')).toBe('Wind Speed');
    expect(hapClean('---Wind---')).toBe('Wind');
    expect(hapClean('.Pressure.')).toBe('Pressure');
    expect(hapClean("'Backyard'")).toBe('Backyard');   // apostrophes at edges stripped
  });

  it('preserves apostrophes in the middle', () => {
    expect(hapClean("Bruno's Backyard")).toBe("Bruno's Backyard");
    expect(hapClean("It's Windy Today")).toBe("It's Windy Today");
  });

  it('handles empty and all-invalid input', () => {
    expect(hapClean('')).toBe('');
    expect(hapClean('---')).toBe('');
    expect(hapClean('...')).toBe('');
    expect(hapClean("'''")).toBe('');
  });

  it('collapses runs of whitespace into a single space', () => {
    expect(hapClean('Wind   Speed')).toBe('Wind Speed');
    expect(hapClean('Wind\tSpeed')).toBe('Wind Speed');
  });
});

describe('normalizeMatchKey', () => {
  it('lowercases and trims strings', () => {
    expect(normalizeMatchKey('Outdoor Temperature')).toBe('outdoor temperature');
    expect(normalizeMatchKey('  Wind Speed  ')).toBe('wind speed');
    expect(normalizeMatchKey('CAPS')).toBe('caps');
  });

  it('handles ISO-format MAC addresses cleanly', () => {
    expect(normalizeMatchKey('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('returns empty string for non-string inputs (caller filters)', () => {
    expect(normalizeMatchKey(null)).toBe('');
    expect(normalizeMatchKey(undefined)).toBe('');
    expect(normalizeMatchKey(42)).toBe('');
    expect(normalizeMatchKey({})).toBe('');
    expect(normalizeMatchKey([])).toBe('');
    expect(normalizeMatchKey(true)).toBe('');
  });

  it('preserves empty-string input as empty-string output (idempotent)', () => {
    expect(normalizeMatchKey('')).toBe('');
    expect(normalizeMatchKey('   ')).toBe('');
  });
});

describe('toMatcherSet', () => {
  it('builds a Set from an array of strings, normalized', () => {
    const s = toMatcherSet(['Outdoor Temperature', 'Wind Speed', 'CO2']);
    expect(s.has('outdoor temperature')).toBe(true);
    expect(s.has('wind speed')).toBe(true);
    expect(s.has('co2')).toBe(true);
    expect(s.size).toBe(3);
  });

  it('drops blank / whitespace-only entries', () => {
    const s = toMatcherSet(['Wind', '', '  ', 'Rain']);
    expect(s.size).toBe(2);
    expect(s.has('wind')).toBe(true);
    expect(s.has('rain')).toBe(true);
  });

  it('drops non-string entries', () => {
    const s = toMatcherSet(['Wind', 42, null, {}, 'Rain'] as unknown[]);
    expect(s.size).toBe(2);
    expect(s.has('wind')).toBe(true);
    expect(s.has('rain')).toBe(true);
  });

  it('returns an empty Set for non-array input', () => {
    expect(toMatcherSet(undefined).size).toBe(0);
    expect(toMatcherSet(null).size).toBe(0);
    expect(toMatcherSet('Wind').size).toBe(0);      // string is not an array
    expect(toMatcherSet(42).size).toBe(0);
    expect(toMatcherSet({}).size).toBe(0);
  });

  it('returns an empty Set for an empty array', () => {
    expect(toMatcherSet([]).size).toBe(0);
  });

  it('deduplicates case/whitespace variants of the same entry', () => {
    const s = toMatcherSet(['Wind', 'WIND', '  wind  ', 'Wind']);
    expect(s.size).toBe(1);
    expect(s.has('wind')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ALL_WRAPPERS,
  WRAPPER_FOR_KIND_AND_MEASUREMENT,
  wrapperFor,
} from '../../../src/sensorMap/wrappers';

describe('WrapperDescriptor registry', () => {
  it('every wrapper has a non-empty kebab-case id', () => {
    for (const w of ALL_WRAPPERS) {
      expect(w.id).toMatch(/^[a-z0-9-]+$/);
      expect(w.id.length).toBeGreaterThan(0);
    }
  });

  it('every wrapper has schemaVersion >= 1', () => {
    for (const w of ALL_WRAPPERS) {
      expect(w.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(w.schemaVersion)).toBe(true);
    }
  });

  it('every wrapper has a constructor reference', () => {
    for (const w of ALL_WRAPPERS) {
      expect(typeof w.constructor).toBe('function');
    }
  });

  it('wrapper ids are unique', () => {
    const ids = ALL_WRAPPERS.map(w => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('WRAPPER_FOR_KIND_AND_MEASUREMENT resolves to registered wrappers', () => {
    for (const entry of Object.values(WRAPPER_FOR_KIND_AND_MEASUREMENT)) {
      expect(ALL_WRAPPERS).toContain(entry);
    }
  });

  it('wrapperFor() returns undefined for unregistered combinations', () => {
    // Nothing registers `co` yet in the codebase.
    expect(wrapperFor('co', 'co')).toBeUndefined();
    // Nothing registers boolean-family kinds yet.
    expect(wrapperFor('leak', 'boolean')).toBeUndefined();
    expect(wrapperFor('contact', 'boolean')).toBeUndefined();
    expect(wrapperFor('occupancy', 'boolean')).toBeUndefined();
  });

  it('wrapperFor() returns the canonical wrapper for each (kind, measurement)', () => {
    expect(wrapperFor('temperature', 'temperature')?.id).toBe('temperature');
    expect(wrapperFor('humidity', 'humidity')?.id).toBe('humidity');
    expect(wrapperFor('light', 'illuminance')?.id).toBe('solar-radiation');
    expect(wrapperFor('motion', 'wind-speed')?.id).toBe('wind-speed');
    expect(wrapperFor('motion', 'timestamp')?.id).toBe('last-rain');
    expect(wrapperFor('motion', 'count')?.id).toBe('lightning-day');
  });
});

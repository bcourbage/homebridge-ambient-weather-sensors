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

  // ---- Review finding #14: freeze the wrapper vocabulary ----

  // A well-meaning rename or reorder of an `id` silently invalidates
  // every user's HAP accessory cache because `id` is baked into
  // `structuralSignature`. The block below pins the exact ordered
  // list of (id, schemaVersion) pairs. Any change to this snapshot
  // requires an explicit `structuralSignature` migration plan.
  it('ALL_WRAPPERS ordered snapshot — DO NOT CHANGE without a cache-migration plan', () => {
    const snapshot = ALL_WRAPPERS.map(w => ({ id: w.id, schemaVersion: w.schemaVersion }));
    expect(snapshot).toEqual([
      { id: 'temperature',           schemaVersion: 1 },
      { id: 'humidity',              schemaVersion: 1 },
      { id: 'solar-radiation',       schemaVersion: 1 },
      { id: 'co2',                   schemaVersion: 1 },
      { id: 'air-quality-pm25',      schemaVersion: 1 },
      { id: 'air-quality-pm10',      schemaVersion: 1 },
      { id: 'uv',                    schemaVersion: 1 },
      { id: 'wind-speed',            schemaVersion: 1 },
      { id: 'wind-gust',             schemaVersion: 1 },
      { id: 'wind-max-daily-gust',   schemaVersion: 1 },
      { id: 'wind-direction',        schemaVersion: 1 },
      { id: 'wind-direction-10m',    schemaVersion: 1 },
      { id: 'pressure-relative',     schemaVersion: 1 },
      { id: 'pressure-absolute',     schemaVersion: 1 },
      { id: 'rain-rate',             schemaVersion: 1 },
      { id: 'rain-event',            schemaVersion: 1 },
      { id: 'rain-daily',            schemaVersion: 1 },
      { id: 'rain-weekly',           schemaVersion: 1 },
      { id: 'rain-monthly',          schemaVersion: 1 },
      { id: 'rain-yearly',           schemaVersion: 1 },
      { id: 'last-rain',             schemaVersion: 1 },
      { id: 'lightning-day',         schemaVersion: 1 },
      { id: 'lightning-hour',        schemaVersion: 1 },
      { id: 'lightning-distance',    schemaVersion: 1 },
      { id: 'lightning-last-strike', schemaVersion: 1 },
    ]);
    expect(snapshot.length).toBe(25);
  });

  it('descriptors are frozen at runtime — id mutation throws in strict mode', () => {
    // The `readonly` modifier is compile-time only; the runtime
    // freeze covers untyped mutation attempts (dynamic lookups,
    // Object.assign, etc.). vitest runs in strict mode by default,
    // so assigning to a frozen field throws.
    for (const w of ALL_WRAPPERS) {
      expect(Object.isFrozen(w)).toBe(true);
      expect(() => {
        (w as { id: string }).id = 'mutated';
      }).toThrow(TypeError);
    }
    expect(Object.isFrozen(ALL_WRAPPERS)).toBe(true);
  });
});

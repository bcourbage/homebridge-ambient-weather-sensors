import { describe, expect, it } from 'vitest';

import {
  ALL_WRAPPERS,
  WRAPPER_FOR_KIND_AND_MEASUREMENT,
  wrapperFor,
} from '../../../src/sensorMap/wrappers';
import { WRAPPER_SPEC } from '../../../src/sensorMap/wrapperFactories';

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

  // ---- finding-#4 Stage 4: resolution table RESTORED ----
  //
  // Replaces the Stage-0 stays-empty regression (same commit as the
  // restore, per the review requirement). Two invariants:
  //   1. The exact 15-entry shape is pinned — an entry silently added,
  //      dropped, or remapped is a structural event, not a refactor.
  //   2. Every entry's descriptor agrees with its key's
  //      (kind, measurement) per WRAPPER_SPEC — a drifted entry would
  //      otherwise be caught only at map-construction time
  //      (wrapper-mismatch note) or registration (throw).
  it('WRAPPER_FOR_KIND_AND_MEASUREMENT has EXACTLY the 15 restored entries', () => {
    const expected: Record<string, string> = {
      'temperature|temperature':  'temperature',
      'humidity|humidity':        'humidity',
      'light|illuminance':        'solar-radiation',
      'co2|co2':                  'co2',
      'air-quality-pm25|pm25':    'air-quality-pm25',
      'air-quality-pm10|pm10':    'air-quality-pm10',
      'motion|uv-index':          'uv',
      'motion|wind-speed':        'wind-speed',
      'motion|direction':         'wind-direction',
      'motion|pressure':          'pressure-relative',
      'motion|rain-rate':         'rain-rate',
      'motion|rain-accumulation': 'rain-event',
      'motion|distance':          'lightning-distance',
      'motion|count':             'lightning-day',
      'motion|timestamp':         'last-rain',
    };
    const actual = Object.fromEntries(
      Object.entries(WRAPPER_FOR_KIND_AND_MEASUREMENT).map(([k, v]) => [k, v!.id]),
    );
    expect(actual).toEqual(expected);
    expect(Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT)).toHaveLength(15);
  });

  it('every table entry is spec-consistent: the key equals the wrapper\'s (kind, measurement)', () => {
    for (const [key, descriptor] of Object.entries(WRAPPER_FOR_KIND_AND_MEASUREMENT)) {
      const spec = WRAPPER_SPEC[descriptor!.id];
      expect(`${spec.kind}|${spec.measurement}`, `entry ${key} → ${descriptor!.id}`).toBe(key);
    }
  });

  it('wrapperFor() resolves every restored combination', () => {
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

/**
 * Unit vocabulary (GA task #70) — the contracts that keep three
 * authorities agreeing without any becoming a second validator:
 *
 *   1. LEGAL_UNITS_FOR_MEASUREMENT (units.ts) — validity authority.
 *   2. UNIT_VOCABULARY — labels / ordering / selection contexts.
 *      EXACT bijection with (1): same ids, same order, no duplicates,
 *      nothing missing, nothing extra.
 *   3. config.schema.json's `units` fieldset — cannot import TS, so it
 *      is pinned by EXACT parity (keys, ids, titles, ordering,
 *      defaults) against LEGACY_SCHEMA_UNIT_EXPOSURE. A loose "every
 *      schema enum is legal" check would miss omissions/reordering.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_UNITS_FOR_MEASUREMENT } from '../../../src/sensorMap/units';
import {
  AWN_UNITS_PAGE,
  DISPLAY_FAMILIES,
  LEGACY_SCHEMA_UNIT_EXPOSURE,
  UNIT_VOCABULARY,
  V17_LEGAL_LEGACY_UNITS,
  unitOptionsFor,
} from '../../../src/sensorMap/unitVocabulary';
import type { Measurement } from '../../../src/sensorMap/types';

const measurements = Object.keys(LEGAL_UNITS_FOR_MEASUREMENT) as Measurement[];

describe('vocabulary ↔ legal-set bijection', () => {
  it('every measurement has a vocabulary list whose ids equal the legal set exactly (order included)', () => {
    for (const m of measurements) {
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[m];
      const vocab = UNIT_VOCABULARY[m].map(o => o.unit);
      expect(vocab, m).toEqual([...legal]);
    }
  });

  it('no vocabulary list contains duplicates', () => {
    for (const m of measurements) {
      const vocab = UNIT_VOCABULARY[m].map(o => o.unit);
      expect(new Set(vocab).size, m).toBe(vocab.length);
    }
  });

  it('vocabulary covers no measurements beyond the legal sets', () => {
    expect(Object.keys(UNIT_VOCABULARY).sort()).toEqual([...measurements].sort());
  });

  it('every option carries a non-empty label', () => {
    for (const m of measurements) {
      for (const o of UNIT_VOCABULARY[m]) {
        expect(o.label.length, `${m}/${o.unit}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('selection contexts', () => {
  it('native HAP measurements are never display-selectable', () => {
    for (const m of ['temperature', 'humidity', 'illuminance', 'co2', 'co', 'pm25', 'pm10'] as Measurement[]) {
      expect(unitOptionsFor(m, 'extended-display'), m).toEqual([]);
    }
  });

  it('fc is a custom-source choice only (illuminance display is fixed to lux)', () => {
    const fc = UNIT_VOCABULARY.illuminance.find(o => o.unit === 'fc')!;
    expect(fc.selectableAsCustomSourceUnit).toBe(true);
    expect(fc.selectableAsExtendedDisplayUnit).toBe(false);
  });

  it('mmHg and fps are offered for extended display AND custom source', () => {
    const mmHg = UNIT_VOCABULARY.pressure.find(o => o.unit === 'mmHg')!;
    const fps = UNIT_VOCABULARY['wind-speed'].find(o => o.unit === 'fps')!;
    for (const o of [mmHg, fps]) {
      expect(o.selectableAsCustomSourceUnit).toBe(true);
      expect(o.selectableAsExtendedDisplayUnit).toBe(true);
    }
  });

  it("timestamp's 'ms' is fixed by contract — never selectable anywhere", () => {
    expect(unitOptionsFor('timestamp', 'custom-source')).toEqual([]);
    expect(unitOptionsFor('timestamp', 'extended-display')).toEqual([]);
  });

  it('boolean has no units in any context', () => {
    expect(UNIT_VOCABULARY.boolean).toEqual([]);
  });
});

describe('AWN units-page observed mapping', () => {
  it('is dated and sourced (auditable reference)', () => {
    expect(AWN_UNITS_PAGE.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(AWN_UNITS_PAGE.source).toContain('ambientweather.net');
  });

  it('classifies every AWN category explicitly', () => {
    const allowed = new Set(['supported', 'client-controlled-display', 'bucket-only', 'deferred', 'not-applicable']);
    expect(AWN_UNITS_PAGE.categories.length).toBe(8); // the observed page has 8 categories
    for (const c of AWN_UNITS_PAGE.categories) {
      expect(allowed.has(c.classification), c.awnCategory).toBe(true);
      expect(c.awnOptions.length, c.awnCategory).toBeGreaterThan(0);
      expect(c.mapping.length, c.awnCategory).toBeGreaterThan(0);
    }
  });

  it('AWN wind and pressure option ORDER is mirrored by the vocabulary', () => {
    // AWN: mph, ft/sec, m/sec, km/hr, knots → mph, fps, mps, kph, kts.
    expect(UNIT_VOCABULARY['wind-speed'].map(o => o.label))
      .toEqual(['mph', 'ft/sec', 'm/sec', 'km/hr', 'knots']);
    // AWN: inHg, mmHg, hPa.
    expect(UNIT_VOCABULARY.pressure.map(o => o.label)).toEqual(['inHg', 'mmHg', 'hPa']);
  });
});

describe('legacy schema parity (exact: keys, ids, titles, order, defaults)', () => {
  const schema = JSON.parse(readFileSync(
    path.resolve(__dirname, '../../../config.schema.json'), 'utf8',
  )) as { schema: { properties: { units: { properties: Record<string, {
    title: string; default: string; oneOf: Array<{ title: string; enum: string[] }>;
  }> } } } };
  const schemaUnits = schema.schema.properties.units.properties;

  it('the schema exposes exactly the legacy unit keys — no native temp/solar knobs', () => {
    expect(Object.keys(schemaUnits)).toEqual(Object.keys(LEGACY_SCHEMA_UNIT_EXPOSURE));
  });

  it('every key matches the exposure projection exactly', () => {
    for (const [key, exposure] of Object.entries(LEGACY_SCHEMA_UNIT_EXPOSURE)) {
      const field = schemaUnits[key];
      expect(field.title, key).toBe(exposure.title);
      expect(field.default, key).toBe(exposure.default);
      expect(field.oneOf.map(o => ({ unit: o.enum[0], title: o.title })), key)
        .toEqual([...exposure.options]);
    }
  });

  it('v2-only units (mmHg, fps) are absent from the legacy schema', () => {
    const allSchemaUnits = Object.values(schemaUnits).flatMap(f => f.oneOf.map(o => o.enum[0]));
    expect(allSchemaUnits).not.toContain('mmHg');
    expect(allSchemaUnits).not.toContain('fps');
    expect(allSchemaUnits).not.toContain('fc');
  });

  it('every exposed option is legal for its measurement AND 1.7-legal', () => {
    for (const [key, exposure] of Object.entries(LEGACY_SCHEMA_UNIT_EXPOSURE)) {
      const legal = LEGAL_UNITS_FOR_MEASUREMENT[exposure.measurement];
      for (const o of exposure.options) {
        expect(legal, `${key}/${o.unit}`).toContain(o.unit);
        expect(V17_LEGAL_LEGACY_UNITS[key as keyof typeof V17_LEGAL_LEGACY_UNITS], `${key}/${o.unit}`)
          .toContain(o.unit);
      }
    }
  });
});

describe('display families (GA #70 editor layer, PR #53)', () => {
  const allMeasurements = Object.keys(UNIT_VOCABULARY) as Measurement[];

  it('every family choice unit is extended-display-selectable for its measurement', () => {
    for (const family of DISPLAY_FAMILIES) {
      for (const choice of family.choices) {
        for (const [m, unit] of Object.entries(choice.units)) {
          const options = unitOptionsFor(m as Measurement, 'extended-display').map(o => o.unit);
          expect(options, `${family.key}/${choice.id}/${m}`).toContain(unit);
        }
      }
    }
  });

  it('each choice covers its family measurements exhaustively, with unique ids', () => {
    for (const family of DISPLAY_FAMILIES) {
      expect(family.choices.length, family.key).toBeGreaterThanOrEqual(2);
      const ids = family.choices.map(c => c.id);
      expect(new Set(ids).size, family.key).toBe(ids.length);
      for (const choice of family.choices) {
        expect(Object.keys(choice.units).sort(), `${family.key}/${choice.id}`)
          .toEqual([...family.measurements].sort());
      }
    }
  });

  it('every measurement with two or more display options is governed by exactly one family', () => {
    const governed = new Map<string, string>();
    for (const family of DISPLAY_FAMILIES) {
      for (const m of family.measurements) {
        expect(governed.has(m), `measurement ${m} in two families`).toBe(false);
        governed.set(m, family.key);
      }
    }
    for (const m of allMeasurements) {
      const displayOptions = unitOptionsFor(m, 'extended-display');
      if (displayOptions.length >= 2) {
        expect(governed.has(m), `measurement ${m} has ${displayOptions.length} display options but no family`).toBe(true);
      } else {
        expect(governed.has(m), `measurement ${m} has <2 display options yet sits in family ${governed.get(m)}`).toBe(false);
      }
    }
  });

  it('a family choice exists for every extended-display unit of its measurements (no unreachable unit)', () => {
    for (const family of DISPLAY_FAMILIES) {
      for (const m of family.measurements) {
        const options = unitOptionsFor(m, 'extended-display').map(o => o.unit);
        const reachable = new Set(family.choices.map(c => c.units[m]));
        for (const unit of options) {
          expect(reachable.has(unit), `${family.key}: unit ${unit} of ${m} unreachable from any choice`).toBe(true);
        }
      }
    }
  });

  it('families mirror the AWN units page EXACTLY: category names, option labels, and order (round 2 F2)', () => {
    const supported = AWN_UNITS_PAGE.categories.filter(c => c.classification === 'supported');
    // Same categories, same order, same capitalization.
    expect(DISPLAY_FAMILIES.map(f => f.label)).toEqual(supported.map(c => c.awnCategory));
    for (const [i, family] of DISPLAY_FAMILIES.entries()) {
      const awnChoices = family.choices.filter(c => c.awn);
      const extras = family.choices.filter(c => !c.awn);
      // AWN-mirroring choices reproduce AWN's visible option labels
      // verbatim, in AWN's order...
      expect(awnChoices.map(c => c.label), family.key).toEqual([...supported[i].awnOptions]);
      // ...and precede every plugin extra, which must say it is one.
      const firstExtra = family.choices.findIndex(c => !c.awn);
      if (firstExtra !== -1) {
        expect(family.choices.slice(firstExtra).every(c => !c.awn), family.key).toBe(true);
      }
      for (const extra of extras) {
        expect(extra.label, `${family.key}/${extra.id}`).toContain('plugin');
      }
    }
  });
});

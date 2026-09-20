/**
 * Catalog coverage (issue #63, package P1): the executable inventory
 * is compared key-by-key against the PRODUCTION recognizer and battery
 * rules — never a second handwritten recognizer. Known gaps are
 * asserted AS gaps: a definition added without re-dispositioning the
 * catalog entry (or a catalog change without the definition) fails
 * here instead of silently drifting.
 */
import { describe, expect, it } from 'vitest';

import {
  AWN_CATALOG,
  catalogBatteryFieldFor,
  expandCatalogKeys,
  type CatalogEntry,
} from '../../../src/sensorMap/catalog/awnCatalog';
import { NATIVE_SENSOR_SERVICES } from '../../../src/sensorMap/catalog/capabilities';
import { DEFAULT_SENSOR_MAP, defaultRowFor, staticDefaultRowFor } from '../../../src/sensorMap/defaultMap';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from '../../../src/sensorMap/wrappers';
import { batteryFieldForSensor } from '../../../src/batteryFields';
import { KIND_SUPPORT } from '../../../homebridge-ui/app-src/kind-support';

const NATIVE_KINDS = new Set(['temperature', 'humidity', 'light', 'co2', 'air-quality-pm25', 'air-quality-pm10']);

function indexOf(entry: CatalogEntry, key: string): number | undefined {
  if (!entry.indexed) {
    return undefined;
  }
  const { prefix, suffix = '' } = entry.indexed;
  return Number(key.slice(prefix.length, suffix ? -suffix.length : undefined));
}

describe('AWN catalog inventory shape', () => {
  it('covers the audited published inventory (78 entries, 169 keys) plus the supported extra', () => {
    expect(AWN_CATALOG).toHaveLength(79); // 78 published + co2_in
    const keys = AWN_CATALOG.flatMap(expandCatalogKeys);
    expect(keys).toHaveLength(170); // 169 published + co2_in
    expect(new Set(keys).size).toBe(keys.length); // no key claimed twice
  });

  it('every entry states meaning, evidence, and an explicit disposition', () => {
    for (const entry of AWN_CATALOG) {
      expect(entry.meaning.length, entry.family).toBeGreaterThan(0);
      expect(entry.evidence.length, entry.family).toBeGreaterThan(0);
      expect(entry.disposition, entry.family).toBeTruthy();
    }
  });

  it('every static-table dataPoint is claimed by exactly one implemented or compat entry', () => {
    const claimed = new Map<string, CatalogEntry>();
    for (const entry of AWN_CATALOG) {
      for (const key of expandCatalogKeys(entry)) {
        claimed.set(key, entry);
      }
    }
    for (const row of DEFAULT_SENSOR_MAP) {
      const entry = claimed.get(row.dataPoint);
      expect(entry, `static row '${row.dataPoint}' missing from the catalog`).toBeDefined();
      expect(['implemented-native', 'implemented-extended', 'compat-fallback'],
        `static row '${row.dataPoint}' dispositioned '${entry!.disposition}'`).toContain(entry!.disposition);
    }
  });
});

describe('dispositions match the production recognizer, key by key', () => {
  for (const entry of AWN_CATALOG) {
    it(`${entry.family} — ${entry.disposition}`, () => {
      for (const key of expandCatalogKeys(entry)) {
        const staticRow = staticDefaultRowFor(key);
        const anyRow = defaultRowFor(key);
        switch (entry.disposition) {
          case 'implemented-native':
          case 'implemented-extended': {
            expect(staticRow, `${key} should be in the static table`).toBeDefined();
            const isNative = NATIVE_KINDS.has(staticRow!.kind);
            expect(isNative, `${key} kind '${staticRow!.kind}' vs disposition`).toBe(entry.disposition === 'implemented-native');
            if (entry.sourceUnit !== undefined) {
              expect(staticRow!.sourceUnit, `${key} sourceUnit`).toBe(entry.sourceUnit);
            }
            break;
          }
          case 'compat-fallback': {
            const idx = indexOf(entry, key);
            const staticThrough = entry.indexed?.staticThrough ?? 0;
            if (idx !== undefined && idx <= staticThrough) {
              expect(staticRow, `${key} should be static (within staticThrough)`).toBeDefined();
            } else {
              expect(staticRow, `${key} must NOT be static yet`).toBeUndefined();
              expect(anyRow, `${key} should resolve via the fallback`).toBeDefined();
            }
            break;
          }
          case 'catalog-gap':
          case 'auxiliary':
          case 'metadata':
          case 'state-unsupported': {
            // The honest assertion: NOT recognized as a sensor row
            // today. If support lands, this fails until the entry is
            // re-dispositioned — gaps are never disguised.
            expect(anyRow, `${key} is dispositioned '${entry.disposition}' and must not resolve a row`).toBeUndefined();
            break;
          }
        }
        // Battery relationship, where the catalog asserts one.
        if (entry.batteryField !== undefined && entry.class === 'measurement') {
          const expected = catalogBatteryFieldFor(entry, key);
          expect(batteryFieldForSensor(key) ?? null, `${key} battery relationship`).toBe(expected);
        }
      }
    });
  }
});

describe('boundary and near-miss behavior is recorded, not hidden', () => {
  it('indexed bounds: feelsLike10 resolves (fallback); feelsLike11 exceeds the documented bounds yet the BROAD matcher still accepts it', () => {
    expect(staticDefaultRowFor('feelsLike10')).toBeUndefined();
    expect(defaultRowFor('feelsLike10')).toBeDefined();
    // The fallback's breadth exceeds the published bounds — recorded
    // honestly. Anchored P2 definitions decide whether out-of-bounds
    // indexes stay accepted, under the assignment-preservation rules.
    expect(defaultRowFor('feelsLike11')).toBeDefined();
  });

  it('near-misses stay unrecognized: soilhum is not humidity, batt_co2 is not co2, aqi_pm25_in is not pm25', () => {
    expect(defaultRowFor('soilhum4')).toBeUndefined();
    expect(defaultRowFor('batt_co2')).toBeUndefined();
    expect(defaultRowFor('aqi_pm25_in')).toBeUndefined();
  });
});

describe('output capabilities match the runtime registries', () => {
  it('specifies exactly the 11 native sensor service families', () => {
    expect(NATIVE_SENSOR_SERVICES).toHaveLength(11);
    expect(new Set(NATIVE_SENSOR_SERVICES.map(s => s.service)).size).toBe(11);
  });

  it('implemented and reserved statuses agree with KIND_SUPPORT', () => {
    for (const spec of NATIVE_SENSOR_SERVICES) {
      if (spec.kinds === undefined) {
        expect(spec.status, spec.service).toBe('absent-from-vocabulary');
        continue;
      }
      for (const kind of spec.kinds) {
        const support = KIND_SUPPORT[kind as keyof typeof KIND_SUPPORT];
        expect(support, `${spec.service} kind '${kind}' missing from KIND_SUPPORT`).toBeDefined();
        expect(support.supported, `${spec.service}/${kind} supported flag`).toBe(
          spec.status === 'implemented' || spec.status === 'implemented-narrow');
      }
    }
  });

  it('the wrapper registry holds exactly the 15 implemented kind/measurement pairs the audit counted', () => {
    const pairs = Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT);
    expect(pairs).toHaveLength(15);
    // Every implemented pair's kind is one an implemented native
    // service claims (motion = the extended shell).
    const implementedKinds = new Set(NATIVE_SENSOR_SERVICES
      .filter(s => s.status === 'implemented' || s.status === 'implemented-narrow')
      .flatMap(s => s.kinds ?? []));
    for (const pair of pairs) {
      expect(implementedKinds.has(pair.split('|')[0]), pair).toBe(true);
    }
  });
});

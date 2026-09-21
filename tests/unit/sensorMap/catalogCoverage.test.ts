/**
 * Catalog coverage (issue #63, package P1): the executable inventory
 * is compared key-by-key against the PRODUCTION recognizer and battery
 * rules — never a second handwritten recognizer. Known gaps are
 * asserted AS gaps: a definition added without re-dispositioning the
 * catalog entry (or a catalog change without the definition) fails
 * here instead of silently drifting.
 *
 * Assertions compare IDENTITIES AND VALUES, not shapes (PR #65 review
 * F3): every implemented/compat key's resolved kind, measurement, and
 * source unit must equal the catalog's statement; every capability
 * pair must resolve the declared wrapper in the real registry; and
 * each implemented pair is instantiated against REAL hap-nodejs to
 * prove the declared HAP service is the one the wrapper creates.
 */
import { describe, expect, it } from 'vitest';

import {
  AWN_CATALOG,
  AWN_CATALOG_VERSION,
  catalogBatteryFieldFor,
  expandCatalogKeys,
  type CatalogEntry,
} from '../../../src/sensorMap/catalog/awnCatalog';
import { NATIVE_SENSOR_SERVICES } from '../../../src/sensorMap/catalog/capabilities';
import { catalogRowFor, DEFAULT_SENSOR_MAP, defaultRowFor, staticDefaultRowFor, VERSIONED_CATALOG_ROWS } from '../../../src/sensorMap/defaultMap';
import { CURRENT_CATALOG_VERSION } from '../../../src/sensorMap/catalogVersion';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT, WRAPPER_PAIR_SINCE } from '../../../src/sensorMap/wrappers';
import { instantiateWrapper } from '../../../src/sensorMap/wrapperFactories';
import { batteryFieldForSensor } from '../../../src/batteryFields';
import { KIND_SUPPORT } from '../../../homebridge-ui/app-src/kind-support';
import type { DefaultSensorRow, EffectiveSensorRow, WrapperId } from '../../../src/sensorMap/types';
// Real-HAP harness (shared with the graph-parity suite).
// eslint-disable-next-line
import { makeHapPlatform, makeHapAccessory, contextFor } from '../../helpers/hapGraph.mjs';
import { makeBooleanRow, makeNumericRow, makeTimestampRow } from '../../helpers/effectiveRow';
import type { AmbientWeatherSensorsPlatform } from '../../../src/platform';

const NATIVE_KINDS = new Set([
  'temperature', 'humidity', 'light', 'co2', 'air-quality-pm25', 'air-quality-pm10',
  // Catalog-3 native services (§19.1/§19.3).
  'leak', 'contact', 'occupancy', 'smoke',
]);

/** Dispositions whose entries must state (and match) a resolved identity. */
const RESOLVED_DISPOSITIONS = new Set(['implemented-native', 'implemented-extended', 'compat-fallback', 'anchored']);

function indexOf(entry: CatalogEntry, key: string): number | undefined {
  if (!entry.indexed) {
    return undefined;
  }
  const { prefix, suffix = '' } = entry.indexed;
  return Number(key.slice(prefix.length, suffix ? -suffix.length : undefined));
}

/** Assert a resolved row's identity equals the catalog entry's statement. */
function expectIdentity(row: { kind: string; measurement: string; sourceUnit?: string }, entry: CatalogEntry, key: string): void {
  expect(row.kind, `${key} kind`).toBe(entry.kind);
  expect(row.measurement, `${key} measurement`).toBe(entry.measurement);
  if (entry.measurement !== 'timestamp' && entry.measurement !== 'boolean') {
    expect(entry.sourceUnit, `${key}: numeric entry must state its sourceUnit`).toBeDefined();
    expect(row.sourceUnit, `${key} sourceUnit`).toBe(entry.sourceUnit);
  }
}

describe('AWN catalog inventory shape', () => {
  it('the catalog version equals the runtime CURRENT_CATALOG_VERSION', () => {
    expect(AWN_CATALOG_VERSION).toBe(CURRENT_CATALOG_VERSION);
  });

  it('every versioned runtime definition is claimed by an entry of the SAME catalog version, and vice versa', () => {
    const entrySince = new Map<string, number>();
    for (const e of AWN_CATALOG) {
      for (const key of expandCatalogKeys(e)) {
        entrySince.set(key, e.sinceCatalogVersion ?? 1);
      }
    }
    for (const row of VERSIONED_CATALOG_ROWS) {
      expect(entrySince.get(row.dataPoint), `runtime row '${row.dataPoint}' catalog version`)
        .toBe(row.sinceCatalogVersion ?? 1);
    }
    const runtimeKeys = new Set(VERSIONED_CATALOG_ROWS.map(r => r.dataPoint));
    for (const [dp, since] of entrySince) {
      // Runtime rows are exact keys; entries may cover wider audited
      // families (feelsLike1..10 spans the v1-static 1..4 too).
      if (since >= 2 && staticDefaultRowFor(dp) === undefined) {
        expect(runtimeKeys.has(dp), `catalog-${since} key '${dp}' has no runtime definition`).toBe(true);
      }
    }
  });

  it('covers the audited published inventory (79 entries, 169 keys) plus the supported extra', () => {
    // 78 published families + co2_in, with soilhum split into two
    // entries (1-4 battery-declared, 5-10 not; PR #67 review F8) = 80.
    expect(AWN_CATALOG).toHaveLength(80);
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

  it('every implemented/compat entry states its expected identity', () => {
    for (const entry of AWN_CATALOG) {
      if (RESOLVED_DISPOSITIONS.has(entry.disposition)) {
        expect(entry.kind, `${entry.family} must state kind`).toBeTruthy();
        expect(entry.measurement, `${entry.family} must state measurement`).toBeTruthy();
      }
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
      expect(['implemented-native', 'implemented-extended', 'compat-fallback', 'anchored'],
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
        const since = entry.sinceCatalogVersion ?? 1;
        switch (entry.disposition) {
          case 'implemented-native':
          case 'implemented-extended': {
            if (since >= 2) {
              // A catalog-2 definition: stamp-gated, never in the v1
              // static table, never fallback-recognized (it was a gap),
              // resolved by catalogRowFor exactly at/after its version.
              expect(staticRow, `${key} must NOT be in the frozen v1 table`).toBeUndefined();
              expect(anyRow, `${key} must not be fallback-recognized`).toBeUndefined();
              expect(catalogRowFor(key, since - 1), `${key} must be invisible below ${since}`).toBeUndefined();
              const adopted = catalogRowFor(key, since);
              expect(adopted, `${key} should resolve at catalog ${since}`).toBeDefined();
              const isNative = NATIVE_KINDS.has(adopted!.kind);
              expect(isNative, `${key} kind '${adopted!.kind}' vs disposition`).toBe(entry.disposition === 'implemented-native');
              expectIdentity(adopted!, entry, key);
              break;
            }
            expect(staticRow, `${key} should be in the static table`).toBeDefined();
            const isNative = NATIVE_KINDS.has(staticRow!.kind);
            expect(isNative, `${key} kind '${staticRow!.kind}' vs disposition`).toBe(entry.disposition === 'implemented-native');
            expectIdentity(staticRow!, entry, key);
            break;
          }
          case 'compat-fallback':
          case 'anchored': {
            const idx = indexOf(entry, key);
            const staticThrough = entry.indexed?.staticThrough ?? 0;
            if (idx !== undefined && idx <= staticThrough) {
              expect(staticRow, `${key} should be static (within staticThrough)`).toBeDefined();
              expectIdentity(staticRow!, entry, key);
            } else {
              expect(staticRow, `${key} must NOT be in the frozen v1 table`).toBeUndefined();
              expect(anyRow, `${key} should resolve via the fallback`).toBeDefined();
              expectIdentity(anyRow!, entry, key);
              if (entry.disposition === 'anchored') {
                // The anchored invariant (§18.3): the catalog-2
                // definition is IDENTICAL to the fallback's synthesis.
                const anchored = catalogRowFor(key, since);
                expect(anchored, `${key} should be anchored at catalog ${since}`).toBeDefined();
                expect(catalogRowFor(key, since - 1), `${key} anchored row invisible below ${since}`).toBeUndefined();
                expectIdentity(anchored!, entry, key);
                expect(anchored!.name, `${key} anchored name`).toBe(anyRow!.name);
                expect(anchored!.batteryField, `${key} anchored battery`).toBe(anyRow!.batteryField);
                expect(anchored!.wrapper.id, `${key} anchored wrapper`).toBe(anyRow!.wrapper.id);
              }
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
        // Battery relationship, where the catalog asserts one. v1
        // entries bind through the LEGACY battery rules; catalog-2
        // definitions bind through their own runtime rows.
        if (entry.batteryField !== undefined && entry.class === 'measurement') {
          const expected = catalogBatteryFieldFor(entry, key);
          if (since >= 2 && staticDefaultRowFor(key) === undefined && defaultRowFor(key) === undefined) {
            expect(catalogRowFor(key, since)?.batteryField ?? null, `${key} battery relationship`).toBe(expected);
          } else {
            expect(batteryFieldForSensor(key) ?? null, `${key} battery relationship`).toBe(expected);
          }
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
  const implementedSpecs = NATIVE_SENSOR_SERVICES.filter(
    s => s.status === 'implemented' || s.status === 'implemented-narrow');

  it('specifies exactly the 11 native sensor service families', () => {
    expect(NATIVE_SENSOR_SERVICES).toHaveLength(11);
    expect(new Set(NATIVE_SENSOR_SERVICES.map(s => s.service)).size).toBe(11);
  });

  it('pairs are present exactly on implemented statuses', () => {
    for (const spec of NATIVE_SENSOR_SERVICES) {
      const implemented = spec.status === 'implemented' || spec.status === 'implemented-narrow';
      expect(spec.pairs !== undefined, `${spec.service} pairs vs status '${spec.status}'`).toBe(implemented);
      if (spec.pairs) {
        expect(spec.pairs.length, spec.service).toBeGreaterThan(0);
      }
    }
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

  it('spec pairs are SET-EQUAL to the wrapper registry (both directions)', () => {
    const specPairs = implementedSpecs.flatMap(s => s.pairs!.map(p => p.pair)).sort();
    const registryPairs = Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT).sort();
    expect(specPairs).toEqual(registryPairs);
  });

  it('every spec pair resolves ITS declared wrapper, version, and kind', () => {
    for (const spec of implementedSpecs) {
      for (const { pair, wrapperId, since } of spec.pairs!) {
        const key = pair as keyof typeof WRAPPER_FOR_KIND_AND_MEASUREMENT;
        const descriptor = WRAPPER_FOR_KIND_AND_MEASUREMENT[key];
        expect(descriptor, `${spec.service}: pair '${pair}' missing from the registry`).toBeDefined();
        expect(descriptor!.id, `${spec.service}: pair '${pair}' wrapper`).toBe(wrapperId);
        expect(WRAPPER_PAIR_SINCE[key] ?? 1, `${spec.service}: pair '${pair}' sinceCatalogVersion`)
          .toBe(since ?? 1);
        expect(spec.kinds, `${spec.service}: pair '${pair}' kind outside declared kinds`)
          .toContain(pair.split('|')[0]);
      }
    }
  });
});

describe('implemented pairs instantiate the DECLARED HAP service (real hap-nodejs)', () => {
  function representativeDefaultRow(wrapperId: WrapperId): DefaultSensorRow | undefined {
    return DEFAULT_SENSOR_MAP.find(r => r.wrapper.id === wrapperId)
      ?? VERSIONED_CATALOG_ROWS.find(r => r.wrapper.id === wrapperId);
  }

  function rowFromDefault(dr: DefaultSensorRow): EffectiveSensorRow {
    const common = {
      kind: dr.kind, dataPoint: dr.dataPoint, name: dr.name, wrapperId: dr.wrapper.id,
      threshold: dr.threshold, triggerDirection: dr.triggerDirection,
      hasBatterySubService: false, batteryField: dr.batteryField ?? 'battout',
    } as const;
    if (dr.measurement === 'timestamp') {
      return makeTimestampRow({ ...common });
    }
    if (dr.measurement === 'boolean') {
      return makeBooleanRow({ ...common });
    }
    return makeNumericRow({
      ...common,
      measurement: dr.measurement as Exclude<typeof dr.measurement, 'timestamp' | 'boolean'>,
      sourceUnit: dr.sourceUnit, displayUnit: dr.displayUnit,
    });
  }

  /**
   * Pairs with no default row anywhere (contact/occupancy/smoke/
   * motion-boolean/co exist for custom assignments only): build a
   * synthetic row straight from the pair, per §16's genericity
   * requirement.
   */
  function syntheticRowFor(pair: string, wrapperId: WrapperId): EffectiveSensorRow {
    const [kind, measurement] = pair.split('|') as [DefaultSensorRow['kind'], DefaultSensorRow['measurement']];
    const common = {
      kind, dataPoint: `test_${wrapperId.replace(/-/g, '_')}`, name: `Test ${wrapperId}`,
      wrapperId, hasBatterySubService: false, batteryField: null,
    } as const;
    if (measurement === 'boolean') {
      return makeBooleanRow({ ...common });
    }
    if (measurement === 'timestamp') {
      return makeTimestampRow({ ...common });
    }
    return makeNumericRow({
      ...common,
      measurement: measurement as Exclude<DefaultSensorRow['measurement'], 'timestamp' | 'boolean'>,
      sourceUnit: measurement === 'co' ? 'ppm' : 'index',
      displayUnit: measurement === 'co' ? 'ppm' : 'index',
    });
  }

  function airQualityType(wrapperId: string): string | undefined {
    return wrapperId === 'air-quality-pm10' ? 'PM10'
      : wrapperId === 'air-quality-pm25' ? 'PM25' : undefined;
  }

  const cases = NATIVE_SENSOR_SERVICES
    .filter(s => s.pairs !== undefined)
    .flatMap(s => s.pairs!.map(p => [s.service, p.pair, p.wrapperId] as const));

  it.each(cases)('%s ← %s (%s)', (service, pair, wrapperId) => {
    const platform = makeHapPlatform();
    const ServiceCtor = (platform as { Service: Record<string, { UUID: string } | undefined> }).Service[service];
    expect(ServiceCtor, `platform.Service.${service} must exist (spec names a real HAP service)`).toBeDefined();

    const accessory = makeHapAccessory(contextFor(wrapperId, { battery: false, type: airQualityType(wrapperId) }));
    const representative = representativeDefaultRow(wrapperId as WrapperId);
    instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      representative ? rowFromDefault(representative) : syntheticRowFor(pair, wrapperId as WrapperId),
    );
    const uuids = (accessory as { services: Array<{ UUID: string }> }).services.map(s => s.UUID);
    expect(uuids, `${pair} must instantiate ${service}`).toContain(ServiceCtor!.UUID);
  });
});

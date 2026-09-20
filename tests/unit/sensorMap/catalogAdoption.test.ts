/**
 * Catalog adoption + assignment preservation (issue #63 P2 —
 * sensor-map.md §18.3/§18.4). The required tests from the design
 * checkpoint: stamp parsing and fail-closed mode detection, exposure
 * arithmetic, the anchored-identity invariant, the AP-2 branch matrix,
 * partial-identity blocking, the Demeter preservation fixture, AP-4
 * byte-stability with the alternate-unit value discriminator, and AP-3
 * per-key determinism.
 */
import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { canonicalizeSensorMap } from '../../../src/sensorMap/canonicalizeSensorMap';
import { detectConfigMode } from '../../../src/sensorMap/configMode';
import { CATALOG_V1_BASELINE, CURRENT_CATALOG_VERSION, parseCatalogStamps } from '../../../src/sensorMap/catalogVersion';
import {
  CATALOG_V2_ROWS,
  catalogRowFor,
  defaultRowFor,
  staticDefaultRowFor,
} from '../../../src/sensorMap/defaultMap';
import { toCanonical } from '../../../src/sensorMap/unitConversions';
import type {
  DiscoveryStore,
  EffectiveSensorRow,
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../../../src/sensorMap/types';

const MAC_A = 'AA:BB:CC:DD:EE:01';
const MAC_B = 'AA:BB:CC:DD:EE:02';
const MAC_C = 'AA:BB:CC:DD:EE:03';

const STATIONS_AB: StationInventory = [
  { macAddress: MAC_A, name: 'Home' },
  { macAddress: MAC_B, name: 'Cabin' },
];

function emptyDiscovery(): DiscoveryStore {
  return { schemaVersion: 1, entries: [] };
}
function emptyUiState(): UiStateStore {
  return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}
function input(overrides: unknown[], stamps?: { baseline: number; adopted: number }, stations: StationInventory = STATIONS_AB) {
  return {
    userOverrides: overrides,
    discovery: emptyDiscovery(),
    uiState: emptyUiState(),
    stations,
    configMode: 'v2' as const,
    ...(stamps ? { catalogBaseline: stamps.baseline, catalogAdopted: stamps.adopted } : {}),
  };
}
type ConfiguredRow = Exclude<EffectiveSensorRow, { kind: 'unrecognized' }>;
function configured(map: { rows: EffectiveSensorRow[] }, mac: string, dp: string): ConfiguredRow {
  const r = map.rows.find(x => x.stationMac === mac && x.dataPoint === dp);
  if (!r || r.kind === 'unrecognized') throw new Error(`no configured row for ${mac}|${dp}`);
  return r;
}

// The live preservation fixture (§18.4): an explicit station-scoped
// wind-speed assignment on a dataPoint the v2 catalog later defines.
const WIND_ASSIGNMENT: SensorMapOverride = {
  dataPoint: 'windspdmph_avg10m', stationMac: MAC_A,
  kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph',
  name: 'Wind Speed Average',
};

describe('§18.3 stamp parsing', () => {
  it('both stamps absent is the defined legacy (1, 1) state', () => {
    const r = parseCatalogStamps({});
    expect(r).toEqual({ status: 'ok', stamps: { catalogBaseline: 1, catalogAdopted: 1 } });
  });

  it('a valid pair is preserved as given', () => {
    const r = parseCatalogStamps({ catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION });
    expect(r).toEqual({ status: 'ok', stamps: { catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION } });
  });

  it.each([
    [{ catalogBaseline: 1 }, 'one-sided pair'],
    [{ catalogAdopted: 2 }, 'one-sided pair'],
    [{ catalogBaseline: 0, catalogAdopted: 1 }, 'below 1'],
    [{ catalogBaseline: 1.5, catalogAdopted: 2 }, 'non-integer'],
    [{ catalogBaseline: '1', catalogAdopted: 2 }, 'string'],
    [{ catalogBaseline: 2, catalogAdopted: 1 }, 'baseline above adopted'],
    [{ catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION + 1 }, 'future version'],
    [{ catalogBaseline: null, catalogAdopted: 2 }, 'null'],
  ] as const)('invalid pair %j is refused (%s)', (fields) => {
    expect(parseCatalogStamps(fields as Record<string, unknown>).status).toBe('invalid');
  });
});

describe('§18.3 fail-closed mode detection', () => {
  const V2 = { configVersion: 2, sensorMap: [] };

  it('a v2 config without stamps resolves (1, 1) and stays v2', () => {
    const r = detectConfigMode(V2 as never);
    expect(r.mode).toBe('v2');
    expect(r.catalogBaseline).toBe(1);
    expect(r.catalogAdopted).toBe(1);
  });

  it('a v2 config with a valid pair carries it', () => {
    const r = detectConfigMode({ ...V2, catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION } as never);
    expect(r.mode).toBe('v2');
    expect(r.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);
  });

  it.each([
    { catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION + 7 },
    { catalogBaseline: 'x', catalogAdopted: 1 },
    { catalogAdopted: 1 },
    { catalogBaseline: 2, catalogAdopted: 1 },
  ])('invalid stamps %j enter safe mode with a stamp banner, never cap-and-continue', (fields) => {
    const r = detectConfigMode({ ...V2, ...fields } as never);
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toContain('catalog');
    // Safe mode = the protective posture: the builder emits ZERO rows,
    // so reconciliation cannot unregister anything (§17.2 keeps every
    // cached accessory; only baseline-native bindings get values).
    const map = buildEffectiveSensorMap({ ...input([{ dataPoint: 'windspdmph_avg10m', enabled: true }]), configMode: 'safe-mode' });
    expect(map.rows).toHaveLength(0);
    expect(map.errors).toHaveLength(0);
  });

  it('legacy mode is unaffected by the stamp fields (interpreted at conversion)', () => {
    const r = detectConfigMode({ temperatureSensors: true } as never);
    expect(r.mode).toBe('legacy');
    expect(r.catalogBaseline).toBeUndefined();
  });
});

describe('§18.3 exposure arithmetic', () => {
  it('a new-exposure definition is INVISIBLE below its sinceCatalogVersion', () => {
    expect(staticDefaultRowFor('windspdmph_avg10m')).toBeUndefined();
    expect(catalogRowFor('windspdmph_avg10m', 1)).toBeUndefined();
    expect(catalogRowFor('windspdmph_avg10m', 2)).toBeDefined();
    // Un-adopted config: the pair does not even exist (no discovery).
    const map1 = buildEffectiveSensorMap(input([], { baseline: 1, adopted: 1 }));
    expect(map1.rows.find(r => r.dataPoint === 'windspdmph_avg10m')).toBeUndefined();
  });

  it('adopted new-exposure definitions expand per station and arrive DISABLED (stations B and C)', () => {
    const map = buildEffectiveSensorMap(input([], { baseline: 1, adopted: 2 }));
    for (const mac of [MAC_A, MAC_B]) {
      const row = configured(map, mac, 'windspdmph_avg10m');
      expect(row.enabled).toBe(false);
      expect(row.kind).toBe('motion');
      expect(row.measurement).toBe('wind-speed');
    }
    // Station C, first seen after adoption: same arithmetic, no
    // inventory bookkeeping involved.
    const withC = buildEffectiveSensorMap(input([], { baseline: 1, adopted: 2 },
      [...STATIONS_AB, { macAddress: MAC_C, name: 'New' }]));
    expect(configured(withC, MAC_C, 'windspdmph_avg10m').enabled).toBe(false);
  });

  it('the P2 new-exposure rows ship default-disabled even for a fresh catalog-2 install (their own default)', () => {
    const fresh = buildEffectiveSensorMap(input([], { baseline: 2, adopted: 2 }));
    expect(configured(fresh, MAC_A, 'windspdmph_avg10m').enabled).toBe(false);
    expect(configured(fresh, MAC_A, '24hourrainin').enabled).toBe(false);
  });

  it('an authored enabled: true fragment exposes an adopted definition', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'windgustdir', enabled: true }], { baseline: 1, adopted: 2 }));
    const row = configured(map, MAC_A, 'windgustdir');
    expect(row.enabled).toBe(true);
    expect(row.measurement).toBe('direction');
    expect(map.errors).toHaveLength(0);
  });
});

describe('§18.3 anchored invariant: adopting changes NO effective row', () => {
  const ANCHORED_KEYS = CATALOG_V2_ROWS.filter(r => r.catalogExposure === 'anchored').map(r => r.dataPoint);

  it('every anchored definition is IDENTICAL to the fallback row it anchors', () => {
    expect(ANCHORED_KEYS.length).toBeGreaterThan(0);
    for (const dp of ANCHORED_KEYS) {
      const anchored = catalogRowFor(dp, 2)!;
      const fallback = defaultRowFor(dp)!;
      expect(fallback, `${dp} must be fallback-recognized`).toBeDefined();
      const identity = (r: typeof anchored) => ({
        kind: r.kind, measurement: r.measurement, sourceUnit: r.sourceUnit,
        displayUnit: r.displayUnit, name: r.name, batteryField: r.batteryField,
        canonicalForBattery: r.canonicalForBattery, wrapperId: r.wrapper.id,
      });
      expect(identity(anchored), dp).toEqual(identity(fallback));
    }
  });

  it('anchored definitions never expand pairs — the row universe is unchanged by adoption', () => {
    const before = buildEffectiveSensorMap(input([], { baseline: 1, adopted: 1 }));
    const after = buildEffectiveSensorMap(input([], { baseline: 1, adopted: 2 }));
    const keys = (m: { rows: EffectiveSensorRow[] }) =>
      m.rows.filter(r => ANCHORED_KEYS.includes(r.dataPoint)).map(r => `${r.stationMac}|${r.dataPoint}`);
    expect(keys(before)).toEqual([]);
    expect(keys(after)).toEqual([]);
  });

  it('a discovery-observed anchored key resolves the same effective row before and after adoption', () => {
    const discovery: DiscoveryStore = {
      schemaVersion: 1,
      entries: [{ stationMac: MAC_A, stationName: 'Home', dataPoint: 'feelsLike7', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' }],
    };
    const build = (adopted: number) => buildEffectiveSensorMap({
      ...input([], { baseline: 1, adopted }), discovery,
    });
    const before = configured(build(1), MAC_A, 'feelsLike7');
    const after = configured(build(2), MAC_A, 'feelsLike7');
    expect(after).toEqual(before);
    expect(after.structuralSignature).toBe(before.structuralSignature);
  });
});

describe('§18.4 the Demeter preservation fixture', () => {
  it('the explicit assignment resolves identically before and after adoption (AP-1)', () => {
    const before = buildEffectiveSensorMap(input([WIND_ASSIGNMENT], { baseline: 1, adopted: 1 }));
    const after = buildEffectiveSensorMap(input([WIND_ASSIGNMENT], { baseline: 1, adopted: 2 }));
    const b = configured(before, MAC_A, 'windspdmph_avg10m');
    const a = configured(after, MAC_A, 'windspdmph_avg10m');
    expect(a).toEqual(b);
    expect(a.name).toBe('Wind Speed Average');
    expect(a.enabled).toBe(true);
    expect(before.errors).toHaveLength(0);
    expect(after.errors).toHaveLength(0);
    // Sibling station B resolves the adopted default (disabled) — the
    // station-scoped assignment blocks nothing beyond its own key.
    expect(configured(after, MAC_B, 'windspdmph_avg10m').enabled).toBe(false);
  });

  it('the conflicting-kind variant stays a VALID custom row, never clamped or replaced (AP-2)', () => {
    const conflicting: SensorMapOverride = {
      dataPoint: 'windspdmph_avg10m', stationMac: MAC_A,
      kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent',
      name: 'Odd But Mine',
    };
    const before = buildEffectiveSensorMap(input([conflicting], { baseline: 1, adopted: 1 }));
    const after = buildEffectiveSensorMap(input([conflicting], { baseline: 1, adopted: 2 }));
    expect(before.errors).toHaveLength(0);
    expect(after.errors).toHaveLength(0);
    const a = configured(after, MAC_A, 'windspdmph_avg10m');
    expect(a).toEqual(configured(before, MAC_A, 'windspdmph_avg10m'));
    expect(a.kind).toBe('humidity');
    expect(a.name).toBe('Odd But Mine');
  });

  it('AP-4 value-level discriminator: an authored alternate unit keeps ITS interpretation after adoption', () => {
    const mps: SensorMapOverride = {
      dataPoint: 'windspdmph_avg10m', stationMac: MAC_A,
      kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mps',
      name: 'Metric Wind',
    };
    const after = buildEffectiveSensorMap(input([mps], { baseline: 1, adopted: 2 }));
    const row = configured(after, MAC_A, 'windspdmph_avg10m');
    expect(row.kind === 'unrecognized' || row.measurement === 'timestamp' || row.measurement === 'boolean').toBe(false);
    expect((row as { sourceUnit?: string }).sourceUnit).toBe('mps');
    // The discriminator: 10 mps and 10 mph canonicalize differently,
    // so a silent clamp to the definition's mph would change every
    // rendered value even though the structural signature is the same.
    expect(toCanonical('wind-speed', 'mps', 10)).not.toBe(toCanonical('wind-speed', 'mph', 10));
  });
});

describe('§18.4 AP-2 branch matrix on an adopted definition', () => {
  const ADOPTED = { baseline: 1, adopted: 2 };

  it.each([
    ['rename-only', { dataPoint: 'windspdmph_avg10m', name: 'My Wind' }],
    ['disable-only', { dataPoint: 'windspdmph_avg10m', enabled: false }],
    ['display-unit-only', { dataPoint: 'windspdmph_avg10m', displayUnit: 'kph' }],
  ] as const)('%s inherits the definition identity with no errors and no clamp warns', (_label, fragment) => {
    const map = buildEffectiveSensorMap(input([fragment], ADOPTED));
    expect(map.errors).toHaveLength(0);
    expect(map.warnings.filter(w => w.code.startsWith('ignored-'))).toHaveLength(0);
    const row = configured(map, MAC_A, 'windspdmph_avg10m');
    expect(row.kind).toBe('motion');
    expect(row.measurement).toBe('wind-speed');
  });

  it('an enabled rename resolves the inherited identity with the authored name', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'windspdmph_avg10m', name: 'My Wind', enabled: true }], ADOPTED));
    const row = configured(map, MAC_A, 'windspdmph_avg10m');
    expect(row.name).toBe('My Wind');
    expect(row.enabled).toBe(true);
    expect((row as { sourceUnit?: string }).sourceUnit).toBe('mph');
  });

  it('a partial identity is diagnosed AND blocks the definition default in its scope', () => {
    const partial = { dataPoint: 'windspdmph_avg10m', stationMac: MAC_A, sourceUnit: 'mps' };
    const map = buildEffectiveSensorMap(input([partial], ADOPTED));
    // Diagnosed with the custom-missing family, exactly as before the
    // definition existed — never completed from the catalog.
    expect(map.errors.map(e => e.code)).toContain('custom-missing-kind');
    // The fragment's scope produces NO row from the definition; the
    // sibling station still resolves the (disabled) default.
    expect(map.rows.find(r => r.stationMac === MAC_A && r.dataPoint === 'windspdmph_avg10m')).toBeUndefined();
    const b = configured(map, MAC_B, 'windspdmph_avg10m');
    expect(b.enabled).toBe(false);
  });

  it('a GLOBAL partial identity blocks the definition on every station', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'windspdmph_avg10m', sourceUnit: 'mps' }], ADOPTED));
    expect(map.errors.map(e => e.code)).toContain('custom-missing-kind');
    expect(map.rows.filter(r => r.dataPoint === 'windspdmph_avg10m')).toHaveLength(0);
  });

  it('the same partial fragment behaves identically before the definition existed', () => {
    const partial = { dataPoint: 'windspdmph_avg10m', stationMac: MAC_A, sourceUnit: 'mps' };
    const before = buildEffectiveSensorMap(input([partial], { baseline: 1, adopted: 1 }));
    expect(before.errors.map(e => e.code)).toContain('custom-missing-kind');
    expect(before.rows.filter(r => r.dataPoint === 'windspdmph_avg10m')).toHaveLength(0);
  });

  it('the v1 clamp is untouched: authored measurement on a BASELINE dataPoint still strips with a warn', () => {
    const map = buildEffectiveSensorMap(input(
      [{ dataPoint: 'tempf', measurement: 'humidity' }], ADOPTED));
    expect(map.warnings.map(w => w.code)).toContain('ignored-measurement-fixed');
    expect(configured(map, MAC_A, 'tempf').measurement).toBe('temperature');
  });
});

describe('§18.4 AP-4 byte-stability across the upgrade (un-adopted config)', () => {
  it('canonicalization of the preservation fixture is identical with and without stamps threaded', () => {
    const common = { stations: STATIONS_AB, discovery: emptyDiscovery(), uiState: emptyUiState() };
    const preUpgradeShape = canonicalizeSensorMap({ overrides: [WIND_ASSIGNMENT], ...common });
    const unadopted = canonicalizeSensorMap({
      overrides: [WIND_ASSIGNMENT], ...common, catalogBaseline: 1, catalogAdopted: 1,
    });
    expect(JSON.stringify(unadopted)).toBe(JSON.stringify(preUpgradeShape));
  });

  it('effective rows and signatures of an un-adopted config are unchanged by the catalog shipping', () => {
    // The un-adopted world must equal the stamp-less (pre-P2 semantics)
    // world for EVERY row, signatures included.
    const overrides = [WIND_ASSIGNMENT, { dataPoint: 'tempf', name: 'Yard' }];
    const withStamps = buildEffectiveSensorMap(input(overrides, { baseline: 1, adopted: 1 }));
    const withoutStamps = buildEffectiveSensorMap(input(overrides));
    expect(withStamps.rows).toEqual(withoutStamps.rows);
  });
});

describe('§18.4 AP-3 per-key determinism across missing observations', () => {
  it('keys present with and without inventory resolve identical decisions; the row universe differs separately', () => {
    const overrides = [WIND_ASSIGNMENT, { dataPoint: 'windgustdir', enabled: true }];
    const withInventory = buildEffectiveSensorMap(input(overrides, { baseline: 1, adopted: 2 }));
    const noInventory = buildEffectiveSensorMap(input(overrides, { baseline: 1, adopted: 2 }, []));

    const byKey = (m: { rows: EffectiveSensorRow[] }) =>
      new Map(m.rows.map(r => [`${r.stationMac}|${r.dataPoint}`, r]));
    const withMap = byKey(withInventory);
    const withoutMap = byKey(noInventory);
    // Every key that exists in BOTH resolutions is decision-identical.
    let shared = 0;
    for (const [key, row] of withoutMap) {
      const other = withMap.get(key);
      if (other) {
        shared += 1;
        expect(other, key).toEqual(row);
      }
    }
    // The explicit station assignment exists in both worlds (its key
    // comes from the override, not from inventory).
    expect(withoutMap.has(`${MAC_A}|windspdmph_avg10m`)).toBe(true);
    expect(shared).toBeGreaterThan(0);
    // Row-universe difference is legitimate and asserted separately:
    // inventory expands defaults per station.
    expect(withMap.size).toBeGreaterThan(withoutMap.size);
  });
});

describe('catalog constants', () => {
  it('the shipped catalog version is 2 and the baseline constant is 1', () => {
    expect(CURRENT_CATALOG_VERSION).toBe(2);
    expect(CATALOG_V1_BASELINE).toBe(1);
  });

  it('every CATALOG_V2_ROWS entry is stamp-gated, non-canonical for batteries, and outside the v1 static table', () => {
    for (const row of CATALOG_V2_ROWS) {
      expect(row.sinceCatalogVersion, row.dataPoint).toBe(2);
      expect(row.canonicalForBattery, row.dataPoint).toBe(false);
      expect(staticDefaultRowFor(row.dataPoint), `${row.dataPoint} must not be in the v1 table`).toBeUndefined();
      expect(['anchored', 'new']).toContain(row.catalogExposure);
    }
  });
});

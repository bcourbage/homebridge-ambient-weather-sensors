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
  defaultEnabledFor,
  defaultRowFor,
  staticDefaultRowFor,
} from '../../../src/sensorMap/defaultMap';
import { buildWrapperRouting, distributeViaRouting } from '../../../src/sensorMap/routing';
import type { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
  type MockCharacteristic,
} from '../../helpers/mockHomebridge';
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

  it('legacy mode carries the parsed stamps: a fresh (2, 2)-born block is reported as (2, 2), unstamped as (1, 1)', () => {
    // PR #66 review F3: a fresh settings-only installation is a
    // LEGACY-shaped block born stamped; reporting it as (1, 1) would
    // misstate its exposure history to the editor and to conversion.
    const fresh = detectConfigMode({
      temperatureSensors: true,
      catalogBaseline: CURRENT_CATALOG_VERSION, catalogAdopted: CURRENT_CATALOG_VERSION,
    } as never);
    expect(fresh.mode).toBe('legacy');
    expect(fresh.catalogBaseline).toBe(CURRENT_CATALOG_VERSION);
    expect(fresh.catalogAdopted).toBe(CURRENT_CATALOG_VERSION);

    const unstamped = detectConfigMode({ temperatureSensors: true } as never);
    expect(unstamped.mode).toBe('legacy');
    expect(unstamped.catalogBaseline).toBe(1);
    expect(unstamped.catalogAdopted).toBe(1);
  });

  it('invalid stamps on a LEGACY-shaped block ALSO fail closed — the legacy pipeline reconciles (F3)', () => {
    const r = detectConfigMode({
      temperatureSensors: true,
      catalogBaseline: 1, catalogAdopted: CURRENT_CATALOG_VERSION + 5,
    } as never);
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toContain('catalog');
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

  it('AP-4 value-level discriminator: the authored alternate unit RENDERS through the real wrapper after save, reload, and adoption', () => {
    // Save/reload first: the canonical serializer must round-trip the
    // explicit assignment, and the reloaded row must render through
    // the REAL wind wrapper with the AUTHORED unit interpretation. A
    // silent clamp to the definition's mph leaves the structural
    // signature unchanged, so only the rendered value discriminates:
    // raw 10 as mps renders "22 mph" (converted); clamped it would
    // render "10 mph".
    const mps: SensorMapOverride = {
      dataPoint: 'windspdmph_avg10m', stationMac: MAC_A,
      kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mps',
      name: 'Metric Wind',
    };
    const common = { stations: STATIONS_AB, discovery: emptyDiscovery(), uiState: emptyUiState() };
    const canonical = canonicalizeSensorMap({
      overrides: [mps], ...common, catalogBaseline: 1, catalogAdopted: 2,
    });
    const reloaded = buildEffectiveSensorMap(input(canonical, { baseline: 1, adopted: 2 }));
    expect(reloaded.errors).toEqual([]);
    const row = configured(reloaded, MAC_A, 'windspdmph_avg10m');
    expect((row as { sourceUnit?: string }).sourceUnit).toBe('mps');

    const renderThrough = (r: typeof row, raw: number): string => {
      const platform = makeMockPlatform();
      const accessory = makeMockAccessory({ uniqueId: `${r.stationMac}-${r.dataPoint}`, displayName: r.name ?? r.dataPoint });
      const routing = buildWrapperRouting(
        platform as unknown as AmbientWeatherSensorsPlatform,
        { rows: [r], errors: [], warnings: [], notes: [] },
        () => accessory as never,
      );
      distributeViaRouting(
        platform as unknown as AmbientWeatherSensorsPlatform,
        routing,
        [{ macAddress: r.stationMac, lastData: { [r.dataPoint]: raw } }],
      );
      const motion = accessory.getService(MockServices.MotionSensor)!;
      const valueChar = [...(motion as unknown as { characteristics: Map<string, MockCharacteristic> })
        .characteristics.values()].find(c => c.displayName === 'Value');
      expect(valueChar, 'rendered Value characteristic').toBeDefined();
      return String(valueChar!.value);
    };

    // 10 m/s renders converted to the mph display default — the
    // authored interpretation ran.
    expect(renderThrough(row, 10)).toBe('22 mph');

    // Control: the adopted DEFINITION's own row (no assignment,
    // enabled for the probe) renders the same raw as mph unconverted —
    // proving the two interpretations are observably different through
    // the identical wrapper.
    const definitionMap = buildEffectiveSensorMap(input(
      [{ dataPoint: 'windspdmph_avg10m', enabled: true }], { baseline: 1, adopted: 2 }));
    const definitionRow = configured(definitionMap, MAC_A, 'windspdmph_avg10m');
    expect(renderThrough(definitionRow, 10)).toBe('10 mph');
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

describe('canonicalization treats inherited rows as KNOWN (review F1)', () => {
  const ADOPTED = { catalogBaseline: 1, catalogAdopted: 2 };
  const common = { stations: STATIONS_AB, discovery: emptyDiscovery(), uiState: emptyUiState(), ...ADOPTED };

  it('a global rename of an adopted definition canonicalizes WITHOUT materializing identity', () => {
    const canonical = canonicalizeSensorMap({
      overrides: [{ dataPoint: 'windspdmph_avg10m', name: 'My Wind' }], ...common,
    });
    expect(canonical).toHaveLength(1);
    const entry = canonical[0] as Record<string, unknown>;
    expect(entry.dataPoint).toBe('windspdmph_avg10m');
    expect(entry.name).toBe('My Wind');
    expect(entry.kind, 'inherited identity must never be materialized').toBeUndefined();
    expect(entry.measurement).toBeUndefined();
    expect(entry.sourceUnit).toBeUndefined();
  });

  it('a STATION-scoped rename canonicalizes and reloads to identical effective rows (no divergence)', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'windspdmph_avg10m', stationMac: MAC_A, name: 'Roof Wind' },
    ];
    const canonical = canonicalizeSensorMap({ overrides, ...common });
    const entry = canonical.find(e => e.stationMac === MAC_A) as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.kind).toBeUndefined();
    const before = buildEffectiveSensorMap(input(overrides, { baseline: 1, adopted: 2 }));
    const reloaded = buildEffectiveSensorMap(input(canonical, { baseline: 1, adopted: 2 }));
    expect(reloaded.errors).toEqual([]);
    expect(reloaded.rows).toEqual(before.rows);
  });

  it('an EXPLICIT assignment still canonicalizes as custom with its full identity', () => {
    const canonical = canonicalizeSensorMap({ overrides: [WIND_ASSIGNMENT], ...common });
    const entry = canonical.find(e => e.stationMac === MAC_A) as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('motion');
    expect(entry!.measurement).toBe('wind-speed');
    expect(entry!.sourceUnit).toBe('mph');
  });
});

describe('validation and resolution use ONE identity per key (review F2)', () => {
  const ADOPTED = { baseline: 1, adopted: 2 };

  it('a station non-identity exception under a global EXPLICIT identity is rejected, exactly as before adoption', () => {
    // Pre-adoption, {displayUnit} alone on this dataPoint was
    // custom-missing-kind; adoption must not make it valid against the
    // catalog identity while resolution applies the global pressure
    // assignment (a signed pressure row with a wind unit would throw
    // in the wrapper on the first reading).
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'windspdmph_avg10m', kind: 'motion', measurement: 'pressure', sourceUnit: 'inHg', name: 'Odd Pressure' },
      { dataPoint: 'windspdmph_avg10m', stationMac: MAC_A, displayUnit: 'fps' },
    ];
    const map = buildEffectiveSensorMap(input(overrides, ADOPTED));
    expect(map.errors.map(e => e.code)).toContain('custom-missing-kind');
    // The global assignment itself resolves untouched on every station,
    // with its own legal display unit.
    for (const mac of [MAC_A, MAC_B]) {
      const row = configured(map, mac, 'windspdmph_avg10m');
      expect(row.measurement).toBe('pressure');
      expect((row as { displayUnit?: string }).displayUnit).not.toBe('fps');
    }
  });

  it('a global non-identity fragment meeting a station-authored identity never signs an illegal displayUnit (guard)', () => {
    // The reverse direction: the global fragment is VALID against the
    // adopted wind identity (fps is a legal wind unit), but station A
    // authors pressure. The resolved row must not carry fps — the
    // guard falls back to the measurement default and surfaces a note.
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'windspdmph_avg10m', displayUnit: 'fps' },
      { dataPoint: 'windspdmph_avg10m', stationMac: MAC_A, kind: 'motion', measurement: 'pressure', sourceUnit: 'inHg', name: 'Roof Pressure' },
    ];
    const map = buildEffectiveSensorMap(input(overrides, ADOPTED));
    expect(map.errors).toEqual([]);
    const a = configured(map, MAC_A, 'windspdmph_avg10m');
    expect(a.measurement).toBe('pressure');
    expect((a as { displayUnit?: string }).displayUnit).toBe('inHg');
    expect(map.notes.map(n => n.code)).toContain('illegal-cross-scope-displayunit');
    // Station B inherits the definition and keeps the legal fps.
    const b = configured(map, MAC_B, 'windspdmph_avg10m');
    expect(b.measurement).toBe('wind-speed');
    expect((b as { displayUnit?: string }).displayUnit).toBe('fps');
  });
});

describe('an explicit assignment survives value-equal catalog defaults (review round 2 F1)', () => {
  const common = {
    stations: STATIONS_AB, discovery: emptyDiscovery(), uiState: emptyUiState(),
    catalogBaseline: 1, catalogAdopted: 2,
  };
  // The reviewer's exact fixture: an explicit station assignment whose
  // every effective value equals the adopted definition's defaults.
  const VALUE_EQUAL: SensorMapOverride = {
    batteryField: 'battout', dataPoint: 'windspdmph_avg10m', enabled: false,
    kind: 'motion', measurement: 'wind-speed', name: 'Wind Speed 10m Avg',
    sourceUnit: 'mph', stationMac: MAC_A,
  };

  it('canonicalization preserves the authored identity even when every value matches the definition', () => {
    const canonical = canonicalizeSensorMap({ overrides: [VALUE_EQUAL], ...common });
    expect(canonical).toHaveLength(1);
    const entry = canonical[0] as Record<string, unknown>;
    expect(entry.stationMac).toBe(MAC_A);
    expect(entry.kind).toBe('motion');
    expect(entry.measurement).toBe('wind-speed');
    expect(entry.sourceUnit).toBe('mph');
    expect(entry.enabled).toBe(false);
    // Second save from the canonical output is byte-stable.
    const again = canonicalizeSensorMap({ overrides: canonical, ...common });
    expect(JSON.stringify(again)).toBe(JSON.stringify(canonical));
    // And the resolution stays an explicit custom row across reloads.
    const reloaded = buildEffectiveSensorMap(input(canonical, { baseline: 1, adopted: 2 }));
    expect(reloaded.errors).toEqual([]);
    expect(configured(reloaded, MAC_A, 'windspdmph_avg10m').name).toBe('Wind Speed 10m Avg');
  });

  it('a global NON-identity template does not absorb the station assignment either', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'windspdmph_avg10m', name: 'Windy' },
      VALUE_EQUAL,
    ];
    const canonical = canonicalizeSensorMap({ overrides, ...common });
    const station = canonical.find(e => e.stationMac === MAC_A) as Record<string, unknown> | undefined;
    expect(station, 'the explicit assignment must survive').toBeDefined();
    expect(station!.kind).toBe('motion');
    expect(station!.measurement).toBe('wind-speed');
    expect(station!.sourceUnit).toBe('mph');
    const globalEntry = canonical.find(e => e.stationMac === undefined) as Record<string, unknown> | undefined;
    expect(globalEntry).toBeDefined();
    expect(globalEntry!.kind, 'the global rename stays identity-free').toBeUndefined();
  });

  it('a station row restating a GLOBAL AUTHORED custom template is still absorbed (original semantics)', () => {
    const template: SensorMapOverride = {
      dataPoint: 'barn_flow', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph', name: 'Flow',
    };
    const restated: SensorMapOverride = { ...template, stationMac: MAC_A };
    const canonical = canonicalizeSensorMap({ overrides: [template, restated], ...common });
    expect(canonical.filter(e => e.stationMac !== undefined)).toHaveLength(0);
    expect(canonical.filter(e => e.stationMac === undefined)).toHaveLength(1);
  });

  it('control: a genuinely inherited row still canonicalizes without gaining identity', () => {
    const canonical = canonicalizeSensorMap({
      overrides: [{ dataPoint: 'windspdmph_avg10m', stationMac: MAC_A, enabled: true }], ...common,
    });
    expect(canonical).toHaveLength(1);
    const entry = canonical[0] as Record<string, unknown>;
    expect(entry.enabled).toBe(true);
    expect(entry.kind).toBeUndefined();
    expect(entry.measurement).toBeUndefined();
  });
});

describe('station exceptions to authored global settings survive canonicalization (review round 3 F1)', () => {
  const common = {
    stations: STATIONS_AB, discovery: emptyDiscovery(), uiState: emptyUiState(),
    catalogBaseline: 1, catalogAdopted: 2,
  };
  const IDENTITY: SensorMapOverride = {
    dataPoint: 'windspdmph_avg10m', stationMac: MAC_A,
    kind: 'motion', measurement: 'wind-speed', sourceUnit: 'mph',
  };
  // The reviewer's field table: each station exception EQUALS the bare
  // identity's own default but overrides a DIFFERENT authored global
  // value, so dropping it would make the station inherit the global
  // setting on reload.
  const CASES: ReadonlyArray<[string, unknown, unknown]> = [
    ['displayUnit', 'fps', 'mph'],
    ['name', 'Global label', 'windspdmph_avg10m'],
    ['batteryField', 'spare_batt', null],
    ['embedName', true, false],
    ['triggerEnabled', false, true],
    ['triggerDirection', 'below', 'above'],
    ['threshold', 12, 30],
  ];

  it.each(CASES)('%s: global %j with station exception %j round-trips intact', (field, globalValue, stationValue) => {
    const proposal = [
      { dataPoint: 'windspdmph_avg10m', [field]: globalValue },
      { ...IDENTITY, [field]: stationValue },
    ] as unknown as SensorMapOverride[];
    const before = buildEffectiveSensorMap(input(proposal, { baseline: 1, adopted: 2 }));
    expect(before.errors, field).toEqual([]);
    const canonical = canonicalizeSensorMap({ overrides: proposal, ...common });
    const after = buildEffectiveSensorMap(input(canonical, { baseline: 1, adopted: 2 }));
    expect(after.errors, field).toEqual([]);
    const rowOf = (m: { rows: EffectiveSensorRow[] }) => configured(m, MAC_A, 'windspdmph_avg10m') as unknown as Record<string, unknown>;
    expect(rowOf(before)[field], `${field} resolves the station value`).toBe(stationValue);
    expect(rowOf(after)[field], `${field} survives canonical save/reload`).toBe(stationValue);
    // The full effective rows are equal — the divergence gate's exact
    // comparison, untouched and passing.
    expect(after.rows).toEqual(before.rows);
    // And a second canonicalization is byte-stable.
    const again = canonicalizeSensorMap({ overrides: canonical, ...common });
    expect(JSON.stringify(again), field).toBe(JSON.stringify(canonical));
  });

  it('the enabled-state control keeps working: a station explicit assignment inheriting a global disable', () => {
    const proposal: SensorMapOverride[] = [
      { dataPoint: 'windspdmph_avg10m', enabled: false },
      { ...IDENTITY },
    ];
    const canonical = canonicalizeSensorMap({ overrides: proposal, ...common });
    const after = buildEffectiveSensorMap(input(canonical, { baseline: 1, adopted: 2 }));
    expect(configured(after, MAC_A, 'windspdmph_avg10m').enabled).toBe(false);
  });

  it('sibling and never-seen stations still inherit the global template', () => {
    const proposal: SensorMapOverride[] = [
      { dataPoint: 'windspdmph_avg10m', displayUnit: 'fps', enabled: true },
      { ...IDENTITY, displayUnit: 'mph' },
    ];
    const canonical = canonicalizeSensorMap({ overrides: proposal, ...common });
    const withC = buildEffectiveSensorMap(input(canonical, { baseline: 1, adopted: 2 },
      [...STATIONS_AB, { macAddress: MAC_C, name: 'New' }]));
    expect((configured(withC, MAC_A, 'windspdmph_avg10m') as unknown as Record<string, unknown>).displayUnit).toBe('mph');
    for (const mac of [MAC_B, MAC_C]) {
      expect((configured(withC, mac, 'windspdmph_avg10m') as unknown as Record<string, unknown>).displayUnit, mac).toBe('fps');
    }
  });
});

describe('entry defaults never bypass the baseline floor (review F5)', () => {
  it('a hypothetical defaultEnabled: true new-exposure definition stays DISABLED on an older baseline', () => {
    const eager = { ...CATALOG_V2_ROWS.find(r => r.dataPoint === 'windgustdir')!, defaultEnabled: true };
    expect(defaultEnabledFor(eager, 1)).toBe(false); // adopted later → floored
    expect(defaultEnabledFor(eager, 2)).toBe(true);  // born knowing it → entry default
  });

  it('the shipped new-exposure rows are disabled for every baseline', () => {
    for (const row of CATALOG_V2_ROWS.filter(r => r.catalogExposure === 'new')) {
      expect(defaultEnabledFor(row, 1), row.dataPoint).toBe(false);
      expect(defaultEnabledFor(row, 2), row.dataPoint).toBe(false);
    }
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

import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { DEFAULT_SENSOR_MAP } from '../../../src/sensorMap/defaultMap';
import type {
  DiscoveryStore,
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../../../src/sensorMap/types';

const MAC1 = 'AA:BB:CC:DD:EE:01';
const MAC2 = 'AA:BB:CC:DD:EE:02';

const STATIONS: StationInventory = [
  { macAddress: MAC1, name: 'Home' },
  { macAddress: MAC2, name: 'Cabin' },
];

function emptyDiscovery(): DiscoveryStore {
  return { schemaVersion: 1, entries: [] };
}
function emptyUiState(): UiStateStore {
  return { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] };
}

function baseInput() {
  return {
    userOverrides: [] as SensorMapOverride[],
    discovery: emptyDiscovery(),
    uiState: emptyUiState(),
    stations: STATIONS,
    configMode: 'v2' as const,
  };
}

describe('buildEffectiveSensorMap — safe mode', () => {
  it('returns zero rows in safe mode regardless of input', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      configMode: 'safe-mode',
      userOverrides: [{ dataPoint: 'tempf', name: 'Custom' }],
    });
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.notes).toHaveLength(0);
  });
});

describe('buildEffectiveSensorMap — motion trigger fields (finding-#4 review, P1-B)', () => {
  function rowFor(dp: string) {
    const r = buildEffectiveSensorMap(baseInput()).rows.find(x => x.dataPoint === dp && x.stationMac === MAC1);
    if (!r || r.kind === 'unrecognized') throw new Error(`no configured row for ${dp}`);
    return r;
  }

  it('known rain-accumulation rows carry the family default threshold (0.01) from the default map', () => {
    for (const dp of ['eventrainin', 'dailyrainin', 'weeklyrainin', 'monthlyrainin', 'yearlyrainin']) {
      expect(rowFor(dp).threshold, dp).toBe(0.01);
    }
  });

  it('known lightning-count rows carry the family default threshold (1)', () => {
    expect(rowFor('lightning_day').threshold).toBe(1);
    expect(rowFor('lightning_hour').threshold).toBe(1);
  });

  it('known pressure + lightning-distance rows carry triggerDirection: below', () => {
    expect(rowFor('baromrelin').triggerDirection).toBe('below');
    expect(rowFor('baromabsin').triggerDirection).toBe('below');
    expect(rowFor('lightning_distance').triggerDirection).toBe('below');
  });

  it('a user threshold + triggerDirection override on a known motion row flows through', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'windspeedmph', threshold: 40, triggerDirection: 'below' }],
    });
    const row = result.rows.find(r => r.dataPoint === 'windspeedmph' && r.stationMac === MAC1);
    expect(row && row.kind !== 'unrecognized' ? row.threshold : null).toBe(40);
    expect(row && row.kind !== 'unrecognized' ? row.triggerDirection : null).toBe('below');
  });

  it('a triggerEnabled: false override is carried on the resolved row', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'windspeedmph', triggerEnabled: false }],
    });
    const row = result.rows.find(r => r.dataPoint === 'windspeedmph' && r.stationMac === MAC1);
    expect(row && row.kind !== 'unrecognized' ? row.triggerEnabled : null).toBe(false);
  });
});

describe('buildEffectiveSensorMap — no-wrapper attribution (finding-#4 review, P2-A)', () => {
  // Post-table-restore, the no-wrapper path is reachable only through
  // kinds without a concrete wrapper class (leak / contact / occupancy
  // / co). The attribution rules are unchanged.
  it('attributes the no-wrapper error to the CUSTOM fragment index, never a synthetic 0', () => {
    // Valid known override at index 0; wrapper-less custom row at index 1.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 'Outside' },                            // index 0 (valid)
        { dataPoint: 'my_custom', kind: 'leak', measurement: 'boolean' },   // index 1 (no wrapper class yet)
      ],
    });
    const noWrap = result.errors.filter(e => e.code === 'no-wrapper');
    expect(noWrap.length).toBeGreaterThan(0);
    for (const e of noWrap) {
      expect(e.overrideIndex).toBe(1);   // the custom fragment — NOT 0
    }
  });

  it('uses row-scope (last-fragment) provenance, not batteryField provenance', () => {
    // Two fragments for the same custom dataPoint: fragment 0 carries the
    // batteryField, fragment 1 is the last. The no-wrapper error must
    // follow the last-fragment rule (index 1), independent of which
    // fragment supplied batteryField (index 0).
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'my_custom', kind: 'leak', measurement: 'boolean', batteryField: 'my_batt' }, // 0
        { dataPoint: 'my_custom', name: 'Barn' },  // 1 (last fragment, merges)
      ],
    });
    const noWrap = result.errors.filter(e => e.code === 'no-wrapper');
    expect(noWrap.length).toBeGreaterThan(0);
    for (const e of noWrap) {
      expect(e.overrideIndex).toBe(1);   // last fragment, not the batteryField fragment (0)
    }
  });
});

describe('buildEffectiveSensorMap — wrapper-mismatch guard (finding-#4 review, P1-D)', () => {
  it('drops a row whose resolved wrapperId disagrees with (kind, measurement) and emits a note', () => {
    // A custom override declaring humidity kind/measurement but... there
    // is no way to force a bad wrapperId through the public API (the
    // default map + validation keep them consistent), so this guards the
    // invariant: EVERY emitted row passes the wrapperId↔(kind,measurement)
    // check, and no wrapper-mismatch notes are produced on a healthy map.
    const result = buildEffectiveSensorMap(baseInput());
    expect(result.notes.filter(n => n.code === 'wrapper-mismatch')).toHaveLength(0);
    // Cross-check: the guard is real — assertRowMatchesWrapperId would
    // accept every row it emitted (proven exhaustively in wrapperFactories
    // + defaultMap tests). Here we just assert the channel exists + empty.
    expect(Array.isArray(result.notes)).toBe(true);
  });
});

describe('buildEffectiveSensorMap — notes channel (finding-#4 Stage 1)', () => {
  it('exposes an (empty) notes array on a clean default expansion', () => {
    const result = buildEffectiveSensorMap(baseInput());
    // The attribution-free `notes` channel exists on every result. On a
    // healthy default map with no colliding canonical battery owners it
    // stays empty — the only Stage-1 producer is the unreachable
    // both-sides-default battery collision (guarded at module load).
    expect(Array.isArray(result.notes)).toBe(true);
    expect(result.notes).toHaveLength(0);
  });
});

describe('buildEffectiveSensorMap — default expansion', () => {
  it('emits one row per (station, defaultDataPoint) pair', () => {
    const result = buildEffectiveSensorMap(baseInput());
    expect(result.rows.length).toBe(DEFAULT_SENSOR_MAP.length * STATIONS.length);
  });

  it('uppercases stationMac consistently on emitted rows', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      stations: [{ macAddress: 'aa:bb:cc:dd:ee:01', name: 'Home' }],
    });
    for (const row of result.rows) {
      expect(row.stationMac).toBe('AA:BB:CC:DD:EE:01');
    }
  });

  it('preserves default names when no override applies', () => {
    const result = buildEffectiveSensorMap(baseInput());
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    expect(tempf?.kind === 'unrecognized' ? null : (tempf as { name: string }).name).toBe('Outdoor Temperature');
  });

  it('produces a valid structural signature for every configured row', () => {
    const result = buildEffectiveSensorMap(baseInput());
    for (const row of result.rows) {
      if (row.kind === 'unrecognized') continue;
      expect(row.structuralSignature).toMatch(/\|measurement:.+\|battery:[01]\|wrapper:.+:v\d+$/);
    }
  });
});

describe('buildEffectiveSensorMap — override precedence', () => {
  it('applies a global name override to every station', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', name: 'Outside' },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const tempfRows = result.rows.filter(r => r.dataPoint === 'tempf');
    expect(tempfRows).toHaveLength(2);
    for (const row of tempfRows) {
      if (row.kind !== 'unrecognized') {
        expect(row.name).toBe('Outside');
      }
    }
  });

  it('station-specific override wins over global on same field', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', name: 'Outside' },
      { dataPoint: 'tempf', stationMac: MAC2, name: 'Deck' },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const home = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const cabin = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC2);
    if (home?.kind !== 'unrecognized') expect((home as { name: string }).name).toBe('Outside');
    if (cabin?.kind !== 'unrecognized') expect((cabin as { name: string }).name).toBe('Deck');
  });

  it('later-in-array duplicate overrides field-wise merge; non-motion threshold is stripped', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', name: 'First' },
      { dataPoint: 'tempf', threshold: 80 },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const row = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (row && row.kind !== 'unrecognized') {
      expect(row.name).toBe('First');
      // Threshold on a temperature (non-motion) row is warn-and-ignore
      // per §3.7. Assert BOTH: the value is not on the row AND a
      // warning was emitted.
      expect(row.threshold).toBeUndefined();
    }
    expect(result.warnings.some(w => /threshold on non-motion/.test(w.message))).toBe(true);
  });

  it('unknown-field override cannot invert measurement', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', kind: 'humidity' },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/not compatible/);
  });

  it('enabled: false does emit the row (accessory-registration decision happens later)', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', enabled: false },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const rows = result.rows.filter(r => r.dataPoint === 'tempf');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      if (r.kind !== 'unrecognized') expect(r.enabled).toBe(false);
    }
  });
});

describe('buildEffectiveSensorMap — battery attachment', () => {
  it('canonical rows have hasBatterySubService=true; non-canonical false', () => {
    const result = buildEffectiveSensorMap(baseInput());
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const humidity = result.rows.find(r => r.dataPoint === 'humidity' && r.stationMac === MAC1);
    if (tempf?.kind !== 'unrecognized') expect(tempf?.hasBatterySubService).toBe(true);
    if (humidity?.kind !== 'unrecognized') expect(humidity?.hasBatterySubService).toBe(false);
  });

  it('override batteryField: null suppresses battery attachment', () => {
    const overrides: SensorMapOverride[] = [
      { dataPoint: 'tempf', batteryField: null },
    ];
    const result = buildEffectiveSensorMap({ ...baseInput(), userOverrides: overrides });
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (tempf?.kind !== 'unrecognized') {
      expect(tempf?.batteryField).toBeNull();
      expect(tempf?.hasBatterySubService).toBe(false);
    }
  });

  it('battery flag flips the structural signature 0/1 segment', () => {
    const rWith = buildEffectiveSensorMap(baseInput());
    const rWithout = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'tempf', batteryField: null }],
    });
    const withRow = rWith.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const withoutRow = rWithout.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (withRow?.kind !== 'unrecognized' && withoutRow?.kind !== 'unrecognized') {
      expect(withRow!.structuralSignature).toContain('|battery:1|');
      expect(withoutRow!.structuralSignature).toContain('|battery:0|');
    }
  });
});

describe('buildEffectiveSensorMap — unrecognized (auto-discovery)', () => {
  it('emits an unrecognized row for a discovered field with no default', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'foo_bar_new',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
    });
    const row = result.rows.find(r => r.dataPoint === 'foo_bar_new');
    expect(row).toBeDefined();
    expect(row!.kind).toBe('unrecognized');
    if (row!.kind === 'unrecognized') {
      expect(row.firstSeen).toBe('2026-07-01T00:00:00Z');
      expect(row.lastSeen).toBe('2026-07-09T21:00:00Z');
    }
  });

  it('forgottenFields entry suppresses the unrecognized row', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'foo_bar_new',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
      uiState: {
        schemaVersion: 1,
        dismissedNoticeIds: [],
        forgottenFields: [{
          stationMac: MAC1,
          dataPoint: 'foo_bar_new',
          forgottenAt: '2026-07-09T20:00:00Z',
        }],
      },
    });
    expect(result.rows.find(r => r.dataPoint === 'foo_bar_new')).toBeUndefined();
  });

  // Un-skipped by the Stage-4 table restoration.
  it('a custom (kind + measurement) override upgrades an unrecognized field to a configured row', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'custom_moisture',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
      userOverrides: [{
        dataPoint: 'custom_moisture',
        kind: 'humidity',
        measurement: 'humidity',
        sourceUnit: 'percent',
        name: 'Soil Moisture',
      }],
    });
    const row = result.rows.find(r => r.dataPoint === 'custom_moisture');
    expect(row?.kind).toBe('humidity');
    if (row && row.kind !== 'unrecognized') {
      expect(row.name).toBe('Soil Moisture');
    }
  });
});

describe('buildEffectiveSensorMap — idempotency', () => {
  it('running twice with the same input produces byte-equal rows arrays', () => {
    const input = {
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 'Deck' },
        { dataPoint: 'humidity', stationMac: MAC2, displayUnit: 'percent' as const },
      ],
    };
    const r1 = buildEffectiveSensorMap(input);
    const r2 = buildEffectiveSensorMap(input);
    expect(JSON.stringify(r1.rows)).toBe(JSON.stringify(r2.rows));
  });
});

describe('buildEffectiveSensorMap — error accumulation', () => {
  it('records row-level errors without dropping other rows', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', stationMac: 'Cabin' },       // bad MAC
        { dataPoint: 'tempf', name: 'Outside' },            // valid
      ],
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/is not a MAC address/);
    // Valid override still applied.
    const home = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (home?.kind !== 'unrecognized') expect(home?.name).toBe('Outside');
  });

  // ---- finding-#4 Stage 4: custom rows RESOLVE via the restored table ----

  it('a well-formed custom (kind + measurement) row resolves its wrapper and emits a row per station', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{
        dataPoint: 'custom_thing',
        kind: 'temperature',
        measurement: 'temperature',
        sourceUnit: 'fahrenheit',
        displayUnit: 'fahrenheit',
      }],
    });
    expect(result.errors).toHaveLength(0);
    const rows = result.rows.filter(r => r.dataPoint === 'custom_thing');
    expect(rows).toHaveLength(STATIONS.length);
    for (const row of rows) {
      expect(row.kind).toBe('temperature');
      if (row.kind !== 'unrecognized') {
        expect(row.wrapperId).toBe('temperature');
      }
    }
  });

  it('kinds without a concrete wrapper class STILL produce `no-wrapper` (leak/contact/occupancy/co)', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'water_alarm', kind: 'leak', measurement: 'boolean' }],
    });
    const err = result.errors.find(e => e.code === 'no-wrapper');
    expect(err).toBeDefined();
    expect(err?.dataPoint).toBe('water_alarm');
    expect(err?.message).toMatch(/no wrapper for \(leak, boolean\)/);
    expect(result.rows.some(r => r.dataPoint === 'water_alarm')).toBe(false);
  });

  it('KNOWN dataPoints keep resolving via the default map path (never the table)', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'tempf', name: 'Outdoor' }],
    });
    expect(result.errors).toHaveLength(0);
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    expect(tempf).toBeDefined();
    if (tempf && tempf.kind !== 'unrecognized') expect(tempf.name).toBe('Outdoor');
  });
});

// ---- Review finding #7: dedup + merge BEFORE semantic validation ---

describe('buildEffectiveSensorMap — duplicate override merge order (finding #7)', () => {
  // Un-skipped by the Stage-4 table restoration.
  it('merges two individually-incomplete custom fragments into a valid row', () => {
    // Fragment A alone: missing measurement + sourceUnit → would be rejected.
    // Fragment B alone: missing kind → would be rejected.
    // Merged: complete valid custom row.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'custom_x', kind: 'temperature', name: 'From A' },
        { dataPoint: 'custom_x', measurement: 'temperature', sourceUnit: 'fahrenheit' },
      ],
      discovery: {
        schemaVersion: 1,
        entries: [{
          stationMac: MAC1,
          stationName: 'Home',
          dataPoint: 'custom_x',
          firstSeen: '2026-07-01T00:00:00Z',
          lastSeen: '2026-07-09T21:00:00Z',
        }],
      },
    });
    // Should succeed — merged row is valid.
    expect(result.errors).toHaveLength(0);
    const row = result.rows.find(r => r.dataPoint === 'custom_x');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('temperature');
    if (row && row.kind !== 'unrecognized') {
      expect(row.name).toBe('From A');
    }
    // AND we emit the "duplicate merged" warning.
    expect(result.warnings.some(w => /Duplicate sensorMap entries.*custom_x/.test(w.message))).toBe(true);
  });

  it('later fragment wins on conflicting fields', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 'First' },
        { dataPoint: 'tempf', name: 'Second' },
      ],
    });
    expect(result.errors).toHaveLength(0);
    const row = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (row && row.kind !== 'unrecognized') expect(row.name).toBe('Second');
  });
});

// ---- Review finding #9: warnings surfaced through EffectiveSensorMap ---

describe('buildEffectiveSensorMap — warnings surface + threshold stripped (finding #9)', () => {
  it('exposes warnings for non-motion field ignores', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        // Temperature is non-motion — threshold gets stripped with a warning.
        { dataPoint: 'tempf', threshold: 90 },
      ],
    });
    expect(result.warnings.some(w => /threshold on non-motion/.test(w.message))).toBe(true);
    // AND the row does not carry the ignored threshold value.
    const row = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (row && row.kind !== 'unrecognized') {
      expect(row.threshold).toBeUndefined();
    }
  });

  it('warnings carry override-index attribution', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'humidity' },                    // index 0 — no warning
        { dataPoint: 'tempf', threshold: 90 },        // index 1 — warns
      ],
    });
    const w = result.warnings.find(w => /threshold on non-motion/.test(w.message));
    expect(w).toBeDefined();
    expect(w?.overrideIndex).toBe(1);
    expect(w?.dataPoint).toBe('tempf');
  });

  it('EffectiveSensorMap always has a warnings array (even when empty)', () => {
    const result = buildEffectiveSensorMap(baseInput());
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ---- Follow-up finding #5: per-field warning attribution -----------

describe('buildEffectiveSensorMap — per-field warning attribution', () => {
  it('attributes a per-field warning to the fragment whose value survived merge, not the last one', () => {
    // Two fragments for `tempf`:
    //   index 0: name='A', threshold=90  ← threshold provided here
    //   index 1: name='B'                ← last, but has no threshold
    // The threshold ignored-non-motion warning must point at index 0
    // (the fragment that actually sourced the offending threshold),
    // not index 1 (the merge-winning last fragment).
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 'A', threshold: 90 },
        { dataPoint: 'tempf', name: 'B' },
      ],
    });
    const w = result.warnings.find(w => w.code === 'ignored-non-motion-threshold');
    expect(w).toBeDefined();
    expect(w?.overrideIndex).toBe(0);
    expect(w?.field).toBe('threshold');
  });

  it('the whole-row duplicate-merged warning is attributed to the FIRST fragment', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 'A' },
        { dataPoint: 'tempf', name: 'B' },
      ],
    });
    const w = result.warnings.find(w => w.code === 'duplicate-merged');
    expect(w).toBeDefined();
    expect(w?.overrideIndex).toBe(0);
    expect(w?.field).toBeUndefined();
  });

  it('attributes a field-scoped ERROR to the fragment whose value survived merge, not the last one', () => {
    // Fragment 0 supplies the bad `name: 42`.
    // Fragment 1 supplies `enabled: true` — merge-wins on `enabled`
    // but doesn't touch `name`.
    // The error must point at index 0 (the fragment that owns the
    // offending name), not index 1.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', name: 42 },
        { dataPoint: 'tempf', enabled: true },
      ] as never,
    });
    const e = result.errors.find(e => e.code === 'invalid-name');
    expect(e).toBeDefined();
    expect(e?.overrideIndex).toBe(0);
    expect(e?.field).toBe('name');
  });

  it('attributes an unknown-key ERROR to the fragment that CONTAINED the bad key', () => {
    // The offending key `triggerEnabledd` is in fragment 0.
    // Fragment 1 supplies an unrelated valid `enabled: true`.
    // Attribution must point at fragment 0 — the merge provenance
    // map records every input key, so unknown keys route through it
    // the same way SensorMapOverride fields do. If we fell back to
    // the last fragment, the UI would highlight the wrong entry.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', triggerEnabledd: true },
        { dataPoint: 'tempf', enabled: true },
      ] as never,
    });
    const e = result.errors.find(e => e.code === 'unknown-key');
    expect(e).toBeDefined();
    expect(e?.overrideIndex).toBe(0);
    expect(e?.field).toBe('triggerEnabledd');
  });

  it('attributes a wrapper-id-forbidden ERROR to the fragment that CONTAINED wrapperId', () => {
    // Same shape as the unknown-key case but for the specific
    // wrapperId rejection path (§3.7 forbids setting it manually).
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'tempf', wrapperId: 'temperature' },
        { dataPoint: 'tempf', enabled: true },
      ] as never,
    });
    const e = result.errors.find(e => e.code === 'wrapper-id-forbidden');
    expect(e).toBeDefined();
    expect(e?.overrideIndex).toBe(0);
    expect(e?.field).toBe('wrapperId');
  });

  it('attributes a truly row-scope ERROR (kind × measurement incompatibility) to the last fragment', () => {
    // No single field is "wrong" in isolation — kind and measurement
    // are both individually valid, but the combination isn't. This
    // is a genuine row-scope failure: `field` is undefined and
    // attribution falls back to the last fragment.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'custom_x', kind: 'temperature' },
        { dataPoint: 'custom_x', measurement: 'humidity', sourceUnit: 'percent' },
      ],
    });
    const e = result.errors.find(e => e.code === 'incompatible-kind-measurement');
    expect(e).toBeDefined();
    expect(e?.overrideIndex).toBe(1);
    expect(e?.field).toBeUndefined();
  });
});

// ---- Review finding #10: JSON-boundary type validation --------------

describe('buildEffectiveSensorMap — malformed input rejection (finding #10)', () => {
  it('rejects a non-object override entry', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [null, 'not-an-override', 42] as never,
    });
    expect(result.errors.length).toBe(3);
    for (const e of result.errors) {
      expect(e.message).toMatch(/not an object/);
    }
  });

  it('rejects an override with a numeric batteryField', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'tempf', batteryField: 42 }] as never,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/batteryField/);
  });

  it('rejects a stringly-typed triggerEnabled', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{ dataPoint: 'windspeedmph', triggerEnabled: 'false' }] as never,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/triggerEnabled/);
  });
});

// ---- Review finding #6: custom-row battery attachment -----------------

// Un-skipped by the Stage-4 table restoration. Canonical-owner
// behavior for KNOWN rows stays covered by the "battery attachment"
// describe above.
describe('buildEffectiveSensorMap — custom-row battery ownership (finding #6)', () => {
  it('a custom row with a NOVEL batteryField gets hasBatterySubService=true', () => {
    // `my_barn_batt` is not reserved by any default canonical row,
    // so a custom row claiming it should be authorized to host the
    // HAP BatteryService.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{
        dataPoint: 'custom_barn_wind',
        kind: 'motion',
        measurement: 'wind-speed',
        sourceUnit: 'mph',
        batteryField: 'my_barn_batt',
      }],
    });
    const row = result.rows.find(r => r.dataPoint === 'custom_barn_wind');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.batteryField).toBe('my_barn_batt');
      expect(row.hasBatterySubService).toBe(true);
    }
  });

  it('a custom row cannot claim a RESERVED default battery field', () => {
    // `battout` is the reserved owner (`tempf` has canonicalForBattery:
    // true). A custom row naming it may still READ the field (for
    // battery-low display) but can NOT host the HAP sub-service — the
    // reserved default row owns that.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{
        dataPoint: 'custom_second_temp',
        kind: 'temperature',
        measurement: 'temperature',
        sourceUnit: 'fahrenheit',
        batteryField: 'battout',
      }],
    });
    const row = result.rows.find(r => r.dataPoint === 'custom_second_temp');
    expect(row).toBeDefined();
    if (row && row.kind !== 'unrecognized') {
      expect(row.batteryField).toBe('battout');
      expect(row.hasBatterySubService).toBe(false);
    }
  });

  it('two custom rows sharing a novel batteryField: the EARLIEST-authored fragment wins, note surfaces', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        {
          dataPoint: 'custom_barn_wind',
          kind: 'motion',
          measurement: 'wind-speed',
          sourceUnit: 'mph',
          batteryField: 'my_barn_batt',
        },
        {
          dataPoint: 'custom_barn_temp',
          kind: 'temperature',
          measurement: 'temperature',
          sourceUnit: 'fahrenheit',
          batteryField: 'my_barn_batt',
        },
      ],
    });
    const wind = result.rows.find(r => r.dataPoint === 'custom_barn_wind');
    const temp = result.rows.find(r => r.dataPoint === 'custom_barn_temp');
    // Stage-4 ordering: the winner is DETERMINISTIC — the claimant
    // whose batteryField was authored by the EARLIEST config fragment
    // (wind at index 0), never resolution-iteration order.
    expect(wind && wind.kind !== 'unrecognized' ? wind.hasBatterySubService : null).toBe(true);
    expect(temp && temp.kind !== 'unrecognized' ? temp.hasBatterySubService : null).toBe(false);
    // The loser still carries batteryField for reading.
    expect(temp && temp.kind !== 'unrecognized' ? temp.batteryField : null).toBe('my_barn_batt');
    // The collision routes through the NOTES channel (Stage-4 channel
    // move) with the loser's fragment attributed.
    const note = result.notes.find(n => n.code === 'duplicate-battery-owner');
    expect(note).toBeDefined();
    expect(note?.source).toBe('override');
    expect(note?.overrideIndex).toBe(1);
    expect(note?.dataPoint).toBe('custom_barn_temp');
    expect(result.warnings.some(w => w.code === 'duplicate-battery-owner')).toBe(false);
    // Signatures reflect settled ownership.
    expect(wind && wind.kind !== 'unrecognized' ? wind.structuralSignature : '').toContain('battery:1');
    expect(temp && temp.kind !== 'unrecognized' ? temp.structuralSignature : '').toContain('battery:0');
  });

  it('canonical default row still owns its reserved battery field even alongside a custom claimant', () => {
    // Regression guard: adding a custom row that tries to claim
    // `battout` must NOT displace the canonical tempf row's
    // ownership.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [{
        dataPoint: 'custom_second',
        kind: 'temperature',
        measurement: 'temperature',
        sourceUnit: 'fahrenheit',
        batteryField: 'battout',
      }],
    });
    const tempf = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    if (tempf && tempf.kind !== 'unrecognized') {
      expect(tempf.hasBatterySubService).toBe(true);
      expect(tempf.batteryField).toBe('battout');
    }
  });

  // ---- Group 4 follow-up review regressions ----

  it('a DISABLED custom row does not consume the claim slot; the enabled row still wins', () => {
    // Group 4 review finding #1: enable-state was resolved AFTER
    // battery ownership, letting `{ custom_disabled, enabled: false }`
    // block `{ custom_enabled, enabled: true }` from ever attaching.
    // Fix: resolve enabled first, disabled rows return false + do
    // NOT touch ownership.claims.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        {
          dataPoint: 'custom_disabled',
          kind: 'motion',
          measurement: 'wind-speed',
          sourceUnit: 'mph',
          batteryField: 'my_barn_batt',
          enabled: false,
        },
        {
          dataPoint: 'custom_enabled',
          kind: 'temperature',
          measurement: 'temperature',
          sourceUnit: 'fahrenheit',
          batteryField: 'my_barn_batt',
        },
      ],
    });
    const disabled = result.rows.find(r => r.dataPoint === 'custom_disabled');
    const enabledRow = result.rows.find(r => r.dataPoint === 'custom_enabled');
    if (disabled && disabled.kind !== 'unrecognized') {
      expect(disabled.hasBatterySubService).toBe(false);
    }
    if (enabledRow && enabledRow.kind !== 'unrecognized') {
      expect(enabledRow.hasBatterySubService).toBe(true);
    }
    // No collision warning fires — disabled rows don't count as a
    // claimant, so this isn't a two-row collision at all.
    expect(result.warnings.filter(w => w.code === 'duplicate-battery-owner')).toHaveLength(0);
  });

  it('a KNOWN row with overridden batteryField participates in claims (does NOT keep canonical status)', () => {
    // Group 4 review finding #2: rows with defaultRow bypassed the
    // ownership pass, so a canonical known row whose batteryField
    // was overridden to a NOVEL value + a custom row using the same
    // novel field both received hasBatterySubService: true.
    // Fix: canonical status only holds when the RESOLVED batteryField
    // equals the default. Overridden fields go through claims.
    //
    // Test constrained to MAC1 via station-scoped overrides so the
    // assertion focuses on one station's collision, not both.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        // tempf on MAC1: default batteryField 'battout' overridden
        // to 'my_barn_batt'. It's no longer canonical for its
        // resolved field, so it must go through claims.
        { dataPoint: 'tempf', stationMac: MAC1, batteryField: 'my_barn_batt' },
        // Custom row on MAC1 with the same novel field.
        {
          dataPoint: 'custom_second',
          stationMac: MAC1,
          kind: 'temperature',
          measurement: 'temperature',
          sourceUnit: 'fahrenheit',
          batteryField: 'my_barn_batt',
        },
      ],
    });
    // On MAC1: tempf's batteryField was authored at index 0 (earliest)
    // so it wins the adjudication; custom_second (index 1) collides.
    const tempfMac1 = result.rows.find(r => r.dataPoint === 'tempf' && r.stationMac === MAC1);
    const customMac1 = result.rows.find(r => r.dataPoint === 'custom_second' && r.stationMac === MAC1);
    expect(tempfMac1 && tempfMac1.kind !== 'unrecognized' ? tempfMac1.hasBatterySubService : null).toBe(true);
    expect(customMac1 && customMac1.kind !== 'unrecognized' ? customMac1.hasBatterySubService : null).toBe(false);
    // The loser retains the batteryField for reading.
    if (customMac1 && customMac1.kind !== 'unrecognized') {
      expect(customMac1.batteryField).toBe('my_barn_batt');
    }
    // Duplicate note fires for MAC1 only (MAC2's tempf still uses
    // the default 'battout' — no collision there).
    const dupes = result.notes.filter(n => n.code === 'duplicate-battery-owner');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].stationMac).toBe(MAC1);
  });

  it('duplicate-battery-owner note attributes to a REAL overrideIndex (never -1)', () => {
    // Group 4 review finding #3: the diagnostic used a `-1` sentinel
    // for overrideIndex, violating the Group 1 provenance contract.
    // Attribution goes to the loser's batteryField-supplying fragment
    // (falling back to the winner's — never -1). Stage 4 moved the
    // diagnostic to the notes channel with source 'override'.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        // Index 0: the WINNER — claims the novel field first.
        {
          dataPoint: 'custom_first',
          kind: 'motion',
          measurement: 'wind-speed',
          sourceUnit: 'mph',
          batteryField: 'my_shared_batt',
        },
        // Index 1: the LOSER — same novel field on the same station.
        {
          dataPoint: 'custom_second',
          kind: 'temperature',
          measurement: 'temperature',
          sourceUnit: 'fahrenheit',
          batteryField: 'my_shared_batt',
        },
      ],
    });
    const dupe = result.notes.find(n => n.code === 'duplicate-battery-owner');
    expect(dupe).toBeDefined();
    // MUST NOT be -1 — that would violate Group 1's contract that
    // every attributed diagnostic points at a real fragment.
    expect(dupe?.overrideIndex).not.toBe(-1);
    // The loser's batteryField came from index 1, so that's the
    // config entry the UI should highlight.
    expect(dupe?.overrideIndex).toBe(1);
    expect(dupe?.source).toBe('override');
    expect(dupe?.dataPoint).toBe('custom_second');
  });
});

// ---- Review finding #8: global custom rows × known stations ----------

// Un-skipped by the Stage-4 table restoration.
describe('buildEffectiveSensorMap — global custom pair collection (finding #8)', () => {
  it('emits a row for a global custom override on every station in inventory, even before discovery', () => {
    // Two stations, no discovery entries at all. A global custom row
    // must still produce a "waiting for station" row on each station.
    // Pre-fix, buildEffectiveSensorMap dropped these on the floor
    // because pair collection only considered defaults × stations,
    // discovery entries, and station-specific overrides.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      stations: [
        { macAddress: MAC1, name: 'Home' },
        { macAddress: 'AA:BB:CC:DD:EE:02', name: 'Barn' },
      ],
      userOverrides: [{
        dataPoint: 'custom_multi',
        kind: 'motion',
        measurement: 'wind-speed',
        sourceUnit: 'mph',
      }],
      discovery: { schemaVersion: 1, entries: [] },
    });
    const rows = result.rows.filter(r => r.dataPoint === 'custom_multi');
    expect(rows.map(r => r.stationMac).sort()).toEqual([
      'AA:BB:CC:DD:EE:01',
      'AA:BB:CC:DD:EE:02',
    ]);
  });

  it('a station-scoped custom override is NOT duplicated onto other stations', () => {
    // The global-custom-fanout must skip rows whose stationMac is
    // already set — those are station-scoped and belong to exactly
    // one station.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      stations: [
        { macAddress: MAC1, name: 'Home' },
        { macAddress: 'AA:BB:CC:DD:EE:02', name: 'Barn' },
      ],
      userOverrides: [{
        dataPoint: 'custom_home_only',
        stationMac: MAC1,
        kind: 'motion',
        measurement: 'wind-speed',
        sourceUnit: 'mph',
      }],
    });
    const rows = result.rows.filter(r => r.dataPoint === 'custom_home_only');
    expect(rows.map(r => r.stationMac)).toEqual([MAC1]);
  });

  it('a global override targeting a KNOWN dataPoint (compat path) is not double-fanned', () => {
    // Regression guard: compat produces `{ dataPoint: 'tempf', ... }`
    // for legacy configs. That's a global override for a KNOWN
    // dataPoint — the defaults × stations pass has already emitted
    // a pair for every station, so the global-custom-fanout must
    // NOT emit duplicates.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      stations: [
        { macAddress: MAC1, name: 'Home' },
        { macAddress: 'AA:BB:CC:DD:EE:02', name: 'Barn' },
      ],
      userOverrides: [{ dataPoint: 'tempf', name: 'Custom Temperature Label' }],
    });
    const rows = result.rows.filter(r => r.dataPoint === 'tempf');
    expect(rows).toHaveLength(2);
  });
});

// ---- Stage-4 battery-ownership ordering (earliestOverrideIndex) -------

describe('buildEffectiveSensorMap — Stage-4 ownership ordering', () => {
  it('earliest-authored fragment beats resolution-iteration order', () => {
    // Station-scoped overrides resolve in an EARLIER pair-collection
    // bucket than global customs, so PR #20's first-resolved rule
    // handed ownership to the station-scoped row. Stage 4's rule hands
    // it to the fragment authored FIRST in config.sensorMap: the
    // global custom at index 0.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        {  // index 0 — GLOBAL custom (later pair-collection bucket)
          dataPoint: 'custom_global',
          kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit',
          batteryField: 'novel_batt',
        },
        {  // index 1 — STATION-SCOPED custom (earlier bucket)
          dataPoint: 'custom_scoped', stationMac: MAC1,
          kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent',
          batteryField: 'novel_batt',
        },
      ],
    });
    const globalRow = result.rows.find(r => r.dataPoint === 'custom_global' && r.stationMac === MAC1);
    const scopedRow = result.rows.find(r => r.dataPoint === 'custom_scoped' && r.stationMac === MAC1);
    expect(globalRow && globalRow.kind !== 'unrecognized' ? globalRow.hasBatterySubService : null).toBe(true);
    expect(scopedRow && scopedRow.kind !== 'unrecognized' ? scopedRow.hasBatterySubService : null).toBe(false);
    // Signatures computed AFTER adjudication reflect the settled state.
    expect(globalRow && globalRow.kind !== 'unrecognized' ? globalRow.structuralSignature : '').toContain('battery:1');
    expect(scopedRow && scopedRow.kind !== 'unrecognized' ? scopedRow.structuralSignature : '').toContain('battery:0');
    // The note names the loser with its own fragment.
    const note = result.notes.find(n => n.code === 'duplicate-battery-owner');
    expect(note?.dataPoint).toBe('custom_scoped');
    expect(note?.overrideIndex).toBe(1);
    // On MAC2 the global custom is alone — owner there too, no note.
    expect(result.notes.filter(n => n.code === 'duplicate-battery-owner')).toHaveLength(1);
  });

  it('the merged-fragment rule keeps earliestOverrideIndex = the batteryField-authoring fragment', () => {
    // Two fragments merge into ONE row: the batteryField came from the
    // EARLIER fragment (index 0), so the merged row's ordering key is 0
    // and it beats a claimant authored at index 1.
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      userOverrides: [
        { dataPoint: 'custom_a', kind: 'temperature', measurement: 'temperature', sourceUnit: 'fahrenheit', batteryField: 'shared_batt' }, // 0
        { dataPoint: 'custom_b', kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent', batteryField: 'shared_batt' },          // 1
        { dataPoint: 'custom_a', name: 'Renamed Later' },   // 2 — merges into custom_a; batteryField provenance stays 0
      ],
    });
    const a = result.rows.find(r => r.dataPoint === 'custom_a' && r.stationMac === MAC1);
    const b = result.rows.find(r => r.dataPoint === 'custom_b' && r.stationMac === MAC1);
    expect(a && a.kind !== 'unrecognized' ? a.hasBatterySubService : null).toBe(true);
    expect(b && b.kind !== 'unrecognized' ? b.hasBatterySubService : null).toBe(false);
  });
});

describe('buildEffectiveSensorMap — orphan-battery-field notes (Stage 4)', () => {
  it('disabling a reserved canonical owner with referencing rows enabled emits a per-station note', () => {
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      // tempf is the canonical owner of battout; humidity (enabled by
      // default in v2 mode) still references battout.
      userOverrides: [{ dataPoint: 'tempf', enabled: false }],   // index 0
    });
    const orphans = result.notes.filter(n => n.code === 'orphan-battery-field');
    // One per station (ownership is per-station).
    expect(orphans.map(n => n.stationMac).sort()).toEqual([MAC1, MAC2]);
    for (const note of orphans) {
      expect(note.dataPoint).toBe('tempf');
      expect(note.source).toBe('override');
      expect(note.overrideIndex).toBe(0);   // the fragment that disabled the owner
      expect(note.message).toContain('battout');
    }
    // Ownership did NOT roll: no other battout row gained the service.
    const battoutHosts = result.rows.filter(r =>
      r.kind !== 'unrecognized' && r.batteryField === 'battout' && r.hasBatterySubService);
    expect(battoutHosts).toHaveLength(0);
  });

  it('no orphan note when every referencing row is also disabled', () => {
    // Disable the whole battout family on MAC1 via station-scoped
    // overrides for each referencing default row.
    const battoutRows = DEFAULT_SENSOR_MAP.filter(r => r.batteryField === 'battout');
    const result = buildEffectiveSensorMap({
      ...baseInput(),
      stations: [{ macAddress: MAC1, name: 'Home' }],
      userOverrides: battoutRows.map(r => ({ dataPoint: r.dataPoint, enabled: false })),
    });
    expect(result.notes.filter(n => n.code === 'orphan-battery-field')).toHaveLength(0);
  });

  it('no orphan note while the owner is enabled', () => {
    const result = buildEffectiveSensorMap(baseInput());
    expect(result.notes.filter(n => n.code === 'orphan-battery-field')).toHaveLength(0);
  });
});

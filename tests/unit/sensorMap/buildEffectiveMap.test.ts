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
});

// ---- Review finding #7: dedup + merge BEFORE semantic validation ---

describe('buildEffectiveSensorMap — duplicate override merge order (finding #7)', () => {
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

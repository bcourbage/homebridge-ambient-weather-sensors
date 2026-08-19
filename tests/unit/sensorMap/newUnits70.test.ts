/**
 * Behavioral coverage for the units added by GA task #70 (mmHg, fps,
 * fc) — through REAL wrappers and the REAL mirror projection, not just
 * arithmetic helpers:
 *
 *   - both conversion directions + round trips;
 *   - a real pressure wrapper formatting and thresholding in mmHg
 *     (thresholds stay in sourceUnit);
 *   - a real wind wrapper displaying ft/sec;
 *   - a custom light row declaring sourceUnit fc producing correct
 *     HAP lux (CurrentAmbientLightLevel is fixed-unit);
 *   - the legacy mirror OMITS v2-only units (mmHg, fps) from a 1.7.x
 *     rollback config — the mirror with an mmHg row is byte-identical
 *     to the no-override mirror, so the downgrade fixture's structural
 *     guarantees carry over unchanged;
 *   - compat projects NO overrides from hand-added legacy
 *     units.temperature / units.solar keys (no such knobs exist).
 */
import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { compatToOverrides, type LegacyConfig } from '../../../src/sensorMap/compat';
import { projectLegacyMirror } from '../../../src/sensorMap/legacyMirror';
import { buildWrapperRouting, distributeViaRouting } from '../../../src/sensorMap/routing';
import { toCanonical, toDisplayUnit } from '../../../src/sensorMap/unitConversions';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import type { EffectiveSensorRow, SensorMapOverride } from '../../../src/sensorMap/types';
import {
  MockCharacteristic,
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';

function mapFor(overrides: SensorMapOverride[]) {
  return buildEffectiveSensorMap({
    userOverrides: overrides,
    discovery: { schemaVersion: 1, entries: [] },
    uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
    stations: [{ macAddress: MAC, name: 'Home' }],
    configMode: 'v2',
  });
}

/** Drive one row through routing with one payload; return its accessory. */
function drive(row: EffectiveSensorRow, dataPoint: string, value: number) {
  const platform = makeMockPlatform();
  const accessory = makeMockAccessory({ uniqueId: `${MAC}-${dataPoint}`, displayName: dataPoint });
  const routing = buildWrapperRouting(
    platform as unknown as AmbientWeatherSensorsPlatform,
    { rows: [row], errors: [], warnings: [], notes: [] },
    () => accessory as never,
  );
  distributeViaRouting(
    platform as unknown as AmbientWeatherSensorsPlatform,
    routing,
    [{ macAddress: MAC, lastData: { [dataPoint]: value } }],
  );
  return accessory;
}

function configuredRow(overrides: SensorMapOverride[], dataPoint: string) {
  const map = mapFor(overrides);
  expect(map.errors).toHaveLength(0);
  const row = map.rows.find(r => r.dataPoint === dataPoint && r.kind !== 'unrecognized');
  expect(row, dataPoint).toBeDefined();
  return row!;
}

function readMotionChar(accessory: ReturnType<typeof makeMockAccessory>, displayName: string): string {
  const motion = accessory.getService(MockServices.MotionSensor)!;
  const char = [...(motion as unknown as { characteristics: Map<string, MockCharacteristic> })
    .characteristics.values()].find(c => c.displayName === displayName);
  expect(char, displayName).toBeDefined();
  return String(char!.value);
}
const readValueChar = (a: ReturnType<typeof makeMockAccessory>) => readMotionChar(a, 'Value');

describe('conversions: both directions + round trips', () => {
  it('mmHg = inHg × 25.4 and back', () => {
    expect(toDisplayUnit('pressure', 29.92, 'mmHg')).toBeCloseTo(759.968, 3);
    expect(toCanonical('pressure', 'mmHg', 759.968)).toBeCloseTo(29.92, 6);
    const roundTrip = toCanonical('pressure', 'mmHg', toDisplayUnit('pressure', 30.12, 'mmHg'));
    expect(roundTrip).toBeCloseTo(30.12, 10);
  });

  it('ft/sec = mph × 22/15 EXACTLY and back', () => {
    // The exact ratio matters: 22/15 ft/sec must canonicalize to
    // EXACTLY 1 mph (a Beaufort boundary), which a rounded constant
    // (1.46667) misses by ~2.3e-6.
    expect(toDisplayUnit('wind-speed', 15, 'fps')).toBe(22);
    expect(toCanonical('wind-speed', 'fps', 22 / 15)).toBe(1);
    const roundTrip = toCanonical('wind-speed', 'fps', toDisplayUnit('wind-speed', 25, 'fps'));
    expect(roundTrip).toBeCloseTo(25, 12);
  });

  it('lux = fc × 10.7639104167 and back', () => {
    expect(toCanonical('illuminance', 'fc', 100)).toBeCloseTo(1076.39104167, 6);
    expect(toDisplayUnit('illuminance', 1076.39104167, 'fc')).toBeCloseTo(100, 8);
    const roundTrip = toDisplayUnit('illuminance', toCanonical('illuminance', 'fc', 42), 'fc');
    expect(roundTrip).toBeCloseTo(42, 10);
  });
});

describe('real pressure wrapper in mmHg', () => {
  it('formats the reading as one-decimal mmHg and thresholds in sourceUnit (inHg)', () => {
    // Known row: baromrelin (source inHg, direction defaults 'below').
    // Threshold stays in sourceUnit: 30.12 inHg. Reading 29.92 inHg is
    // below it → motion fires; the DISPLAY renders 29.92 × 25.4 =
    // 759.968 → "760.0 mmHg".
    const row = configuredRow(
      [{ dataPoint: 'baromrelin', displayUnit: 'mmHg', threshold: 30.12 }],
      'baromrelin',
    );
    const accessory = drive(row, 'baromrelin', 29.92);
    expect(readValueChar(accessory)).toBe('760.0 mmHg');
    const motion = accessory.getService(MockServices.MotionSensor)!;
    expect(motion.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('does not fire when the inHg reading sits above the inHg threshold, regardless of mmHg display', () => {
    const row = configuredRow(
      [{ dataPoint: 'baromrelin', displayUnit: 'mmHg', threshold: 29.5 }],
      'baromrelin',
    );
    const accessory = drive(row, 'baromrelin', 29.92);
    expect(readValueChar(accessory)).toBe('760.0 mmHg');
    const motion = accessory.getService(MockServices.MotionSensor)!;
    expect(motion.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
  });
});

describe('real wind wrapper in ft/sec', () => {
  it('renders mph readings converted to fps', () => {
    const row = configuredRow(
      [{ dataPoint: 'windspeedmph', displayUnit: 'fps' }],
      'windspeedmph',
    );
    const accessory = drive(row, 'windspeedmph', 15);
    // 15 mph × 22/15 = 22 exactly → "22 fps".
    expect(readValueChar(accessory)).toBe('22 fps');
  });
});

describe('custom light row with sourceUnit fc', () => {
  it('writes correct lux into the fixed-unit HAP characteristic', () => {
    const row = configuredRow(
      [{ dataPoint: 'barn_light', kind: 'light', measurement: 'illuminance', sourceUnit: 'fc', name: 'Barn Light' }],
      'barn_light',
    );
    const accessory = drive(row, 'barn_light', 100);
    const svc = accessory.getService(MockServices.LightSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentAmbientLightLevel))
      .toBeCloseTo(1076.391, 2);
  });
});

describe('custom rows declaring the new units as SOURCE units (full pipeline)', () => {
  it('a custom pressure row with sourceUnit mmHg converts raw + threshold and fires below it', () => {
    // Threshold is stored in sourceUnit (mmHg): 765 mmHg. Raw 760 mmHg
    // canonicalizes to 29.9213 inHg, the threshold to 30.1181 inHg —
    // custom pressure defaults to 'below', so 760 < 765 fires. The
    // display converts BACK from canonical: "760.0 mmHg".
    const row = configuredRow(
      [{ dataPoint: 'barn_baro_mm', kind: 'motion', measurement: 'pressure', sourceUnit: 'mmHg', displayUnit: 'mmHg', name: 'Barn Baro (mmHg)', threshold: 765 }],
      'barn_baro_mm',
    );
    const accessory = drive(row, 'barn_baro_mm', 760);
    expect(readValueChar(accessory)).toBe('760.0 mmHg');
    const motion = accessory.getService(MockServices.MotionSensor)!;
    expect(motion.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('the same mmHg row stays quiet when the reading sits above the mmHg threshold', () => {
    const row = configuredRow(
      [{ dataPoint: 'barn_baro_mm', kind: 'motion', measurement: 'pressure', sourceUnit: 'mmHg', displayUnit: 'mmHg', name: 'Barn Baro (mmHg)', threshold: 755 }],
      'barn_baro_mm',
    );
    const accessory = drive(row, 'barn_baro_mm', 760);
    expect(readValueChar(accessory)).toBe('760.0 mmHg');
    const motion = accessory.getService(MockServices.MotionSensor)!;
    expect(motion.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
  });

  it('a custom wind row with sourceUnit fps converts raw + threshold, formats, and fires above', () => {
    // Raw 22 ft/sec = exactly 15 mph canonical; threshold 20 ft/sec ≈
    // 13.64 mph. Default direction 'above': 15 > 13.64 fires. Display
    // round-trips to "22 fps"; 15 mph sits in the 13–19 Beaufort
    // bucket: 'Moderate breeze'.
    const row = configuredRow(
      [{ dataPoint: 'barn_wind_fps', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'fps', displayUnit: 'fps', name: 'Barn Wind (fps)', threshold: 20 }],
      'barn_wind_fps',
    );
    const accessory = drive(row, 'barn_wind_fps', 22);
    expect(readValueChar(accessory)).toBe('22 fps');
    expect(readMotionChar(accessory, 'Intensity')).toBe('Moderate breeze');
    const motion = accessory.getService(MockServices.MotionSensor)!;
    expect(motion.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('EXACT Beaufort boundary: 22/15 ft/sec is exactly 1 mph = Light air (fails under a rounded ratio)', () => {
    // The F1 discriminator: with the old 1.46667 constant this
    // canonicalizes to 0.9999977 mph and buckets as 'Calm'.
    const row = configuredRow(
      [{ dataPoint: 'barn_wind_fps', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'fps', displayUnit: 'fps', name: 'Barn Wind (fps)', triggerEnabled: false }],
      'barn_wind_fps',
    );
    const accessory = drive(row, 'barn_wind_fps', 22 / 15);
    expect(readMotionChar(accessory, 'Intensity')).toBe('Light air');
  });
});

describe('legacy mirror: v2-only units never reach a 1.7.x rollback config', () => {
  it('a family-uniform mmHg display omits units.pressure (1.7 falls back to inHg display)', () => {
    const mirror = projectLegacyMirror(mapFor([
      { dataPoint: 'baromrelin', displayUnit: 'mmHg' },
      { dataPoint: 'baromabsin', displayUnit: 'mmHg' },
    ]));
    expect(mirror.units?.pressure).toBeUndefined();
  });

  it('a family-uniform hPa display still mirrors (1.7-legal)', () => {
    const mirror = projectLegacyMirror(mapFor([
      { dataPoint: 'baromrelin', displayUnit: 'hPa' },
      { dataPoint: 'baromabsin', displayUnit: 'hPa' },
    ]));
    expect(mirror.units?.pressure).toBe('hPa');
  });

  it('a family-uniform fps wind display omits units.windSpeed', () => {
    const mirror = projectLegacyMirror(mapFor([
      { dataPoint: 'windspeedmph', displayUnit: 'fps' },
      { dataPoint: 'windgustmph', displayUnit: 'fps' },
      { dataPoint: 'maxdailygust', displayUnit: 'fps' },
    ]));
    expect(mirror.units?.windSpeed).toBeUndefined();
  });

  it('the mmHg mirror is IDENTICAL to the no-override mirror (structural downgrade equivalence)', () => {
    // displayUnit is the only delta and the projection drops it, so the
    // downgrade fixture's zero-unregister guarantee for the no-override
    // shape covers the mmHg shape verbatim.
    const withMmHg = projectLegacyMirror(mapFor([
      { dataPoint: 'baromrelin', displayUnit: 'mmHg' },
      { dataPoint: 'baromabsin', displayUnit: 'mmHg' },
    ]));
    const baseline = projectLegacyMirror(mapFor([]));
    expect(withMmHg).toEqual(baseline);
  });
});

describe('compat: no legacy knobs exist for native temperature/solar units', () => {
  it('hand-added units.temperature / units.solar keys project no overrides', () => {
    const legacy = {
      temperatureSensors: true,
      solarRadiationSensors: true,
      units: { temperature: 'celsius', solar: 'lux' },
    } as unknown as LegacyConfig;
    const overrides = compatToOverrides(legacy, [{ macAddress: MAC, name: 'Home' }]);
    const unitOverrides = overrides.filter(o => o.displayUnit !== undefined || o.sourceUnit !== undefined);
    expect(unitOverrides).toEqual([]);
  });
});

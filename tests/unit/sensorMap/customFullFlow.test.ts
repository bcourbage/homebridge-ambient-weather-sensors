/**
 * `test_custom_<entry>` full-flow gate (finding-#4 Stage 4; hardened in
 * review R10-4).
 *
 * One test per restored `WRAPPER_FOR_KIND_AND_MEASUREMENT` entry,
 * end-to-end through the REAL pipeline:
 *
 *   config.sensorMap → buildEffectiveSensorMap → buildWrapperRouting
 *   → distributeViaRouting → wrapper
 *
 * The gate is BEHAVIORAL (R10-4): the entry list is compared against
 * the actual table keys (a new/renamed entry fails the gate, not just
 * the shape test), and every motion family asserts the formatted Value
 * characteristic AND MotionDetected — the assertions that catch a
 * dropped triggerDirection (R10-1), a wrong direction fallback
 * (R10-2), and a displayUnit inherited from a metric source (R10-3).
 * Native wrappers assert the fixed-unit HAP characteristic (and that
 * `displayUnit` is ignored there).
 */

import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import {
  buildWrapperRouting,
  distributeViaRouting,
} from '../../../src/sensorMap/routing';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from '../../../src/sensorMap/wrappers';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import type { EffectiveSensorMap, SensorMapOverride, WrapperId } from '../../../src/sensorMap/types';
import {
  MockCharacteristic,
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
  type MockPlatform,
} from '../../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';

type Accessory = ReturnType<typeof makeMockAccessory>;

interface Entry {
  key: string;
  override: SensorMapOverride;
  wrapperId: WrapperId;
  /** Raw payload value fed through the router. */
  value: number;
  assert: (platform: MockPlatform, accessory: Accessory) => void;
}

/** Native families: the fixed-unit HAP characteristic carries the value. */
function nativeChar(
  service: (typeof MockServices)[keyof typeof MockServices],
  characteristic: (typeof MockCharacteristics)[keyof typeof MockCharacteristics],
  expected: number,
  precision = 3,
) {
  return (_platform: MockPlatform, accessory: Accessory) => {
    const svc = accessory.getService(service)!;
    expect(svc.readCharacteristic(characteristic)).toBeCloseTo(expected, precision);
  };
}

/**
 * Motion families: assert the FORMATTED custom Value characteristic
 * (unit conversion included) and the MotionDetected state (trigger
 * threshold + direction included).
 */
function extendedState(expectedValue: string | RegExp, expectedMotion: boolean) {
  return (_platform: MockPlatform, accessory: Accessory) => {
    const motion = accessory.getService(MockServices.MotionSensor)!;
    const valueChar = [...(motion as unknown as { characteristics: Map<string, MockCharacteristic> })
      .characteristics.values()].find(c => c.displayName === 'Value');
    expect(valueChar, 'custom Value characteristic').toBeDefined();
    if (expectedValue instanceof RegExp) {
      expect(String(valueChar!.value)).toMatch(expectedValue);
    } else {
      expect(valueChar!.value).toBe(expectedValue);
    }
    expect(motion.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(expectedMotion);
  };
}

const ENTRIES: Entry[] = [
  {
    key: 'temperature|temperature',
    // Non-default sourceUnit (celsius) + a displayUnit the NATIVE wrapper
    // must IGNORE (the HAP characteristic is fixed-unit celsius).
    override: { dataPoint: 'barn_temp', kind: 'temperature', measurement: 'temperature', sourceUnit: 'celsius', displayUnit: 'fahrenheit', name: 'Barn Temperature' },
    wrapperId: 'temperature', value: 25,
    assert: nativeChar(MockServices.TemperatureSensor, MockCharacteristics.CurrentTemperature, 25),
  },
  {
    key: 'humidity|humidity',
    override: { dataPoint: 'barn_humidity', kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent', name: 'Barn Humidity' },
    wrapperId: 'humidity', value: 40,
    assert: nativeChar(MockServices.HumiditySensor, MockCharacteristics.CurrentRelativeHumidity, 40),
  },
  {
    key: 'light|illuminance',
    // Non-default sourceUnit (lux) is already canonical for illuminance.
    override: { dataPoint: 'barn_light', kind: 'light', measurement: 'illuminance', sourceUnit: 'lux', name: 'Barn Light' },
    wrapperId: 'solar-radiation', value: 1000,
    assert: nativeChar(MockServices.LightSensor, MockCharacteristics.CurrentAmbientLightLevel, 1000, 1),
  },
  {
    key: 'co2|co2',
    override: { dataPoint: 'barn_co2', kind: 'co2', measurement: 'co2', sourceUnit: 'ppm', name: 'Barn CO2' },
    wrapperId: 'co2', value: 800,
    assert: nativeChar(MockServices.CarbonDioxideSensor, MockCharacteristics.CarbonDioxideLevel, 800),
  },
  {
    key: 'air-quality-pm25|pm25',
    override: { dataPoint: 'barn_pm25', kind: 'air-quality-pm25', measurement: 'pm25', sourceUnit: 'ugm3', name: 'Barn PM25' },
    wrapperId: 'air-quality-pm25', value: 12,
    assert: nativeChar(MockServices.AirQualitySensor, MockCharacteristics.PM2_5Density, 12),
  },
  {
    key: 'air-quality-pm10|pm10',
    override: { dataPoint: 'barn_pm10', kind: 'air-quality-pm10', measurement: 'pm10', sourceUnit: 'ugm3', name: 'Barn PM10' },
    wrapperId: 'air-quality-pm10', value: 30,
    assert: nativeChar(MockServices.AirQualitySensor, MockCharacteristics.PM10Density, 30),
  },
  {
    key: 'motion|uv-index',
    // Threshold in sourceUnit + a value above it → motion fires (R10-1:
    // the direction must actually reach the wrapper).
    override: { dataPoint: 'barn_uv', kind: 'motion', measurement: 'uv-index', sourceUnit: 'index', name: 'Barn UV', threshold: 7 },
    wrapperId: 'uv', value: 8,
    assert: extendedState('8', true),
  },
  {
    key: 'motion|wind-speed',
    // kph source → canonical mph → mps display: 30 kph = 8.33 m/s → "8 mps".
    override: { dataPoint: 'barn_wind', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'kph', displayUnit: 'mps', name: 'Barn Wind' },
    wrapperId: 'wind-speed', value: 30,
    assert: extendedState('8 mps', false),
  },
  {
    key: 'motion|direction',
    override: { dataPoint: 'barn_dir', kind: 'motion', measurement: 'direction', sourceUnit: 'degrees', name: 'Barn Direction' },
    wrapperId: 'wind-direction', value: 180,
    assert: extendedState(/^180° S/, false),
  },
  {
    key: 'motion|pressure',
    // triggerDirection EXPLICITLY flipped to 'above' (family default is
    // 'below'): hPa source → inHg display, 1013 hPa = 29.91 inHg, above
    // the 1000 hPa threshold → motion fires under the flip (R10-1).
    override: { dataPoint: 'barn_pressure', kind: 'motion', measurement: 'pressure', sourceUnit: 'hPa', displayUnit: 'inHg', name: 'Barn Pressure', threshold: 1000, triggerDirection: 'above' },
    wrapperId: 'pressure-relative', value: 1013,
    assert: extendedState('29.91 inHg', true),
  },
  {
    key: 'motion|rain-rate',
    // Metric source, NO displayUnit: the documented default (in_per_hr)
    // must apply (R10-3) — 5 mm/hr = 0.20 in/hr, never "5.00 mm/hr".
    // Threshold authored in sourceUnit (1 mm/hr) → motion fires.
    override: { dataPoint: 'barn_rainrate', kind: 'motion', measurement: 'rain-rate', sourceUnit: 'mm_per_hr', name: 'Barn Rain Rate', threshold: 1 },
    wrapperId: 'rain-rate', value: 5,
    assert: extendedState('0.20 in/hr', true),
  },
  {
    key: 'motion|rain-accumulation',
    // Metric source, NO displayUnit → documented default (in): 12 mm =
    // 0.47 in (R10-3). No threshold → frozen-schema disabled → no motion.
    override: { dataPoint: 'barn_rain', kind: 'motion', measurement: 'rain-accumulation', sourceUnit: 'mm', name: 'Barn Rain' },
    wrapperId: 'rain-event', value: 12,
    assert: extendedState('0.47 in', false),
  },
  {
    key: 'motion|distance',
    // NO explicit direction: the measurement-aware fallback must be
    // BELOW for distance (R10-2). 10 km = 6.2 mi vs an 8 km (≈5 mi)
    // threshold: 'below' → NO motion (the pre-fix 'above' fallback
    // would fire). Display defaults to mi (R10-3), never "10.0 km".
    override: { dataPoint: 'barn_strike_dist', kind: 'motion', measurement: 'distance', sourceUnit: 'km', name: 'Barn Strike Distance', threshold: 8 },
    wrapperId: 'lightning-distance', value: 10,
    assert: extendedState('6.2 mi', false),
  },
  {
    key: 'motion|count',
    // AUTHORED 'below' on an above-default family (R10-1): 3 strikes ≤
    // the 5 threshold → motion fires ONLY if the authored direction
    // actually reaches the wrapper (a dropped direction reads 'above'
    // and stays quiet).
    override: { dataPoint: 'barn_strikes', kind: 'motion', measurement: 'count', sourceUnit: 'count', name: 'Barn Strikes', threshold: 5, triggerDirection: 'below' },
    wrapperId: 'lightning-day', value: 3,
    assert: extendedState('3 strikes', true),
  },
  {
    key: 'motion|timestamp',
    // Timestamp rows have no unit choice (sourceUnit fixed to 'ms') and
    // never trigger; the Value renders as relative time.
    override: { dataPoint: 'barn_last_event', kind: 'motion', measurement: 'timestamp', name: 'Barn Last Event' },
    wrapperId: 'last-rain', value: 1750000000000,
    assert: extendedState(/ago|never|now/i, false),
  },
];

describe('test_custom_<entry> — full flow through the restored resolution table', () => {
  it('covers EXACTLY the real table (key sets compared, R10-4)', () => {
    expect(ENTRIES.map(e => e.key).sort())
      .toEqual(Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT).sort());
  });

  for (const entry of ENTRIES) {
    it(`test_custom_${entry.key.replace('|', '_')}: config.sensorMap → map → routing → ${entry.wrapperId}`, () => {
      const platform = makeMockPlatform();

      // 1. config.sensorMap → buildEffectiveSensorMap (the restored
      //    table resolves the wrapper — nothing constructed by hand).
      const map: EffectiveSensorMap = buildEffectiveSensorMap({
        userOverrides: [entry.override],
        discovery: { schemaVersion: 1, entries: [] },
        uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
        stations: [{ macAddress: MAC, name: 'Home' }],
        configMode: 'v2',
      });
      expect(map.errors, entry.key).toHaveLength(0);
      const row = map.rows.find(r => r.dataPoint === entry.override.dataPoint);
      expect(row, entry.key).toBeDefined();
      if (!row || row.kind === 'unrecognized') {
        throw new Error('unreachable');
      }
      expect(row.wrapperId, entry.key).toBe(entry.wrapperId);
      expect(row.name).toBe(entry.override.name);

      // 2. Routing map + wrapper construction from the resolved row.
      const accessory = makeMockAccessory({
        uniqueId: `${MAC}-${entry.override.dataPoint}`,
        displayName: entry.override.name as string,
      });
      const routing = buildWrapperRouting(
        platform as unknown as AmbientWeatherSensorsPlatform,
        { rows: [row], errors: [], warnings: [], notes: [] },
        () => accessory as never,
      );
      expect(routing.size, entry.key).toBe(1);

      // 3. Feed a station payload; assert the wrapper's OBSERVABLE
      //    behavior — formatted Value + MotionDetected for motion
      //    families, the fixed-unit HAP characteristic for natives.
      distributeViaRouting(
        platform as unknown as AmbientWeatherSensorsPlatform,
        routing,
        [{ macAddress: MAC, lastData: { [entry.override.dataPoint]: entry.value } }],
      );
      entry.assert(platform, accessory);
    });
  }
});

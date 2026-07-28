/**
 * `test_custom_<entry>` full-flow gate (finding-#4 Stage 4).
 *
 * One test per restored `WRAPPER_FOR_KIND_AND_MEASUREMENT` entry (15),
 * end-to-end through the REAL pipeline:
 *
 *   config.sensorMap → buildEffectiveSensorMap → buildWrapperRouting
 *   → distributeViaRouting → wrapper
 *
 * This is the Stage-4 half of the two-layer contract in
 * docs/future/wrapper-parameterization.md §"test_custom_*": Stage 3's
 * boundary tests constructed rows EXPLICITLY (table still empty); these
 * load the same custom rows through the resolution table.
 *
 * Each row varies the knobs the doc calls out where the family allows:
 * a dataPoint outside the AWN vocabulary, a distinctive name, a
 * non-default legal sourceUnit, a different displayUnit, and (for two
 * motion families) threshold/triggerDirection with a motion-state
 * assertion. Native wrappers additionally prove displayUnit is IGNORED
 * at the fixed-unit HAP characteristic.
 */

import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import {
  buildWrapperRouting,
  distributeViaRouting,
} from '../../../src/sensorMap/routing';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import type { EffectiveSensorMap, SensorMapOverride, WrapperId } from '../../../src/sensorMap/types';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
  type MockPlatform,
} from '../../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:01';

interface Entry {
  key: string;
  override: SensorMapOverride;
  wrapperId: WrapperId;
  /** Raw payload value fed through the router. */
  value: number;
  /** Native: read this characteristic; Motion: assert the EXTENDED log. */
  assert: (platform: MockPlatform, accessory: ReturnType<typeof makeMockAccessory>) => void;
}

function nativeChar(
  service: (typeof MockServices)[keyof typeof MockServices],
  characteristic: (typeof MockCharacteristics)[keyof typeof MockCharacteristics],
  expected: number,
  precision = 3,
) {
  return (_platform: MockPlatform, accessory: ReturnType<typeof makeMockAccessory>) => {
    const svc = accessory.getService(service)!;
    expect(svc.readCharacteristic(characteristic)).toBeCloseTo(expected, precision);
  };
}

function extendedLog(dataPoint: string, value: number, alsoContains?: string) {
  return (platform: MockPlatform) => {
    const line = platform.log.logs.find(l =>
      l.message.includes(`EXTENDED ${dataPoint}:`) && l.message.includes(`raw=${value}`));
    expect(line, `EXTENDED log for ${dataPoint}`).toBeDefined();
    if (alsoContains) {
      expect(line!.message).toContain(alsoContains);
    }
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
    // Non-default sourceUnit (lux): lux → canonical W/m² → lux for the
    // HAP characteristic round-trips to the original reading.
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
    // Threshold in sourceUnit + a value above it → motion fires.
    override: { dataPoint: 'barn_uv', kind: 'motion', measurement: 'uv-index', sourceUnit: 'index', name: 'Barn UV', threshold: 7 },
    wrapperId: 'uv', value: 8,
    assert: extendedLog('barn_uv', 8, 'motion=true'),
  },
  {
    key: 'motion|wind-speed',
    override: { dataPoint: 'barn_wind', kind: 'motion', measurement: 'wind-speed', sourceUnit: 'kph', displayUnit: 'mps', name: 'Barn Wind' },
    wrapperId: 'wind-speed', value: 30,
    assert: extendedLog('barn_wind', 30),
  },
  {
    key: 'motion|direction',
    override: { dataPoint: 'barn_dir', kind: 'motion', measurement: 'direction', sourceUnit: 'degrees', name: 'Barn Direction' },
    wrapperId: 'wind-direction', value: 180,
    assert: extendedLog('barn_dir', 180),
  },
  {
    key: 'motion|pressure',
    // triggerDirection flipped to 'above' (family default is 'below') +
    // a value above the threshold → motion fires under the flip.
    override: { dataPoint: 'barn_pressure', kind: 'motion', measurement: 'pressure', sourceUnit: 'hPa', displayUnit: 'inHg', name: 'Barn Pressure', threshold: 1000, triggerDirection: 'above' },
    wrapperId: 'pressure-relative', value: 1013,
    assert: extendedLog('barn_pressure', 1013, 'motion=true'),
  },
  {
    key: 'motion|rain-rate',
    override: { dataPoint: 'barn_rainrate', kind: 'motion', measurement: 'rain-rate', sourceUnit: 'mm_per_hr', name: 'Barn Rain Rate' },
    wrapperId: 'rain-rate', value: 5,
    assert: extendedLog('barn_rainrate', 5),
  },
  {
    key: 'motion|rain-accumulation',
    override: { dataPoint: 'barn_rain', kind: 'motion', measurement: 'rain-accumulation', sourceUnit: 'mm', name: 'Barn Rain' },
    wrapperId: 'rain-event', value: 12,
    assert: extendedLog('barn_rain', 12),
  },
  {
    key: 'motion|distance',
    override: { dataPoint: 'barn_strike_dist', kind: 'motion', measurement: 'distance', sourceUnit: 'km', name: 'Barn Strike Distance' },
    wrapperId: 'lightning-distance', value: 10,
    assert: extendedLog('barn_strike_dist', 10),
  },
  {
    key: 'motion|count',
    override: { dataPoint: 'barn_strikes', kind: 'motion', measurement: 'count', sourceUnit: 'count', name: 'Barn Strikes' },
    wrapperId: 'lightning-day', value: 3,
    assert: extendedLog('barn_strikes', 3),
  },
  {
    key: 'motion|timestamp',
    // Timestamp rows have no unit choice (sourceUnit fixed to 'ms').
    override: { dataPoint: 'barn_last_event', kind: 'motion', measurement: 'timestamp', name: 'Barn Last Event' },
    wrapperId: 'last-rain', value: 1750000000000,
    assert: extendedLog('barn_last_event', 1750000000000),
  },
];

describe('test_custom_<entry> — full flow through the restored resolution table', () => {
  it('covers every table entry exactly once', () => {
    expect(ENTRIES.map(e => e.key).sort()).toHaveLength(15);
    expect(new Set(ENTRIES.map(e => e.key)).size).toBe(15);
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

      // 3. Feed a station payload; the wrapper receives the value.
      distributeViaRouting(
        platform as unknown as AmbientWeatherSensorsPlatform,
        routing,
        [{ macAddress: MAC, lastData: { [entry.override.dataPoint]: entry.value } }],
      );
      entry.assert(platform, accessory);
    });
  }
});

import { describe, expect, it } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import { WindSpeedAccessory } from '../../../src/extendedSensors/windAccessory';
import { PressureRelativeAccessory } from '../../../src/extendedSensors/pressureAccessory';
import { UvAccessory } from '../../../src/extendedSensors/uvAccessory';
import {
  RainRateAccessory,
  RainDailyAccessory,
  LastRainAccessory,
} from '../../../src/extendedSensors/rainAccessory';
import {
  LightningDayAccessory,
  LightningDistanceAccessory,
  LightningLastStrikeAccessory,
} from '../../../src/extendedSensors/lightningAccessory';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';
import { makeNumericRow, makeTimestampRow } from '../../helpers/effectiveRow';

/**
 * finding-#4 Stage 2: the extended families read every runtime knob
 * (name, threshold, source/display unit, trigger direction, embed mode,
 * battery ownership) from the resolved row when one is passed. These
 * tests construct rows EXPLICITLY (the resolution table is empty until
 * Stage 4). The Value string is asserted via the debug log, which
 * carries `value="..."` — the same channel the legacy extended tests use.
 */

function motionOf(accessory: ReturnType<typeof makeMockAccessory>): unknown {
  return accessory.getService(MockServices.MotionSensor)!
    .readCharacteristic(MockCharacteristics.MotionDetected);
}

function valueStr(platform: ReturnType<typeof makeMockPlatform>): string {
  const line = [...platform.log.logs].reverse().find((l) => l.message.includes('value="'));
  return line ? /value="([^"]*)"/.exec(line.message)?.[1] ?? '' : '';
}

describe('WindSpeedAccessory — row-driven (finding #4)', () => {
  it('converts BOTH raw and threshold from a metric source unit to canonical before comparing', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-w', displayName: 'Wind' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'wind-speed', wrapperId: 'wind-speed',
        sourceUnit: 'kph', displayUnit: 'kph', dataPoint: 'barn_wind', name: 'Barn Wind',
        threshold: 30,   // 30 kph, in the row's source unit
      }),
    );
    // 40 kph → ~24.85 mph canonical; threshold 30 kph → ~18.6 mph → fires.
    wrapper.setValue(40);
    expect(motionOf(accessory)).toBe(true);
    expect(valueStr(platform)).toBe('40 kph');   // displayed in the row's display unit
    // 20 kph → ~12.4 mph canonical < 18.6 → no motion.
    wrapper.setValue(20);
    expect(motionOf(accessory)).toBe(false);
  });

  it('derives the extended label from row.name (a custom row renders its own name) and attaches battery per row', () => {
    // finding-#4 review P3: extended wrappers use `row?.name ?? legacyLabel`.
    // A custom / renamed row like "Barn Wind" must render, not fall back
    // to "Wind Speed". (Extended tiles are never station-prefixed, so
    // there is no rename risk here — that concern is native-only.)
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-w', displayName: 'Rooftop Wind Speed' });
    new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'wind-speed', wrapperId: 'wind-speed',
        sourceUnit: 'mph', displayUnit: 'mph', name: 'Barn Wind',
        hasBatterySubService: true, batteryField: 'battout',
      }),
    );
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('Barn Wind');
    expect(accessory.getService(MockServices.Battery)).toBeDefined();
  });

  it('row-driven build uses the canonical-annotated debug string (P2-B)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-w', displayName: 'Wind' });
    new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'wind-speed', wrapperId: 'wind-speed',
        sourceUnit: 'mph', displayUnit: 'mph', threshold: 25,
      }),
    ).setValue(14);
    expect(platform.log.logs.some(l => l.message.includes('canonical='))).toBe(true);
  });

  it('triggerEnabled: false disables motion even with a finite threshold', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-w', displayName: 'Wind' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'wind-speed', wrapperId: 'wind-speed',
        sourceUnit: 'mph', displayUnit: 'mph', threshold: 5, triggerEnabled: false,
      }),
    );
    wrapper.setValue(50);
    expect(motionOf(accessory)).toBe(false);
  });
});

describe('PressureRelativeAccessory — row-driven (finding #4)', () => {
  it('keeps the below-direction trigger and displays in the row unit', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-p', displayName: 'Pressure' });
    const wrapper = new PressureRelativeAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'pressure', wrapperId: 'pressure-relative',
        sourceUnit: 'inHg', displayUnit: 'hPa', threshold: 29.5, triggerDirection: 'below',
      }),
    );
    wrapper.setValue(29.0);   // below 29.5 → storm incoming → motion
    expect(motionOf(accessory)).toBe(true);
    expect(valueStr(platform)).toMatch(/hPa$/);
    wrapper.setValue(30.2);   // above → calm → no motion
    expect(motionOf(accessory)).toBe(false);
  });
});

describe('UvAccessory — row-driven (finding #4)', () => {
  it('thresholds on the row value', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-uv', displayName: 'UV' });
    const wrapper = new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'uv-index', wrapperId: 'uv',
        sourceUnit: 'index', displayUnit: 'index', threshold: 5,
      }),
    );
    wrapper.setValue(7);
    expect(motionOf(accessory)).toBe(true);
    wrapper.setValue(3);
    expect(motionOf(accessory)).toBe(false);
  });
});

describe('Rain — row-driven (finding #4)', () => {
  it('rain-rate maps a mm_per_hr display unit to mm/hr labels', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-rr', displayName: 'Rain Rate' });
    const wrapper = new RainRateAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'rain-rate', wrapperId: 'rain-rate',
        sourceUnit: 'in_per_hr', displayUnit: 'mm_per_hr', threshold: 0.1,
      }),
    );
    wrapper.setValue(0.5);   // 0.5 in/hr canonical
    expect(valueStr(platform)).toMatch(/mm\/hr$/);
    expect(motionOf(accessory)).toBe(true);
  });

  it('rain accumulation fires on any rain via the default-map 0.01 threshold the resolved row carries', () => {
    // The 0.01 family default now lives on the KNOWN rain-accumulation
    // rows in DEFAULT_SENSOR_MAP, so a resolved row carries it — the
    // wrapper reads it off the row uniformly (finding-#4 review P1). A
    // CUSTOM row that omits threshold is disabled (tested separately).
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-rd', displayName: 'Rain Daily' });
    const wrapper = new RainDailyAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'rain-accumulation', wrapperId: 'rain-daily',
        sourceUnit: 'in', displayUnit: 'in', threshold: 0.01,   // as DEFAULT_SENSOR_MAP supplies
        name: 'Rain Today',
      }),
    );
    wrapper.setValue(0.2);   // any measurable rain → motion
    expect(motionOf(accessory)).toBe(true);
    // finding-#4 review P1/P3: extended wrappers derive the label from
    // row.name (a custom/renamed row renders its own name).
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('Rain Today');
  });

  it('rain accumulation with NO threshold on a custom row is disabled (frozen-schema contract)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-rd2', displayName: 'Barn Rain' });
    const wrapper = new RainDailyAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'rain-accumulation', wrapperId: 'rain-daily',
        sourceUnit: 'in', displayUnit: 'in',   // no threshold → Infinity → disabled
      }),
    );
    wrapper.setValue(0.2);
    expect(motionOf(accessory)).toBe(false);
  });

  it('last-rain (timestamp row) never triggers motion; label comes from row.name', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-lr', displayName: 'Last Rain' });
    const wrapper = new LastRainAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeTimestampRow({ kind: 'motion', wrapperId: 'last-rain', name: 'Since Rain', dataPoint: 'lastRain' }),
    );
    wrapper.setValue(1_700_000_000_000);
    expect(motionOf(accessory)).toBe(false);
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('Since Rain');
  });
});

describe('Lightning — row-driven (finding #4)', () => {
  it('count fires on any strike via the default-map threshold=1 the resolved row carries', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-ld', displayName: 'Lightning' });
    const wrapper = new LightningDayAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'count', wrapperId: 'lightning-day',
        sourceUnit: 'count', displayUnit: 'count', threshold: 1,   // as DEFAULT_SENSOR_MAP supplies
      }),
    );
    wrapper.setValue(1);
    expect(motionOf(accessory)).toBe(true);
    wrapper.setValue(0);
    expect(motionOf(accessory)).toBe(false);
  });

  it('distance keeps the below-direction trigger and displays km', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-ldist', displayName: 'Lightning Distance' });
    const wrapper = new LightningDistanceAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'distance', wrapperId: 'lightning-distance',
        sourceUnit: 'mi', displayUnit: 'km', threshold: 10, triggerDirection: 'below',
      }),
    );
    wrapper.setValue(5);    // 5 mi < 10 mi → close strike → motion
    expect(motionOf(accessory)).toBe(true);
    expect(valueStr(platform)).toMatch(/km$/);
    wrapper.setValue(20);   // far → no motion
    expect(motionOf(accessory)).toBe(false);
  });

  it('last-strike (timestamp row) derives its label from row.name', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-ls', displayName: 'Last Strike' });
    new LightningLastStrikeAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeTimestampRow({ kind: 'motion', wrapperId: 'lightning-last-strike', name: 'Last Bolt', dataPoint: 'lightning_time' }),
    );
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('Last Bolt');
  });
});

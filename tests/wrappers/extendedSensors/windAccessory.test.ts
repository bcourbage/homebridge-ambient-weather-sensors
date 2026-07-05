import { describe, expect, it } from 'vitest';

import {
  WindDirection10mAccessory,
  WindDirectionAccessory,
  WindGustAccessory,
  WindMaxDailyGustAccessory,
  WindSpeedAccessory,
} from '../../../src/extendedSensors/windAccessory';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';

describe('WindSpeedAccessory', () => {
  it('constructs, attaches MotionSensor', () => {
    const platform = makeMockPlatform({ thresholds: { windSpeedMph: 25 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-windspeedmph', displayName: 'Wind Speed' });
    new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    expect(accessory.getService(MockServices.MotionSensor)).toBeDefined();
  });

  it.each([
    [10, false],
    [24, false],
    [25, true],   // at threshold
    [50, true],
  ])('threshold 25 mph: %d mph → motion=%s', (mph, expected) => {
    const platform = makeMockPlatform({ thresholds: { windSpeedMph: 25 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-windspeedmph', displayName: 'Wind Speed' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(mph);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(expected);
  });

  it('converts to mph unit label by default (identity)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-windspeedmph', displayName: 'Wind Speed' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(14);
    expect(platform.log.logs.some((l) => l.message.includes('value="14 mph"'))).toBe(true);
  });

  it.each([
    ['kph', 14, '23 kph'],   // 14 mph → 22.53 kph → rounds to 23
    ['mps', 14, '6 mps'],    // 14 mph → 6.26 mps → rounds to 6
    ['kts', 14, '12 kts'],   // 14 mph → 12.17 kts → rounds to 12
  ])('unit=%s: %d mph → "%s"', (unit, mph, expected) => {
    const platform = makeMockPlatform({ units: { windSpeed: unit } });
    const accessory = makeMockAccessory({ uniqueId: 'x-windspeedmph', displayName: 'Wind Speed' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(mph);
    expect(platform.log.logs.some((l) => l.message.includes(`value="${expected}"`))).toBe(true);
  });

  it('missing threshold → Infinity → never fires MotionDetected', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Wind Speed' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(999);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
  });

  it('emits Beaufort-derived Intensity in the log', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Wind Speed' });
    const wrapper = new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(30);
    expect(platform.log.logs.some((l) => l.message.includes('intensity="Strong breeze"'))).toBe(true);
  });
});

describe('WindGustAccessory', () => {
  it('uses windGustMph threshold (default suggested 35)', () => {
    const platform = makeMockPlatform({ thresholds: { windGustMph: 35 } });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Wind Gust' });
    const wrapper = new WindGustAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(34);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
    wrapper.setValue(35);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });
});

describe('WindMaxDailyGustAccessory', () => {
  it('shares the windGustMph threshold with WindGustAccessory', () => {
    const platform = makeMockPlatform({ thresholds: { windGustMph: 40 } });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Max Daily Gust' });
    const wrapper = new WindMaxDailyGustAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(40);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });
});

describe('WindDirectionAccessory', () => {
  it('MotionDetected always false (threshold is Infinity)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Wind Direction' });
    const wrapper = new WindDirectionAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    for (const deg of [0, 90, 180, 270, 359]) {
      wrapper.setValue(deg);
      expect(accessory.getService(MockServices.MotionSensor)!
        .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
    }
  });

  it('formats direction as "DEG° CARDINAL" (via sanitizer output)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Wind Direction' });
    const wrapper = new WindDirectionAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(315);
    // 315° → NW; formatValue produces "315° NW" (before HAP sanitization)
    expect(platform.log.logs.some((l) => l.message.includes('315'))).toBe(true);
    expect(platform.log.logs.some((l) => l.message.includes('NW'))).toBe(true);
  });
});

describe('WindDirection10mAccessory', () => {
  it('constructs independently from WindDirectionAccessory', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Wind Direction 10m Avg' });
    expect(() => new WindDirection10mAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    )).not.toThrow();
  });
});

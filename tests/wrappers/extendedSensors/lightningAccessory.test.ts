import { describe, expect, it } from 'vitest';

import {
  LightningDayAccessory,
  LightningDistanceAccessory,
  LightningHourAccessory,
  LightningLastStrikeAccessory,
} from '../../../src/extendedSensors/lightningAccessory';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';

describe('LightningDayAccessory (strike count today)', () => {
  it('fires motion at any strike (threshold=1)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-lightning_day', displayName: 'Lightning Strikes Today' });
    const wrapper = new LightningDayAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(0);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
    wrapper.setValue(1);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
    wrapper.setValue(42);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('formats singular/plural strike count', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Lightning' });
    const wrapper = new LightningDayAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(1);
    expect(platform.log.logs.some((l) => l.message.includes('value="1 strike"'))).toBe(true);
    wrapper.setValue(5);
    expect(platform.log.logs.some((l) => l.message.includes('value="5 strikes"'))).toBe(true);
    wrapper.setValue(0);
    expect(platform.log.logs.some((l) => l.message.includes('value="0 strikes"'))).toBe(true);
  });
});

describe('LightningHourAccessory', () => {
  it('constructs cleanly with the same count-shaped format', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Lightning Strikes This Hour' });
    expect(() => new LightningHourAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    )).not.toThrow();
  });
});

describe('LightningDistanceAccessory', () => {
  /**
   * REGRESSION FOR v1.5.0-beta.23. The constructor used to call setValue
   * from within super() before `this.distanceUnit` was assigned, which
   * caused convertDistance(rawMi, undefined) → undefined → .toFixed()
   * crash. Fixed by moving the seed-from-cache into the platform layer.
   *
   * These tests verify that constructing with a cached numeric value
   * (which was the bug trigger — an accessory being ADDED as new for
   * the first time with lightning_distance populated in AWN's response)
   * does NOT throw. The seed itself doesn't happen from the constructor
   * anymore, but setValue after construction must work regardless of
   * which unit the user configured.
   */
  it('regression (beta.23): constructs with a cached numeric value without throwing', () => {
    const platform = makeMockPlatform({
      thresholds: { lightningDistanceMi: 10 },
      units: { distance: 'mi' },
    });
    const accessory = makeMockAccessory({
      uniqueId: 'x-lightning_distance',
      displayName: 'Lightning Distance',
      value: 5,   // ← the toFixed crash trigger in beta.22
    });
    expect(() => new LightningDistanceAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    )).not.toThrow();
  });

  it('regression (beta.23): setValue works after construction with any configured unit', () => {
    for (const unit of ['mi', 'km', 'nm']) {
      const platform = makeMockPlatform({
        thresholds: { lightningDistanceMi: 10 },
        units: { distance: unit },
      });
      const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'LD' });
      const wrapper = new LightningDistanceAccessory(
        platform as unknown as AmbientWeatherSensorsPlatform,
        accessory as never,
      );
      expect(() => wrapper.setValue(5)).not.toThrow();
    }
  });

  it('uses triggerDirection=below — motion fires when a strike is CLOSER than threshold', () => {
    const platform = makeMockPlatform({
      thresholds: { lightningDistanceMi: 10 },
      units: { distance: 'mi' },
    });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Lightning Distance' });
    const wrapper = new LightningDistanceAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(15);   // far away
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
    wrapper.setValue(10);   // at boundary
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
    wrapper.setValue(3);    // close — alarm!
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('formats with correct precision — 1 decimal under 10, 0 decimals over', () => {
    const platform = makeMockPlatform({ units: { distance: 'mi' } });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'LD' });
    const wrapper = new LightningDistanceAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(3.7);
    expect(platform.log.logs.some((l) => l.message.includes('value="3.7 mi"'))).toBe(true);
    wrapper.setValue(15);
    expect(platform.log.logs.some((l) => l.message.includes('value="15 mi"'))).toBe(true);
  });
});

describe('LightningLastStrikeAccessory', () => {
  it('formats via timeSince (never triggers motion — threshold=Infinity)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'Last Lightning Strike' });
    const wrapper = new LightningLastStrikeAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    // Never had a strike — AWN reports 0 → "never"
    wrapper.setValue(0);
    expect(platform.log.logs.some((l) => l.message.includes('value="never"'))).toBe(true);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
  });
});

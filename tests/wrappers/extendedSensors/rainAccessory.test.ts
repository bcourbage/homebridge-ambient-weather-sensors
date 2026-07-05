import { describe, expect, it } from 'vitest';

import {
  LastRainAccessory,
  RainDailyAccessory,
  RainEventAccessory,
  RainMonthlyAccessory,
  RainRateAccessory,
  RainWeeklyAccessory,
  RainYearlyAccessory,
} from '../../../src/extendedSensors/rainAccessory';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';

describe('RainRateAccessory', () => {
  it('fires MotionDetected at the configured rainRateInHr threshold', () => {
    const platform = makeMockPlatform({ thresholds: { rainRateInHr: 0.01 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-hourlyrainin', displayName: 'Rain Rate' });
    const wrapper = new RainRateAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(0);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
    wrapper.setValue(0.01);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
    wrapper.setValue(0.5);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('inches unit passthrough (identity)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'RR' });
    const wrapper = new RainRateAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(0.12);
    expect(platform.log.logs.some((l) => l.message.includes('value="0.12 in/hr"'))).toBe(true);
  });

  it('mm unit conversion', () => {
    const platform = makeMockPlatform({ units: { rain: 'mm' } });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'RR' });
    const wrapper = new RainRateAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(0.1);   // 0.1 in/hr → 2.54 mm/hr
    expect(platform.log.logs.some((l) => l.message.includes('value="2.5 mm/hr"'))).toBe(true);
  });

  it('emits NWS rain-bucket Intensity', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'RR' });
    const wrapper = new RainRateAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(0.5);
    expect(platform.log.logs.some((l) => l.message.includes('intensity="Heavy"'))).toBe(true);
  });
});

describe('Rain accumulation accessories (event/daily/weekly/monthly/yearly)', () => {
  it.each([
    ['RainEvent', RainEventAccessory, 'eventrainin'],
    ['RainDaily', RainDailyAccessory, 'dailyrainin'],
    ['RainWeekly', RainWeeklyAccessory, 'weeklyrainin'],
    ['RainMonthly', RainMonthlyAccessory, 'monthlyrainin'],
    ['RainYearly', RainYearlyAccessory, 'yearlyrainin'],
  ])('%s constructs and formats with in unit', (_name, Ctor, awnKey) => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `x-${awnKey}`, displayName: 'Rain' });
    const wrapper = new Ctor(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    // Precision rules: <1 → 2 decimals, <10 → 1 decimal, else 0 decimals.
    wrapper.setValue(0.15);
    expect(platform.log.logs.some((l) => l.message.includes('value="0.15 in"'))).toBe(true);
    wrapper.setValue(1.25);
    expect(platform.log.logs.some((l) => l.message.includes('value="1.3 in"'))).toBe(true);
    wrapper.setValue(42);
    expect(platform.log.logs.some((l) => l.message.includes('value="42 in"'))).toBe(true);
  });
});

describe('LastRainAccessory', () => {
  it('formats a Unix-ms timestamp via timeSince (returns "never" for 0)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-lastRain', displayName: 'Last Rain' });
    const wrapper = new LastRainAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(0);
    expect(platform.log.logs.some((l) => l.message.includes('value="never"'))).toBe(true);
  });
});

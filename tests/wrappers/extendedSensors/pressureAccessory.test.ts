import { describe, expect, it } from 'vitest';

import {
  PressureAbsoluteAccessory,
  PressureRelativeAccessory,
} from '../../../src/extendedSensors/pressureAccessory';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';

describe('PressureRelativeAccessory', () => {
  it('uses triggerDirection=below — fires when pressure drops BELOW threshold', () => {
    // Default threshold 29.5 inHg — anything below is "low pressure system"
    const platform = makeMockPlatform({ thresholds: { pressureInHg: 29.5 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-baromrelin', displayName: 'Pressure Sea Level' });
    const wrapper = new PressureRelativeAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );

    wrapper.setValue(30.0);   // high — no motion
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);

    wrapper.setValue(29.5);   // at threshold — motion (triggerDirection is "at-or-below")
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);

    wrapper.setValue(29.0);   // storm-front territory
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });

  it('inHg passthrough (identity when unit is inHg)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'P' });
    const wrapper = new PressureRelativeAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(29.92);
    expect(platform.log.logs.some((l) => l.message.includes('value="29.92 inHg"'))).toBe(true);
  });

  it('hPa unit label + conversion factor', () => {
    const platform = makeMockPlatform({ units: { pressure: 'hPa' } });
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'P' });
    const wrapper = new PressureRelativeAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(29.92);
    // 29.92 inHg → 1013.24 hPa → rounded to 0 decimals → "1013 hPa"
    expect(platform.log.logs.some((l) => l.message.includes('value="1013 hPa"'))).toBe(true);
  });
});

describe('PressureAbsoluteAccessory', () => {
  it('is a separate accessory from PressureRelative but uses same threshold', () => {
    const platform = makeMockPlatform({ thresholds: { pressureInHg: 29.5 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-baromabsin', displayName: 'Pressure Station' });
    const wrapper = new PressureAbsoluteAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(29.4);
    expect(accessory.getService(MockServices.MotionSensor)!
      .readCharacteristic(MockCharacteristics.MotionDetected)).toBe(true);
  });
});

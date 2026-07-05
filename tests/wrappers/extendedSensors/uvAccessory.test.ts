import { describe, expect, it } from 'vitest';

import { UvAccessory } from '../../../src/extendedSensors/uvAccessory';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../../helpers/mockHomebridge';

describe('UvAccessory', () => {
  it('constructs and sets accessory metadata', () => {
    const platform = makeMockPlatform({ thresholds: { uv: 3 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-uv', displayName: 'UV Index' });
    new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Manufacturer)).toBe('Ambient Weather');
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('UV Index');
  });

  it('uses MotionSensor service (per the extended-sensor pattern)', () => {
    const platform = makeMockPlatform({ thresholds: { uv: 3 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-uv', displayName: 'UV Index' });
    new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    expect(accessory.getService(MockServices.MotionSensor)).toBeDefined();
  });

  it.each([
    [1, false],  // Low — under threshold
    [2, false],
    [3, true],   // Moderate — at threshold, motion triggers
    [5, true],
    [10, true],
  ])('MotionDetected is %s when UV is %d (threshold 3)', (uv, expected) => {
    const platform = makeMockPlatform({ thresholds: { uv: 3 } });
    const accessory = makeMockAccessory({ uniqueId: 'x-uv', displayName: 'UV Index' });
    const wrapper = new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(uv);
    const svc = accessory.getService(MockServices.MotionSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(expected);
  });

  it('rounds UV to integer for the Value characteristic', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-uv', displayName: 'UV Index' });
    const wrapper = new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(3.7);
    // Value characteristic is a custom UUID; can't easily assert on it
    // through the mock's UUID-lookup, but we can verify formatValue
    // ran by checking the debug log emitted the rounded value.
    expect(platform.log.logs.some((l) => l.message.includes('value="4"'))).toBe(true);
  });

  it('missing threshold config disables motion trigger (Infinity → never fires)', () => {
    const platform = makeMockPlatform();   // no thresholds
    const accessory = makeMockAccessory({ uniqueId: 'x-uv', displayName: 'UV Index' });
    const wrapper = new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    // Even an extreme UV should not fire MotionDetected when threshold is Infinity.
    wrapper.setValue(99);
    const svc = accessory.getService(MockServices.MotionSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.MotionDetected)).toBe(false);
  });

  it('exposes uvBucket-derived Intensity in the debug log', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-uv', displayName: 'UV Index' });
    const wrapper = new UvAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(9);
    // UV 9 → "Very High" bucket
    expect(platform.log.logs.some((l) => l.message.includes('intensity="Very High"'))).toBe(true);
  });
});

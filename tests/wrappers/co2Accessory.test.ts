import { describe, expect, it } from 'vitest';

import { Co2Accessory } from '../../src/co2Accessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';

describe('Co2Accessory', () => {
  it('constructs and populates metadata for CO2 Sensor', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'x-co2_in_aqin',
      displayName: 'Indoor CO2',
      value: 450,
    });
    new Co2Accessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('CO2 Sensor');
    const svc = accessory.getService(MockServices.CarbonDioxideSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Indoor CO2');
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideLevel)).toBe(450);
  });

  it('flags NORMAL for readings under 1000 ppm', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'CO2' });
    const wrapper = new Co2Accessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(500);
    const svc = accessory.getService(MockServices.CarbonDioxideSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideDetected)).toBe(0);   // NORMAL
    wrapper.setValue(999);
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideDetected)).toBe(0);
  });

  it('flags ABNORMAL for readings at or above 1000 ppm', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'CO2' });
    const wrapper = new Co2Accessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(1000);
    const svc = accessory.getService(MockServices.CarbonDioxideSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideDetected)).toBe(1);   // ABNORMAL
    wrapper.setValue(2500);
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideDetected)).toBe(1);
  });

  it('rounds ppm to integer and floors at zero', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'CO2' });
    const wrapper = new Co2Accessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(457.6);
    const svc = accessory.getService(MockServices.CarbonDioxideSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideLevel)).toBe(458);

    // Negative raw values (shouldn't happen but guard) → clamped to 0.
    wrapper.setValue(-10);
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideLevel)).toBe(0);
  });
});

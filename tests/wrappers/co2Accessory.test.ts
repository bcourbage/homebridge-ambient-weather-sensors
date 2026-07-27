import { describe, expect, it } from 'vitest';

import { Co2Accessory } from '../../src/co2Accessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow } from '../helpers/effectiveRow';

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

// ---- finding-#4 Stage 2: row-driven construction ----
describe('Co2Accessory — row-driven (finding #4)', () => {
  const co2Row = (overrides = {}) => makeNumericRow({
    kind: 'co2', measurement: 'co2', sourceUnit: 'ppm', displayUnit: 'ppm',
    wrapperId: 'co2', dataPoint: 'co2_in_aqin', name: 'CO2', ...overrides,
  });

  it('keeps Name platform-owned (displayName); ppm passes through with the hardcoded 1000-ppm alert intact', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-co2', displayName: 'Office CO2' });
    const wrapper = new Co2Accessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      co2Row({ name: 'CO2' }),
    );
    const svc = accessory.getService(MockServices.CarbonDioxideSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Office CO2');
    wrapper.setValue(1500);
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideLevel)).toBe(1500);
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideDetected)).toBe(1);   // ABNORMAL ≥ 1000
    wrapper.setValue(800);
    expect(svc.readCharacteristic(MockCharacteristics.CarbonDioxideDetected)).toBe(0);   // NORMAL
  });

  it('graph parity: row-driven build matches the legacy build', () => {
    const platform = makeMockPlatform();
    const legacyAcc = makeMockAccessory({ uniqueId: 'MAC-co2', displayName: 'CO2', batteryLow: false, value: 800 });
    new Co2Accessory(platform as unknown as AmbientWeatherSensorsPlatform, legacyAcc as never);
    const rowAcc = makeMockAccessory({ uniqueId: 'MAC-co2', displayName: 'CO2', batteryLow: false, value: 800 });
    new Co2Accessory(platform as unknown as AmbientWeatherSensorsPlatform, rowAcc as never,
      co2Row({ hasBatterySubService: true, batteryField: 'batt_co2' }));
    expect(rowAcc.serviceShape()).toEqual(legacyAcc.serviceShape());
  });
});

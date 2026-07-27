import { describe, expect, it } from 'vitest';

import { HumidityAccessory } from '../../src/humidityAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow } from '../helpers/effectiveRow';

describe('HumidityAccessory', () => {
  it('constructs, populates metadata, and seeds the cached value', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-humidity',
      displayName: 'Outdoor Humidity',
      value: 42,
    });

    new HumidityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );

    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Manufacturer)).toBe('Ambient Weather');
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('Humidity Sensor');

    const svc = accessory.getService(MockServices.HumiditySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Outdoor Humidity');
    expect(svc.readCharacteristic(MockCharacteristics.CurrentRelativeHumidity)).toBe(42);
  });

  it('setValue passes AWN % through unchanged (no conversion)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-humidity', displayName: 'H' });
    const wrapper = new HumidityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(75.5);
    const svc = accessory.getService(MockServices.HumiditySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentRelativeHumidity)).toBe(75.5);
  });

  it('skips seed when cached value is missing', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-humidity', displayName: 'H' });
    new HumidityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const svc = accessory.getService(MockServices.HumiditySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentRelativeHumidity)).toBeUndefined();
  });

  it('battery sub-service reflects context.batteryLow', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-humidity', displayName: 'H', batteryLow: true });
    new HumidityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const battSvc = accessory.getService(MockServices.Battery)!;
    expect(battSvc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(1);
    expect(battSvc.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(5);
  });
});

// ---- finding-#4 Stage 2: row-driven construction ----
describe('HumidityAccessory — row-driven (finding #4)', () => {
  const humRow = (overrides = {}) => makeNumericRow({
    kind: 'humidity', measurement: 'humidity', sourceUnit: 'percent', displayUnit: 'percent',
    wrapperId: 'humidity', dataPoint: 'humidity', name: 'Outdoor Humidity', ...overrides,
  });

  it('names from row.name, passes the percent reading through unchanged', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-hum', displayName: 'STALE' });
    const wrapper = new HumidityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      humRow({ name: 'Basement RH' }),
    );
    wrapper.setValue(55);
    const svc = accessory.getService(MockServices.HumiditySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Basement RH');
    expect(svc.readCharacteristic(MockCharacteristics.CurrentRelativeHumidity)).toBe(55);
  });

  it('graph parity: row-driven build matches the legacy build', () => {
    const platform = makeMockPlatform();
    const legacyAcc = makeMockAccessory({ uniqueId: 'MAC-hum', displayName: 'Outdoor Humidity', batteryLow: false, value: 55 });
    new HumidityAccessory(platform as unknown as AmbientWeatherSensorsPlatform, legacyAcc as never);
    const rowAcc = makeMockAccessory({ uniqueId: 'MAC-hum', displayName: 'Outdoor Humidity', batteryLow: false, value: 55 });
    new HumidityAccessory(platform as unknown as AmbientWeatherSensorsPlatform, rowAcc as never,
      humRow({ hasBatterySubService: true, batteryField: 'battout' }));
    expect(rowAcc.serviceShape()).toEqual(legacyAcc.serviceShape());
  });
});

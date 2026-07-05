import { describe, expect, it } from 'vitest';

import { TemperatureAccessory } from '../../src/temperatureAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';

/**
 * TemperatureAccessory wraps AWN's `tempf` (and related) fields into a
 * HomeKit TemperatureSensor. AWN reports Fahrenheit; HomeKit expects
 * Celsius. Tests pin the conversion + the seed-from-cache behavior +
 * accessory metadata population.
 */
describe('TemperatureAccessory', () => {
  const F_TO_C = (f: number) => (f - 32) * 5 / 9;

  it('constructs cleanly with a numeric cached value and populates all metadata', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-tempf',
      displayName: 'Outdoor Temperature',
      value: 68,   // 68°F
    });

    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );

    // AccessoryInformation populated
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Manufacturer)).toBe('Ambient Weather');
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('Temperature Sensor');
    expect(info.readCharacteristic(MockCharacteristics.SerialNumber)).toBe('AA:BB:CC:DD:EE:FF-tempf');

    // TemperatureSensor service created + named
    const svc = accessory.getService(MockServices.TemperatureSensor);
    expect(svc).toBeDefined();
    expect(svc!.readCharacteristic(MockCharacteristics.Name)).toBe('Outdoor Temperature');

    // Cached value seeded (68°F → 20°C)
    expect(svc!.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(68), 4);
  });

  it('skips the seed-from-cache when the cached value is not a number', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-tempf',
      displayName: 'Outdoor Temperature',
      value: 'not a number',
    });

    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );

    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    // Never seeded → the CurrentTemperature characteristic was never
    // attached (setValue is the only path that touches it). Mock
    // returns undefined for characteristics that were never added.
    expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeUndefined();
  });

  it.each([
    [32, 0],       // freezing
    [68, 20],      // room
    [100, 37.78],  // hot
    [-40, -40],    // -40 is the same in both scales (fun fact)
    [212, 100],    // boiling
  ])('setValue converts %d°F → %d°C', (fahrenheit, expectedC) => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-tempf',
      displayName: 'Outdoor Temperature',
    });
    const wrapper = new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(fahrenheit);
    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(expectedC, 2);
  });

  it('logs the conversion on setValue (debug level)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-tempf',
      displayName: 'Outdoor Temperature',
    });
    const wrapper = new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(68);
    const debugLogs = platform.log.logs.filter((l) => l.level === 'debug');
    expect(debugLogs.some((l) => l.message.includes('SET CurrentTemperature: 68'))).toBe(true);
    expect(debugLogs.some((l) => l.message.includes('°C'))).toBe(true);
  });

  it('exposes setBatteryLow (no-op when accessory has no battery context)', () => {
    // batteryLow undefined in context → setupBatteryService returns no callback → setBatteryLow is a no-op
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-tempf',
      displayName: 'Outdoor Temperature',
    });
    const wrapper = new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    // Should not throw even though no battery is attached.
    expect(() => wrapper.setBatteryLow(true)).not.toThrow();
    // No Battery sub-service attached
    expect(accessory.getService(MockServices.Battery)).toBeUndefined();
  });

  it('attaches Battery sub-service when accessory has batteryLow set + updates on setBatteryLow', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'AA:BB:CC:DD:EE:FF-tempf',
      displayName: 'Outdoor Temperature',
      batteryLow: false,
    });
    const wrapper = new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );

    const battSvc = accessory.getService(MockServices.Battery);
    expect(battSvc).toBeDefined();
    expect(battSvc!.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(0);   // BATTERY_LEVEL_NORMAL
    expect(battSvc!.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(100);

    wrapper.setBatteryLow(true);
    expect(battSvc!.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(1);   // BATTERY_LEVEL_LOW
    expect(battSvc!.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(5);
  });
});

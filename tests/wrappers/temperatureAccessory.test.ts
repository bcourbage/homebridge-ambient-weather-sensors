import { describe, expect, it } from 'vitest';

import { TemperatureAccessory } from '../../src/temperatureAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow } from '../helpers/effectiveRow';

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

// ---- finding-#4 Stage 2: row-driven construction ----
describe('TemperatureAccessory — row-driven (finding #4)', () => {
  const F_TO_C = (f: number) => (f - 32) * 5 / 9;

  function tempRow(overrides: Partial<Parameters<typeof makeNumericRow>[0]> = {}) {
    return makeNumericRow({
      kind: 'temperature', measurement: 'temperature',
      sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit',
      dataPoint: 'tempf', name: 'Outdoor Temperature',
      wrapperId: 'temperature',
      ...overrides,
    });
  }

  it('keeps the tile Name platform-owned (context.displayName), NOT row.name', () => {
    // finding-#4 review (P2-D): station composition is platform-owned.
    // The platform sets context.device.displayName (station-prefixed for
    // multi-station); the wrapper renders THAT, so a row never silently
    // renames an existing customer's accessory. `row.name` is the bare
    // sensor label the platform composes INTO displayName elsewhere.
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-tempf', displayName: 'Backyard Outdoor Temperature' });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      tempRow({ name: 'Outdoor Temperature' }),   // bare label — must NOT clobber the composed name
    );
    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Backyard Outdoor Temperature');
  });

  it('converts an AWN-native fahrenheit row exactly like the legacy F→C path', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-tempf', displayName: 'Outdoor Temperature' });
    const wrapper = new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      tempRow({ sourceUnit: 'fahrenheit' }),
    );
    wrapper.setValue(68);
    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(68), 6);
  });

  it('skips F→C for a custom sensor already reporting celsius (sourceUnit: celsius)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-barn_c', displayName: 'Barn' });
    const wrapper = new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      tempRow({ dataPoint: 'barn_c', sourceUnit: 'celsius', displayUnit: 'celsius' }),
    );
    wrapper.setValue(20);   // already °C — must NOT be re-converted
    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBe(20);
  });

  it('attaches Battery iff row.hasBatterySubService, decoupled from telemetry', () => {
    const platform = makeMockPlatform();
    // No batteryLow in context (telemetry absent this tick) but the row
    // owns the field → the sub-service must still exist, seeded NORMAL.
    const accessory = makeMockAccessory({ uniqueId: 'MAC-tempf', displayName: 'Outdoor Temperature' });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      tempRow({ hasBatterySubService: true, batteryField: 'battout' }),
    );
    const batt = accessory.getService(MockServices.Battery);
    expect(batt).toBeDefined();
    expect(batt!.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(0);   // NORMAL placeholder
  });

  it('does NOT attach Battery when row.hasBatterySubService is false', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-tempf', displayName: 'Outdoor Temperature' });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      tempRow({ hasBatterySubService: false }),
    );
    expect(accessory.getService(MockServices.Battery)).toBeUndefined();
  });

  it('legacy (row-absent) build keeps the exact v1.7 "°F → °C" debug string', () => {
    // P2-B: preserve flag-off log identity.
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-tempf', displayName: 'Outdoor' });
    new TemperatureAccessory(platform as unknown as AmbientWeatherSensorsPlatform, accessory as never)
      .setValue(68);
    expect(platform.log.logs.some(l => l.message === 'SET CurrentTemperature: 68°F → 20.00°C')).toBe(true);
  });

  it('row-driven build uses the unit-neutral debug string (no "°F")', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-tempf', displayName: 'Outdoor' });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never, tempRow(),
    ).setValue(68);
    expect(platform.log.logs.some(l => l.message === 'SET CurrentTemperature: 68 → 20.00°C')).toBe(true);
    expect(platform.log.logs.some(l => l.message.includes('°F'))).toBe(false);
  });

  it('HEAD row-driven vs legacy consistency (mock; the v1.7.0 golden in graphParity.test.ts is the authoritative migration gate)', () => {
    // Both constructions get the SAME accessory shape: same displayName,
    // same battery presence. The row-driven path must produce a
    // byte-identical HAP graph so cached accessories don't invalidate.
    const platform = makeMockPlatform();

    const legacyAcc = makeMockAccessory({
      uniqueId: 'MAC-tempf', displayName: 'Outdoor Temperature', batteryLow: false, value: 68,
    });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, legacyAcc as never,
    );

    const rowAcc = makeMockAccessory({
      uniqueId: 'MAC-tempf', displayName: 'Outdoor Temperature', batteryLow: false, value: 68,
    });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, rowAcc as never,
      tempRow({ hasBatterySubService: true, batteryField: 'battout' }),
    );

    expect(rowAcc.serviceShape()).toEqual(legacyAcc.serviceShape());
  });
});

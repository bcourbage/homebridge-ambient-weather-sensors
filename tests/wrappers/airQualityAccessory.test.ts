import { describe, expect, it } from 'vitest';

import { AirQualityAccessory } from '../../src/airQualityAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow } from '../helpers/effectiveRow';

describe('AirQualityAccessory (PM2.5 variant)', () => {
  it('constructs cleanly and defaults to PM2.5 when type is not PM10', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'x-pm25',
      displayName: 'Outdoor PM2.5',
      type: 'PM2.5',
      value: 5,
    });
    new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('PM2.5 Sensor');
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.PM2_5Density)).toBe(5);
  });

  it.each([
    [0, 1],      // EXCELLENT
    [11.9, 1],
    [12.0, 1],   // upper edge of EXCELLENT
    [12.1, 2],   // GOOD
    [35.4, 2],
    [35.5, 3],   // FAIR
    [55.4, 3],
    [55.5, 4],   // INFERIOR
    [150.4, 4],
    [150.5, 5],  // POOR
    [500, 5],
  ])('PM2.5 %d μg/m³ → AirQuality level %d', (density, expectedLevel) => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'D', type: 'PM2.5' });
    const wrapper = new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(density);
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.AirQuality)).toBe(expectedLevel);
  });

  it('rounds density to 1 decimal place and floors at zero', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'D', type: 'PM2.5' });
    const wrapper = new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(12.345);
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.PM2_5Density)).toBe(12.3);
    wrapper.setValue(-5);
    expect(svc.readCharacteristic(MockCharacteristics.PM2_5Density)).toBe(0);
  });
});

describe('AirQualityAccessory (PM10 variant)', () => {
  it('routes to PM10 characteristic when type is PM10', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'x-pm10',
      displayName: 'Indoor PM10',
      type: 'PM10',
      value: 100,
    });
    new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('PM10 Sensor');
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.PM10Density)).toBe(100);
    // PM2.5 characteristic should NOT be attached for the PM10 variant.
    expect(svc.readCharacteristic(MockCharacteristics.PM2_5Density)).toBeUndefined();
  });

  it.each([
    [0, 1],
    [54, 1],     // EXCELLENT upper edge
    [55, 2],     // GOOD
    [154, 2],
    [155, 3],    // FAIR
    [254, 3],
    [255, 4],    // INFERIOR
    [354, 4],
    [355, 5],    // POOR
    [1000, 5],
  ])('PM10 %d μg/m³ → AirQuality level %d', (density, expectedLevel) => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'D', type: 'PM10' });
    const wrapper = new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(density);
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.AirQuality)).toBe(expectedLevel);
  });
});

// ---- finding-#4 Stage 2: row-driven construction ----
describe('AirQualityAccessory — row-driven (finding #4)', () => {
  function pmRow(measurement: 'pm25' | 'pm10', overrides = {}) {
    return makeNumericRow({
      kind: measurement === 'pm10' ? 'air-quality-pm10' : 'air-quality-pm25',
      measurement, sourceUnit: 'ugm3', displayUnit: 'ugm3',
      wrapperId: measurement === 'pm10' ? 'air-quality-pm10' : 'air-quality-pm25',
      dataPoint: measurement === 'pm10' ? 'pm10_in' : 'pm25', name: 'Air Quality',
      ...overrides,
    });
  }

  it('takes the PM variant from row.measurement, NOT context.device.type', () => {
    const platform = makeMockPlatform();
    // context says PM2.5 but the row (which the factory routed here as
    // air-quality-pm10) is authoritative → PM10Density must be written.
    const accessory = makeMockAccessory({ uniqueId: 'MAC-pm10', displayName: 'AQ', type: 'PM25' });
    const wrapper = new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      pmRow('pm10'),
    );
    wrapper.setValue(60);
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.PM10Density)).toBe(60);
    expect(svc.readCharacteristic(MockCharacteristics.PM2_5Density)).toBeUndefined();
    // Model string reflects the row-derived variant.
    const info = accessory.getService(MockServices.AccessoryInformation)!;
    expect(info.readCharacteristic(MockCharacteristics.Model)).toBe('PM10 Sensor');
  });

  it('keeps Name platform-owned (displayName) and attaches battery per row', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-pm25', displayName: 'Indoor Air Quality' });
    new AirQualityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      pmRow('pm25', { name: 'Air Quality', hasBatterySubService: true, batteryField: 'batt_25' }),
    );
    const svc = accessory.getService(MockServices.AirQualitySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Indoor Air Quality');
    expect(accessory.getService(MockServices.Battery)).toBeDefined();
  });
});

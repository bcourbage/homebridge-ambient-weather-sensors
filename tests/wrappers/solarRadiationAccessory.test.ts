import { describe, expect, it } from 'vitest';

import { SolarRadiationAccessory } from '../../src/solarRadiationAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow } from '../helpers/effectiveRow';

describe('SolarRadiationAccessory', () => {
  // Conversion: lux = W/m² / 0.0079, rounded to integer.
  const wm2ToLux = (wm2: number) => Math.round(wm2 / 0.0079);

  it('constructs, populates metadata, and seeds the cached value converted to lux', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({
      uniqueId: 'x-solar',
      displayName: 'Solar Radiation',
      value: 500,   // 500 W/m² midday sunlight
    });
    new SolarRadiationAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const svc = accessory.getService(MockServices.LightSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentAmbientLightLevel)).toBe(wm2ToLux(500));
  });

  it.each([
    [0, 0],         // dark
    [100, 12658],   // 100 W/m² → ~12658 lux
    [500, 63291],   // strong sun
    [1000, 126582], // saturated bright sun
  ])('setValue converts %d W/m² → %d lux', (wm2, expectedLux) => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-solar', displayName: 'S' });
    const wrapper = new SolarRadiationAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    wrapper.setValue(wm2);
    const svc = accessory.getService(MockServices.LightSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentAmbientLightLevel)).toBe(expectedLux);
  });

  it('sets characteristic props to allow zero (dark) readings', () => {
    // setProps is called with { minValue: 0, maxValue: 200000 } — the mock's
    // setProps is a no-op, so we can't assert on the values directly. This
    // test just pins the successful construction path (setProps existing
    // is what unblocks the LightSensor from HAP's default nonzero-min rule).
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x-solar', displayName: 'S' });
    expect(() => new SolarRadiationAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    )).not.toThrow();
  });
});

// ---- finding-#4 Stage 2: row-driven construction ----
describe('SolarRadiationAccessory — row-driven (finding #4)', () => {
  function solarRow(overrides = {}) {
    return makeNumericRow({
      kind: 'light', measurement: 'illuminance', sourceUnit: 'wm2', displayUnit: 'wm2',
      wrapperId: 'solar-radiation', dataPoint: 'solarradiation', name: 'Solar Radiation',
      ...overrides,
    });
  }

  it('converts an AWN-native wm2 row exactly like the legacy W/m²→lux path', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-solar', displayName: 'Solar Radiation' });
    const wrapper = new SolarRadiationAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      solarRow({ sourceUnit: 'wm2' }),
    );
    wrapper.setValue(500);
    const svc = accessory.getService(MockServices.LightSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentAmbientLightLevel)).toBe(Math.round(500 / 0.0079));
  });

  it('skips the W/m²→lux conversion for a custom sensor reporting lux (sourceUnit: lux)', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'MAC-lux', displayName: 'Greenhouse Light' });
    const wrapper = new SolarRadiationAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      solarRow({ dataPoint: 'gh_lux', sourceUnit: 'lux', displayUnit: 'lux', name: 'Greenhouse Light' }),
    );
    wrapper.setValue(12000);   // already lux — no re-conversion
    const svc = accessory.getService(MockServices.LightSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.CurrentAmbientLightLevel)).toBe(12000);
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Greenhouse Light');
  });
});

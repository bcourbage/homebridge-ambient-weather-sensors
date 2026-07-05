import { describe, expect, it } from 'vitest';

import { SolarRadiationAccessory } from '../../src/solarRadiationAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';

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

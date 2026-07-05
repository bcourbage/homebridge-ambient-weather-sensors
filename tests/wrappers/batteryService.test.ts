import { describe, expect, it } from 'vitest';

import { setupBatteryService } from '../../src/batteryService';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';

describe('setupBatteryService', () => {
  it('returns undefined and does not attach a Battery sub-service when batteryLow is undefined', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'X' });   // no batteryLow
    const setter = setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    expect(setter).toBeUndefined();
    expect(accessory.getService(MockServices.Battery)).toBeUndefined();
  });

  it('attaches a Battery sub-service with NORMAL when batteryLow is false', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'X', batteryLow: false });
    const setter = setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    expect(setter).toBeDefined();
    const svc = accessory.getService(MockServices.Battery)!;
    expect(svc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(0);
    expect(svc.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(100);
    expect(svc.readCharacteristic(MockCharacteristics.ChargingState)).toBe(2);   // NOT_CHARGEABLE
  });

  it('attaches a Battery sub-service with LOW when batteryLow is true', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'X', batteryLow: true });
    setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const svc = accessory.getService(MockServices.Battery)!;
    expect(svc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(1);
    expect(svc.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(5);
  });

  it('returns a setter that flips subsequent low/normal state on the same sub-service', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'X', batteryLow: false });
    const setter = setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    )!;
    const svc = accessory.getService(MockServices.Battery)!;
    expect(svc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(0);

    setter(true);
    expect(svc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(1);
    expect(svc.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(5);

    setter(false);
    expect(svc.readCharacteristic(MockCharacteristics.StatusLowBattery)).toBe(0);
    expect(svc.readCharacteristic(MockCharacteristics.BatteryLevel)).toBe(100);
  });

  it('cleans up a stale Battery sub-service from a cached accessory when batteryLow is undefined', () => {
    // Simulate the beta.13 cleanup: an accessory has a stale Battery
    // service left over from an earlier plugin version that attached
    // one everywhere. On restore with batteryLow=undefined, that
    // stale service should be removed.
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'X' });  // no batteryLow
    accessory.addService(MockServices.Battery);                                 // pre-existing stale service
    expect(accessory.getService(MockServices.Battery)).toBeDefined();

    setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );

    // Battery sub-service should have been removed.
    expect(accessory.getService(MockServices.Battery)).toBeUndefined();
  });

  it('reuses an existing Battery sub-service instead of creating a duplicate', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: 'x', displayName: 'X', batteryLow: false });
    setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const first = accessory.getService(MockServices.Battery);

    // Call setup a second time — simulating a restart. Should not
    // create a duplicate; the setter should update the existing one.
    setupBatteryService(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
    );
    const second = accessory.getService(MockServices.Battery);

    expect(first).toBe(second);
  });
});

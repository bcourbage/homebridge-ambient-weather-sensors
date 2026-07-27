import { describe, expect, it } from 'vitest';

import { composeDisplayName } from '../../src/sensorMap/displayName';
import { TemperatureAccessory } from '../../src/temperatureAccessory';
import { HumidityAccessory } from '../../src/humidityAccessory';
import { WindSpeedAccessory } from '../../src/extendedSensors/windAccessory';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow } from '../helpers/effectiveRow';

/**
 * finding-#4 review (P2-D): multi-station naming must survive the
 * v1.7 → v2 migration without user intervention.
 *
 * DECISION: station composition stays PLATFORM-OWNED. v1.7 native
 * wrappers render `context.device.displayName`, which the platform
 * composes with a station prefix for multi-station accounts. The
 * row-driven build renders the SAME displayName — a row's bare
 * `name` (the sensor label, which compat does not even emit as an
 * override) never clobbers it. So an existing customer's accessory
 * Name — the identity HomeKit rooms/automations key off — is
 * preserved across the flag flip.
 */
describe('multi-station naming survives v1.7 → v2 (P2-D)', () => {
  const STATION = { macAddress: 'AA:BB:CC:DD:EE:01', name: 'Backyard' };

  it('native temperature: the row-driven tile Name equals the v1.7 station-composed displayName', () => {
    // v1.7 composes this for a 2-station account:
    const v17Name = composeDisplayName(STATION, 'tempf', /* isMultiStation */ true);
    expect(v17Name).toBe('Backyard Outdoor Temperature');   // station-prefixed

    const platform = makeMockPlatform();
    // Platform stamps the composed name onto context.device.displayName
    // (its job, unchanged). The resolved row carries only the BARE label.
    const accessory = makeMockAccessory({ uniqueId: `${STATION.macAddress}-tempf`, displayName: v17Name });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature',
        sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit', dataPoint: 'tempf',
        name: 'Outdoor Temperature',   // bare — must NOT win over the composed name
      }),
    );
    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe(v17Name);
  });

  it('native humidity: same — composed name preserved, not the bare row label', () => {
    const v17Name = composeDisplayName(STATION, 'humidity', true);
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${STATION.macAddress}-humidity`, displayName: v17Name });
    new HumidityAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'humidity', measurement: 'humidity', wrapperId: 'humidity',
        sourceUnit: 'percent', displayUnit: 'percent', dataPoint: 'humidity', name: 'Humidity',
      }),
    );
    const svc = accessory.getService(MockServices.HumiditySensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe(v17Name);
  });

  it('single-station native temperature: bare composed name preserved (no double-prefix)', () => {
    const v17Name = composeDisplayName(STATION, 'tempf', /* isMultiStation */ false);
    expect(v17Name).toBe('Outdoor Temperature');   // no prefix for single-station
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${STATION.macAddress}-tempf`, displayName: v17Name });
    new TemperatureAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature',
        sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit', dataPoint: 'tempf', name: 'Outdoor Temperature',
      }),
    );
    const svc = accessory.getService(MockServices.TemperatureSensor)!;
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Outdoor Temperature');
  });

  it('extended wind: the family label is fixed (v1.7 never station-prefixed extended tiles)', () => {
    // Extended wrappers name their tile from the hardcoded family label
    // via composeStaticName — unchanged from v1.7, and the row does not
    // alter it. So there is nothing to migrate / no rename risk.
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${STATION.macAddress}-windspeedmph`, displayName: 'Backyard Wind Speed' });
    new WindSpeedAccessory(
      platform as unknown as AmbientWeatherSensorsPlatform, accessory as never,
      makeNumericRow({
        kind: 'motion', measurement: 'wind-speed', wrapperId: 'wind-speed',
        sourceUnit: 'mph', displayUnit: 'mph', dataPoint: 'windspeedmph', name: 'Wind Speed',
      }),
    );
    const svc = accessory.getService(MockServices.MotionSensor)!;
    // composeStaticName('Wind Speed') — the v1.7 value, unchanged.
    expect(svc.readCharacteristic(MockCharacteristics.Name)).toBe('Wind Speed');
  });
});

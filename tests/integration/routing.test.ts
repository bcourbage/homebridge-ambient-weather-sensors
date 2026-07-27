import { describe, expect, it } from 'vitest';

import {
  buildWrapperRouting,
  distributeViaRouting,
} from '../../src/sensorMap/routing';
import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import type { EffectiveSensorMap } from '../../src/sensorMap/types';
import {
  MockCharacteristics,
  MockServices,
  makeMockAccessory,
  makeMockPlatform,
} from '../helpers/mockHomebridge';
import { makeNumericRow, makeTimestampRow } from '../helpers/effectiveRow';

/**
 * finding-#4 Stage 3 — platform-boundary integration test. Proves the
 * `station.lastData → routing map → coerceValue → wrapper.setValue`
 * wire directly, bypassing buildEffectiveSensorMap (the resolution
 * table is empty until Stage 4, so a custom row can't survive
 * validation yet — but the router still routes it once it exists).
 */
describe('value routing (Stage 3 boundary)', () => {
  const MAC_UPPER = 'AA:BB:CC:DD:EE:01';
  const MAC_LOWER = 'aa:bb:cc:dd:ee:01';
  const F_TO_C = (f: number) => (f - 32) * 5 / 9;

  function setup() {
    const platform = makeMockPlatform();

    // A known dataPoint, a CUSTOM dataPoint (the whole point — it would
    // never match v1's AWN-vocabulary uniqueId), and a timestamp field.
    const tempRow = makeNumericRow({
      kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature',
      sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit', dataPoint: 'tempf',
      stationMac: MAC_UPPER, name: 'Outdoor Temp',
    });
    const customRow = makeNumericRow({
      kind: 'temperature', measurement: 'temperature', wrapperId: 'temperature',
      sourceUnit: 'fahrenheit', displayUnit: 'fahrenheit', dataPoint: 'my_barn_temp',
      stationMac: MAC_UPPER, name: 'Barn Temp',
    });
    const lastRainRow = makeTimestampRow({
      kind: 'motion', wrapperId: 'last-rain', dataPoint: 'lastRain',
      stationMac: MAC_UPPER, name: 'Last Rain',
    });

    const accessories = new Map([
      [`${MAC_UPPER}-tempf`, makeMockAccessory({ uniqueId: `${MAC_UPPER}-tempf`, displayName: 'Outdoor Temp' })],
      [`${MAC_UPPER}-my_barn_temp`, makeMockAccessory({ uniqueId: `${MAC_UPPER}-my_barn_temp`, displayName: 'Barn Temp' })],
      [`${MAC_UPPER}-lastRain`, makeMockAccessory({ uniqueId: `${MAC_UPPER}-lastRain`, displayName: 'Last Rain' })],
    ]);

    const effectiveMap: EffectiveSensorMap = {
      rows: [tempRow, customRow, lastRainRow], errors: [], warnings: [], notes: [],
    };

    const routing = buildWrapperRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      effectiveMap,
      (uid) => accessories.get(uid) as never,
    );
    return { platform, routing, accessories };
  }

  it('routes a known AND a custom dataPoint through to setValue (case-insensitive MAC)', () => {
    const { platform, routing, accessories } = setup();
    expect(routing.size).toBe(3);

    distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      routing,
      // Payload MAC is lowercase — routingKey uppercases both sides.
      [{ macAddress: MAC_LOWER, lastData: { tempf: 68, my_barn_temp: 50, unmapped: 999 } }],
    );

    const tempSvc = accessories.get(`${MAC_UPPER}-tempf`)!.getService(MockServices.TemperatureSensor)!;
    expect(tempSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(68), 6);

    // The custom dataPoint reached its wrapper — the load-bearing win.
    const barnSvc = accessories.get(`${MAC_UPPER}-my_barn_temp`)!.getService(MockServices.TemperatureSensor)!;
    expect(barnSvc.readCharacteristic(MockCharacteristics.CurrentTemperature)).toBeCloseTo(F_TO_C(50), 6);
  });

  it('coerces a valid lastRain ISO string to finite ms and delivers it', () => {
    const { platform, routing } = setup();
    const iso = '2026-04-21T22:19:00.000Z';
    distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      routing,
      [{ macAddress: MAC_UPPER, lastData: { lastRain: iso } }],
    );
    // The extended wrapper's debug log carries the delivered value; a
    // finite ms means the ISO round-trip succeeded (not "never").
    const logged = platform.log.logs.some((l) =>
      l.message.includes('lastRain') && l.message.includes(`raw=${Date.parse(iso)}`));
    expect(logged).toBe(true);
  });

  it('drops a malformed lastRain ISO string without throwing or delivering', () => {
    const { platform, routing } = setup();
    expect(() => distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      routing,
      [{ macAddress: MAC_UPPER, lastData: { lastRain: 'not-a-date' } }],
    )).not.toThrow();
    // Router logged the drop; the wrapper's setValue never fired for it.
    expect(platform.log.logs.some((l) => l.message.includes('dropped') && l.message.includes('lastRain'))).toBe(true);
  });

  it('skips payload fields with no routing entry', () => {
    const { platform, routing } = setup();
    // Only `unmapped` in the payload — nothing should fire, no throw.
    expect(() => distributeViaRouting(
      platform as unknown as AmbientWeatherSensorsPlatform,
      routing,
      [{ macAddress: MAC_UPPER, lastData: { unmapped: 5 } }],
    )).not.toThrow();
  });
});

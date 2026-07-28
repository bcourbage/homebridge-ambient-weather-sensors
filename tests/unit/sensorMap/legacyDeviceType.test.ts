import { describe, expect, it } from 'vitest';

import { legacyTypeForWrapperId, LEGACY_TYPE_FOR_WRAPPER_ID } from '../../../src/sensorMap/legacyDeviceType';
import { ALL_WRAPPERS } from '../../../src/sensorMap/wrappers';

/**
 * finding-#4 Stage 4 — the wrapperId → v1.7 `context.device.type` bridge.
 * These strings are the downgrade-safety contract: a v1.7 code path
 * restoring a v2-written cache must find a `type` its
 * `createSensorWrapper` switch recognises.
 */
describe('legacyTypeForWrapperId', () => {
  it('maps every shipped wrapper id to a legacy type string', () => {
    for (const w of ALL_WRAPPERS) {
      const type = legacyTypeForWrapperId(w.id);
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);
    }
  });

  it('covers exactly the frozen wrapper vocabulary (no extras, none missing)', () => {
    const mapKeys = Object.keys(LEGACY_TYPE_FOR_WRAPPER_ID).sort();
    const wrapperIds = ALL_WRAPPERS.map(w => w.id).sort();
    expect(mapKeys).toEqual(wrapperIds);
  });

  it('pins the exact v1.7 determineSensorType/createSensorWrapper strings', () => {
    // A representative slice across native + extended families. These MUST
    // match the case labels in platform.createSensorWrapper verbatim.
    expect(legacyTypeForWrapperId('temperature')).toBe('Temperature');
    expect(legacyTypeForWrapperId('humidity')).toBe('Humidity');
    expect(legacyTypeForWrapperId('solar-radiation')).toBe('Solar Radiation');
    expect(legacyTypeForWrapperId('co2')).toBe('CO2');
    expect(legacyTypeForWrapperId('air-quality-pm25')).toBe('PM2.5');
    expect(legacyTypeForWrapperId('air-quality-pm10')).toBe('PM10');
    expect(legacyTypeForWrapperId('pressure-absolute')).toBe('PressureAbsolute');
    expect(legacyTypeForWrapperId('wind-max-daily-gust')).toBe('WindMaxDailyGust');
    expect(legacyTypeForWrapperId('lightning-last-strike')).toBe('LightningLastStrike');
    expect(legacyTypeForWrapperId('last-rain')).toBe('LastRain');
  });
});

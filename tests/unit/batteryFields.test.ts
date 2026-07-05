import { describe, expect, it } from 'vitest';

import {
  batteryFieldForSensor,
  isCanonicalSensorForBattery,
  readBatteryLow,
} from '../../src/batteryFields';

describe('batteryFieldForSensor', () => {
  describe('indoor console (battin)', () => {
    it.each([
      'tempinf',
      'humidityin',
      'feelsLikein',
      'dewPointin',
      'baromrelin',
      'baromabsin',
    ])('%s → battin', (key) => {
      expect(batteryFieldForSensor(key)).toBe('battin');
    });
  });

  describe('outdoor combo array (battout)', () => {
    it.each([
      'tempf',
      'humidity',
      'feelsLike',
      'dewPoint',
      'solarradiation',
      'uv',
      'windspeedmph',
      'windgustmph',
      'maxdailygust',
      'winddir',
      'winddir_avg10m',
      'hourlyrainin',
      'eventrainin',
      'dailyrainin',
      'weeklyrainin',
      'monthlyrainin',
      'yearlyrainin',
      'lastRain',
    ])('%s → battout', (key) => {
      expect(batteryFieldForSensor(key)).toBe('battout');
    });
  });

  describe('WH31L lightning (batt_lightning)', () => {
    it.each([
      'lightning_day',
      'lightning_hour',
      'lightning_distance',
      'lightning_time',
    ])('%s → batt_lightning', (key) => {
      expect(batteryFieldForSensor(key)).toBe('batt_lightning');
    });
  });

  describe('WH31 numbered probe channels', () => {
    it.each([
      ['temp1f', 'batt1'],
      ['temp2f', 'batt2'],
      ['temp10f', 'batt10'],
      ['humidity1', 'batt1'],
      ['humidity5', 'batt5'],
      ['feelsLike3', 'batt3'],
      ['dewPoint4', 'batt4'],
    ])('%s → %s', (key, expected) => {
      expect(batteryFieldForSensor(key)).toBe(expected);
    });
  });

  describe('AQIN family (batt_co2)', () => {
    it.each([
      'pm25_in_aqin',
      'pm10_in_aqin',
      'co2_in_aqin',
      'pm_in_temp_aqin',
      'pm_in_humidity_aqin',
      'pm25_in_24h_aqin',
    ])('%s → batt_co2 (any *_aqin)', (key) => {
      expect(batteryFieldForSensor(key)).toBe('batt_co2');
    });

    it('standalone co2 also maps to batt_co2', () => {
      expect(batteryFieldForSensor('co2')).toBe('batt_co2');
    });
  });

  describe('unmapped keys', () => {
    it.each([
      'pm25',        // outdoor PM2.5 — WH41 battery field varies, undefined until we have sample data
      'pm25_24h',    // same
      'unknownField',
      '',
    ])('%s → undefined', (key) => {
      expect(batteryFieldForSensor(key)).toBeUndefined();
    });
  });
});

describe('isCanonicalSensorForBattery', () => {
  it.each([
    ['tempf', 'battout', true],
    ['tempinf', 'battin', true],
    ['temp1f', 'batt1', true],
    ['temp10f', 'batt10', true],
    ['co2_in_aqin', 'batt_co2', true],
    ['lightning_day', 'batt_lightning', true],
  ])('%s is canonical for %s → %s', (sensor, batt, expected) => {
    expect(isCanonicalSensorForBattery(sensor, batt)).toBe(expected);
  });

  it.each([
    ['humidity', 'battout', false],       // outdoor humidity is non-canonical for battout (tempf is)
    ['humidityin', 'battin', false],      // indoor humidity is non-canonical for battin (tempinf is)
    ['lightning_distance', 'batt_lightning', false], // lightning_day is canonical, not lightning_distance
    ['pm25_in_aqin', 'batt_co2', false],  // co2_in_aqin is canonical, not pm25_in_aqin
    ['pm_in_temp_aqin', 'batt_co2', false],
    ['humidity1', 'batt1', false],        // temp1f is canonical, not humidity1
  ])('%s is NOT canonical for %s', (sensor, batt) => {
    expect(isCanonicalSensorForBattery(sensor, batt)).toBe(false);
  });

  it('returns false for unknown battery field', () => {
    expect(isCanonicalSensorForBattery('tempf', 'batt_nonexistent')).toBe(false);
  });
});

describe('readBatteryLow', () => {
  it('AWN 0 → HomeKit low (true)', () => {
    expect(readBatteryLow({ battout: 0 }, 'battout')).toBe(true);
  });

  it('AWN 1 → HomeKit normal (false)', () => {
    expect(readBatteryLow({ battout: 1 }, 'battout')).toBe(false);
  });

  it('AWN 2+ (uncommon) → still not-low', () => {
    // AWN's convention is 0/1 but future firmwares might report
    // richer values. Only 0 flags low; anything else is normal.
    expect(readBatteryLow({ battout: 2 }, 'battout')).toBe(false);
  });

  it('missing field → undefined (no sub-service should attach)', () => {
    expect(readBatteryLow({}, 'battout')).toBeUndefined();
  });

  it('non-numeric field → undefined', () => {
    expect(readBatteryLow({ battout: 'low' }, 'battout')).toBeUndefined();
    expect(readBatteryLow({ battout: null }, 'battout')).toBeUndefined();
    expect(readBatteryLow({ battout: undefined }, 'battout')).toBeUndefined();
  });

  it('undefined battery field param → undefined', () => {
    expect(readBatteryLow({ battout: 0 }, undefined)).toBeUndefined();
  });
});

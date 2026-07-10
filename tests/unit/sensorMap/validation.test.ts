import { describe, expect, it } from 'vitest';

import { defaultRowFor } from '../../../src/sensorMap/defaultMap';
import type { SensorMapOverride } from '../../../src/sensorMap/types';
import { STATION_MAC_REGEX, validateOverride } from '../../../src/sensorMap/validation';

const KNOWN = defaultRowFor('tempf')!;
const KNOWN_WIND = defaultRowFor('windspeedmph')!;

describe('STATION_MAC_REGEX', () => {
  it('accepts uppercase and lowercase MACs', () => {
    expect(STATION_MAC_REGEX.test('AA:BB:CC:DD:EE:FF')).toBe(true);
    expect(STATION_MAC_REGEX.test('aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(STATION_MAC_REGEX.test('00:1A:2B:3C:4D:5E')).toBe(true);
  });

  it('rejects non-MAC forms', () => {
    expect(STATION_MAC_REGEX.test('AA:BB:CC:DD:EE')).toBe(false);
    expect(STATION_MAC_REGEX.test('Cabin')).toBe(false);
    expect(STATION_MAC_REGEX.test('192.168.1.1')).toBe(false);
    expect(STATION_MAC_REGEX.test('')).toBe(false);
  });
});

describe('validateOverride — required fields', () => {
  it('rejects entries with no dataPoint', () => {
    const o = { dataPoint: '' } as unknown as SensorMapOverride;
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.message).toMatch(/no dataPoint/);
    }
  });

  it('accepts a bare known-datapoint override with only dataPoint', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
  });
});

describe('validateOverride — station MAC', () => {
  it('rejects name-shaped stationMac', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', stationMac: 'Cabin' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.message).toMatch(/is not a MAC address/);
    }
  });

  it('accepts a MAC-formatted stationMac', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', stationMac: 'AA:BB:CC:DD:EE:FF' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
  });
});

describe('validateOverride — known dataPoint', () => {
  it('warns on measurement override', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', measurement: 'humidity' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => /measurement is fixed/.test(w))).toBe(true);
  });

  it('rejects incompatible kind override', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', kind: 'humidity' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('error');
  });

  it('accepts a compatible kind override (temperature stays temperature)', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', kind: 'temperature' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
  });

  it('rejects illegal displayUnit', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', displayUnit: 'percent' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('error');
  });

  it('accepts legal displayUnit', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', displayUnit: 'celsius' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
  });

  it('warns on sourceUnit override for known datapoints', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', sourceUnit: 'celsius' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => /source unit is fixed/.test(w))).toBe(true);
  });
});

describe('validateOverride — custom dataPoint', () => {
  it('rejects custom row without kind', () => {
    const o: SensorMapOverride = { dataPoint: 'custom_x', measurement: 'temperature', sourceUnit: 'fahrenheit' };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/requires 'kind'/);
  });

  it('rejects custom row without measurement', () => {
    const o: SensorMapOverride = { dataPoint: 'custom_x', kind: 'temperature' };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/requires 'measurement'/);
  });

  it('rejects incompatible kind+measurement combination', () => {
    const o: SensorMapOverride = {
      dataPoint: 'custom_x',
      kind: 'humidity',
      measurement: 'temperature',
      sourceUnit: 'fahrenheit',
    };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
  });

  it('rejects custom numeric row without sourceUnit', () => {
    const o: SensorMapOverride = { dataPoint: 'custom_x', kind: 'temperature', measurement: 'temperature' };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/requires 'sourceUnit'/);
  });

  it('rejects custom numeric row with illegal sourceUnit', () => {
    const o: SensorMapOverride = {
      dataPoint: 'custom_x',
      kind: 'temperature',
      measurement: 'temperature',
      sourceUnit: 'percent',
    };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
  });

  it('accepts a well-formed custom numeric row', () => {
    const o: SensorMapOverride = {
      dataPoint: 'custom_x',
      kind: 'temperature',
      measurement: 'temperature',
      sourceUnit: 'fahrenheit',
      displayUnit: 'celsius',
    };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('ok');
  });

  it('accepts a boolean custom row and warns on ignored units', () => {
    const o: SensorMapOverride = {
      dataPoint: 'custom_leak',
      kind: 'leak',
      measurement: 'boolean',
      sourceUnit: 'fahrenheit',
    };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => /sourceUnit on boolean/.test(w))).toBe(true);
  });

  it('rejects timestamp custom row with sourceUnit other than ms', () => {
    const o: SensorMapOverride = {
      dataPoint: 'custom_ts',
      kind: 'motion',
      measurement: 'timestamp',
      sourceUnit: 'fahrenheit',
    };
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/timestamp row/);
  });
});

describe('validateOverride — motion-only fields on non-motion kinds', () => {
  it('warns on threshold on temperature row', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', threshold: 90 };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => /threshold on non-motion/.test(w))).toBe(true);
  });

  it('does not warn on threshold on wind (motion) row', () => {
    const o: SensorMapOverride = { dataPoint: 'windspeedmph', threshold: 30 };
    const r = validateOverride(o, KNOWN_WIND);
    expect(r.status).toBe('ok');
    expect(r.warnings.filter(w => /threshold on non-motion/.test(w))).toHaveLength(0);
  });
});

describe('validateOverride — wrapperId rejection', () => {
  it('rejects entries containing wrapperId', () => {
    const o = { dataPoint: 'tempf', wrapperId: 'temperature' } as unknown as SensorMapOverride;
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/wrapperId is not a valid/);
  });
});

import { describe, expect, it } from 'vitest';

import { defaultRowFor } from '../../../src/sensorMap/defaultMap';
import type { SensorMapOverride } from '../../../src/sensorMap/types';
import {
  STATION_MAC_REGEX,
  validateOverride,
  validateOverrideBody,
  validateOverrideIdentity,
} from '../../../src/sensorMap/validation';

const KNOWN = defaultRowFor('tempf')!;
const KNOWN_WIND = defaultRowFor('windspeedmph')!;
const KNOWN_DIR = defaultRowFor('winddir')!;
const KNOWN_LASTRAIN = defaultRowFor('lastRain')!;

describe('validateOverrideBody — non-triggering measurements (finding-#4 review, P1-B)', () => {
  it('warn-strips threshold / triggerDirection / triggerEnabled on a direction row', () => {
    const r = validateOverride(
      { dataPoint: 'winddir', threshold: 90, triggerDirection: 'below', triggerEnabled: false },
      KNOWN_DIR,
    );
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => w.code === 'ignored-non-triggering-threshold')).toBe(true);
    expect(r.warnings.some(w => w.code === 'ignored-non-triggering-triggerdirection')).toBe(true);
    expect(r.warnings.some(w => w.code === 'ignored-non-triggering-triggerenabled')).toBe(true);
    if (r.status === 'ok') {
      expect(r.validated.threshold).toBeUndefined();
      expect(r.validated.triggerDirection).toBeUndefined();
      expect(r.validated.triggerEnabled).toBeUndefined();
    }
  });

  it('warn-strips threshold on a timestamp row (last-rain)', () => {
    const r = validateOverride({ dataPoint: 'lastRain', threshold: 5 }, KNOWN_LASTRAIN);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => w.code === 'ignored-non-triggering-threshold')).toBe(true);
    if (r.status === 'ok') expect(r.validated.threshold).toBeUndefined();
  });

  it('does NOT strip threshold on a triggering motion measurement (wind-speed)', () => {
    const r = validateOverride({ dataPoint: 'windspeedmph', threshold: 30 }, KNOWN_WIND);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => w.code.startsWith('ignored-non-triggering'))).toBe(false);
    if (r.status === 'ok') expect(r.validated.threshold).toBe(30);
  });
});

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
    expect(r.warnings.some(w => /measurement is fixed/.test(w.message))).toBe(true);
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

  it('rejects illegal displayUnit on an extended (motion-family) dataPoint', () => {
    // wind-speed's displayUnit IS consumed by the wrapper, so an
    // illegal value is a hard error.
    const o: SensorMapOverride = { dataPoint: 'windspeedmph', displayUnit: 'percent' };
    const r = validateOverride(o, KNOWN_WIND);
    expect(r.status).toBe('error');
  });

  it('accepts legal displayUnit on an extended dataPoint', () => {
    const o: SensorMapOverride = { dataPoint: 'windspeedmph', displayUnit: 'kph' };
    const r = validateOverride(o, KNOWN_WIND);
    expect(r.status).toBe('ok');
    // Extended displayUnit is meaningful — NOT stripped.
    expect(r.warnings.some(w => w.code === 'ignored-native-displayunit')).toBe(false);
  });

  it('warn-strips displayUnit on a native-HAP dataPoint (finding #4)', () => {
    // temperature renders in a fixed HomeKit unit (°C); displayUnit is
    // ignored regardless of whether the value is otherwise legal.
    const o: SensorMapOverride = { dataPoint: 'tempf', displayUnit: 'celsius' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => w.code === 'ignored-native-displayunit')).toBe(true);
  });

  it('warns on sourceUnit override for known datapoints', () => {
    const o: SensorMapOverride = { dataPoint: 'tempf', sourceUnit: 'celsius' };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
    expect(r.warnings.some(w => /source unit is fixed/.test(w.message))).toBe(true);
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
    expect(r.warnings.some(w => /sourceUnit on boolean/.test(w.message))).toBe(true);
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
    expect(r.warnings.some(w => /threshold on non-motion/.test(w.message))).toBe(true);
  });

  it('does not warn on threshold on wind (motion) row', () => {
    const o: SensorMapOverride = { dataPoint: 'windspeedmph', threshold: 30 };
    const r = validateOverride(o, KNOWN_WIND);
    expect(r.status).toBe('ok');
    expect(r.warnings.filter(w => /threshold on non-motion/.test(w.message))).toHaveLength(0);
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

// ---- Follow-up finding #2: unknown-key rejection --------------------

describe('validateOverride — unknown-key rejection (typos)', () => {
  it('rejects entries with an unknown key like triggerEnabledd', () => {
    const o = { dataPoint: 'tempf', triggerEnabledd: true } as unknown as SensorMapOverride;
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/Unknown override field 'triggerEnabledd'/);
  });

  it('rejects unknown keys on custom rows too', () => {
    const o = {
      dataPoint: 'custom_x',
      kind: 'temperature',
      measurement: 'temperature',
      sourceUnit: 'fahrenheit',
      embed_name: true,
    } as unknown as SensorMapOverride;
    const r = validateOverride(o, undefined);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/Unknown override field 'embed_name'/);
  });

  it('accepts entries whose every key is in the allowed set', () => {
    const o: SensorMapOverride = {
      dataPoint: 'tempf',
      stationMac: 'AA:BB:CC:DD:EE:FF',
      name: 'Kitchen',
      displayUnit: 'celsius',
    };
    const r = validateOverride(o, KNOWN);
    expect(r.status).toBe('ok');
  });
});

// ---- Follow-up finding #3: timestamp rules on known rows -----------

describe('validateOverride — timestamp/boolean rules apply to known rows', () => {
  const KNOWN_LAST_RAIN = defaultRowFor('lastRain')!;
  it('rejects sourceUnit other than ms on a known timestamp row (lastRain)', () => {
    const o = { dataPoint: 'lastRain', sourceUnit: 'fahrenheit' } as unknown as SensorMapOverride;
    const r = validateOverride(o, KNOWN_LAST_RAIN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/timestamp row/);
  });

  it('warns and strips displayUnit on a known timestamp row', () => {
    const o = { dataPoint: 'lastRain', displayUnit: 'celsius' } as unknown as SensorMapOverride;
    const r = validateOverride(o, KNOWN_LAST_RAIN);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.validated.displayUnit).toBeUndefined();
      expect(r.warnings.some(w => /displayUnit on timestamp/.test(w.message))).toBe(true);
    }
  });
});

// ---- Follow-up finding #5: structured warnings (code + field) -----

describe('OverrideWarning shape (finding #5)', () => {
  it('emits a code + field on ignored-non-motion-threshold', () => {
    const r = validateOverrideBody(
      { threshold: 90 } as Record<string, unknown>,
      { dataPoint: 'tempf' },
      KNOWN,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      const w = r.warnings.find(x => x.code === 'ignored-non-motion-threshold');
      expect(w).toBeDefined();
      expect(w?.field).toBe('threshold');
    }
  });

  it('emits code + field on measurement override for known rows', () => {
    const r = validateOverrideBody(
      { measurement: 'humidity' } as Record<string, unknown>,
      { dataPoint: 'tempf' },
      KNOWN,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      const w = r.warnings.find(x => x.code === 'ignored-measurement-fixed');
      expect(w).toBeDefined();
      expect(w?.field).toBe('measurement');
    }
  });
});

// ---- Review finding #10: runtime validation at JSON boundary --------

describe('validateOverrideIdentity — Phase 1', () => {
  it('rejects a non-object input', () => {
    expect(validateOverrideIdentity(null).status).toBe('error');
    expect(validateOverrideIdentity('tempf').status).toBe('error');
    expect(validateOverrideIdentity(42).status).toBe('error');
    expect(validateOverrideIdentity([]).status).toBe('error');
  });

  it('rejects missing dataPoint', () => {
    const r = validateOverrideIdentity({ stationMac: 'AA:BB:CC:DD:EE:01' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/no dataPoint/);
  });

  it('rejects non-string dataPoint', () => {
    const r = validateOverrideIdentity({ dataPoint: 42 });
    expect(r.status).toBe('error');
  });

  it('rejects malformed stationMac', () => {
    const r = validateOverrideIdentity({ dataPoint: 'tempf', stationMac: 'Cabin' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/is not a MAC address/);
  });

  it('uppercases stationMac in the returned identity', () => {
    const r = validateOverrideIdentity({ dataPoint: 'tempf', stationMac: 'aa:bb:cc:dd:ee:01' });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.identity.stationMac).toBe('AA:BB:CC:DD:EE:01');
  });
});

describe('validateOverrideBody — runtime type checks (finding #10)', () => {
  const identity = { dataPoint: 'tempf' };

  it('rejects a non-string kind', () => {
    const r = validateOverrideBody({ kind: 42 } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/is not a valid SensorKind/);
  });

  it('rejects an out-of-vocabulary kind value', () => {
    const r = validateOverrideBody({ kind: 'weather' } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/is not a valid SensorKind/);
  });

  it('rejects a numeric batteryField', () => {
    const r = validateOverrideBody({ batteryField: 42 } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/batteryField/);
  });

  it('rejects a string triggerEnabled', () => {
    const r = validateOverrideBody({ triggerEnabled: 'false' } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/triggerEnabled/);
  });

  it('rejects a non-finite threshold', () => {
    const r = validateOverrideBody({ threshold: Number.POSITIVE_INFINITY } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/threshold/);
  });

  it('rejects a numeric name', () => {
    const r = validateOverrideBody({ name: 100 } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/name/);
  });

  it('rejects an out-of-enum triggerDirection', () => {
    const r = validateOverrideBody({ triggerDirection: 'sideways' } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/triggerDirection/);
  });

  it('accepts a well-typed override and returns a validated SensorMapOverride', () => {
    const r = validateOverrideBody({ name: 'Outside' } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.validated.name).toBe('Outside');
      expect(r.validated.dataPoint).toBe('tempf');
    }
  });

  it('accepts an explicit batteryField: null', () => {
    const r = validateOverrideBody({ batteryField: null } as Record<string, unknown>, identity, KNOWN);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.validated.batteryField).toBeNull();
  });
});

// ---- Review finding #9: warnings surfaced + fields stripped --------

describe('validateOverrideBody — non-motion field stripping (finding #9)', () => {
  it('strips threshold from the validated override on a non-motion row', () => {
    const r = validateOverrideBody(
      { threshold: 90 } as Record<string, unknown>,
      { dataPoint: 'tempf' },
      KNOWN,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.validated.threshold).toBeUndefined();
      expect(r.warnings.some(w => /threshold on non-motion/.test(w.message))).toBe(true);
    }
  });

  it('preserves threshold on a motion row', () => {
    const r = validateOverrideBody(
      { threshold: 25 } as Record<string, unknown>,
      { dataPoint: 'windspeedmph' },
      KNOWN_WIND,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.validated.threshold).toBe(25);
  });

  it('strips embedName=true from a non-motion row and warns', () => {
    const r = validateOverrideBody(
      { embedName: true } as Record<string, unknown>,
      { dataPoint: 'tempf' },
      KNOWN,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.validated.embedName).toBeUndefined();
      expect(r.warnings.some(w => /embedName on non-motion/.test(w.message))).toBe(true);
    }
  });

  it('strips displayUnit and warns on a boolean-measurement custom row', () => {
    const r = validateOverrideBody(
      {
        kind: 'leak',
        measurement: 'boolean',
        displayUnit: 'fahrenheit',
      } as Record<string, unknown>,
      { dataPoint: 'custom_leak' },
      undefined,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.validated.displayUnit).toBeUndefined();
      expect(r.warnings.some(w => /displayUnit on boolean/.test(w.message))).toBe(true);
    }
  });
});

describe('validateOverrideBody — name sanitization (review R3-6)', () => {
  it('warn-strips a name that sanitizes to empty; the row keeps its default name', () => {
    for (const bad of ['---', '   ', '!!!', 'ːː']) {
      const r = validateOverride({ dataPoint: 'tempf', name: bad }, KNOWN);
      expect(r.status, `name=${JSON.stringify(bad)}`).toBe('ok');
      if (r.status === 'ok') {
        expect(r.validated.name).toBeUndefined();
        expect(r.warnings.some(w => w.code === 'ignored-unsanitizable-name')).toBe(true);
      }
    }
  });

  it('keeps a name that sanitizes non-empty (punctuation stripped later at the HAP sink)', () => {
    const r = validateOverride({ dataPoint: 'tempf', name: 'Patio (South)' }, KNOWN);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.validated.name).toBe('Patio (South)');
      expect(r.warnings.some(w => w.code === 'ignored-unsanitizable-name')).toBe(false);
    }
  });
});

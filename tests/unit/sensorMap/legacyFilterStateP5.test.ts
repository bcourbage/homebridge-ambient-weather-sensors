import { describe, expect, it } from 'vitest';
import { legacyRowFilterState } from '../../../src/sensorMap/compat';

const MAC = 'AA:BB:CC:DD:EE:01';
const unknown = { macAddress: MAC, name: '' };
const named = { macAddress: MAC, name: 'Barn' };

describe('P5 legacy filter membership with incomplete station metadata', () => {
  it.each([
    { config: {}, want: 'enabled' },
    { config: { includeOnly: [MAC] }, want: 'enabled' },
    { config: { includeOnly: [`${MAC}-tempf`] }, want: 'enabled' },
    { config: { includeOnly: ['tempf'] }, want: 'enabled' },
    { config: { includeOnly: ['Outdoor Temperature'] }, want: 'enabled' },
    { config: { includeOnly: ['Barn'] }, want: 'unknown' },
    { config: { includeOnly: ['Barn Outdoor Temperature'] }, want: 'unknown' },
    { config: { excludeSensors: ['Barn'] }, want: 'unknown' },
    { config: { excludeSensors: ['Barn Outdoor Temperature'] }, want: 'unknown' },
    { config: { excludeSensors: [MAC] }, want: 'disabled' },
    { config: { excludeSensors: [`${MAC}-tempf`] }, want: 'disabled' },
    { config: { excludeSensors: ['tempf'] }, want: 'disabled' },
    { config: { excludeSensors: ['Outdoor Temperature'] }, want: 'disabled' },
    { config: { includeOnly: ['Barn'], excludeSensors: ['Barn'] }, want: 'disabled' },
    { config: { includeOnly: [MAC], excludeSensors: ['Barn'] }, want: 'unknown' },
    { config: { includeOnly: ['Barn'], excludeSensors: ['tempf'] }, want: 'disabled' },
  ])('$config -> $want', ({ config, want }) => {
    expect(legacyRowFilterState({ temperatureSensors: true, ...config }, 'tempf', unknown, true)).toBe(want);
  });

  it.each(['Barn', 'Barn Outdoor Temperature'])('uses all original matching forms once station names are known: %s', token => {
    expect(legacyRowFilterState({ temperatureSensors: true, includeOnly: [token] }, 'tempf', named, true)).toBe('enabled');
    expect(legacyRowFilterState({ temperatureSensors: true, excludeSensors: [token] }, 'tempf', named, true)).toBe('disabled');
    expect(legacyRowFilterState({ temperatureSensors: true, includeOnly: [token] }, 'tempf', { ...named, name: 'House' }, true)).toBe('disabled');
  });

  it('category and threshold disable decisions do not depend on station names', () => {
    expect(legacyRowFilterState({ temperatureSensors: false, includeOnly: ['Barn'] }, 'tempf', unknown, true)).toBe('disabled');
    expect(legacyRowFilterState({ extendedSensors: true, windSensors: true, thresholds: { windSpeedEnabled: false },
      excludeSensors: ['Barn'] }, 'windspeedmph', unknown, true)).toBe('disabled');
  });

  it('does not turn a cached/custom identity into a legacy definition', () => {
    expect(legacyRowFilterState({ includeOnly: ['Barn'] }, 'custom_counter', unknown, true)).toBeUndefined();
  });
});

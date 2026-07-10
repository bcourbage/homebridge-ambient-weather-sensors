import { describe, expect, it } from 'vitest';

import { computeStructuralSignature, UNRECOGNIZED_SIGNATURE } from '../../../src/sensorMap/structuralSignature';
import {
  TEMPERATURE_WRAPPER,
  WIND_SPEED_WRAPPER,
  LAST_RAIN_WRAPPER,
} from '../../../src/sensorMap/wrappers';

describe('computeStructuralSignature', () => {
  it('unrecognized rows produce the sentinel', () => {
    expect(computeStructuralSignature('unrecognized', 'temperature', false, TEMPERATURE_WRAPPER)).toBe(UNRECOGNIZED_SIGNATURE);
  });

  it('encodes kind, measurement, battery, wrapper id + version', () => {
    expect(computeStructuralSignature('temperature', 'temperature', true, TEMPERATURE_WRAPPER))
      .toBe('temperature|measurement:temperature|battery:1|wrapper:temperature:v1');
  });

  it('battery flag flips 0/1', () => {
    expect(computeStructuralSignature('temperature', 'temperature', false, TEMPERATURE_WRAPPER))
      .toBe('temperature|measurement:temperature|battery:0|wrapper:temperature:v1');
  });

  it('motion + wind-speed uses wind-speed wrapper id', () => {
    expect(computeStructuralSignature('motion', 'wind-speed', true, WIND_SPEED_WRAPPER))
      .toBe('motion|measurement:wind-speed|battery:1|wrapper:wind-speed:v1');
  });

  it('motion + timestamp uses last-rain wrapper id', () => {
    expect(computeStructuralSignature('motion', 'timestamp', false, LAST_RAIN_WRAPPER))
      .toBe('motion|measurement:timestamp|battery:0|wrapper:last-rain:v1');
  });

  it('is deterministic — same inputs produce identical output', () => {
    const a = computeStructuralSignature('temperature', 'temperature', true, TEMPERATURE_WRAPPER);
    const b = computeStructuralSignature('temperature', 'temperature', true, TEMPERATURE_WRAPPER);
    expect(a).toBe(b);
  });
});

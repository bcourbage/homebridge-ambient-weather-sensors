/**
 * Real-HAP Model/Name validation (review R5-2).
 *
 * Constructs extended wrappers against REAL @homebridge/hap-nodejs (the
 * graph-parity harness) with the pathological row names validation
 * accepts, and asserts the AccessoryInformation.Model characteristic
 * carries OUR normalized value — never hap-nodejs's silent
 * "Default-Model" replacement (which it substitutes for values it
 * rejects, e.g. length ≤ 1).
 */

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-ESM helper shared with the fixture generator.
import { makeHapPlatform, makeHapAccessory } from '../helpers/hapGraph.mjs';
import { PressureAbsoluteAccessory } from '../../src/extendedSensors/pressureAccessory';
import { hapModelValue, truncateHapName } from '../../src/sensorMap/displayName';
import { makeNumericRow } from '../helpers/effectiveRow';
import type { AmbientWeatherSensorsPlatform } from '../../src/platform';
import type { PlatformAccessory } from 'homebridge';

function buildWithRowName(name: string): { model: unknown } {
  const platform = makeHapPlatform() as unknown as AmbientWeatherSensorsPlatform;
  const accessory = makeHapAccessory({
    uniqueId: 'AA:BB:CC:DD:EE:01-baromabsin',
    displayName: 'Pressure Station',
    value: 29.92,
    type: 'PressureAbsolute',
  }) as unknown as PlatformAccessory;
  const row = makeNumericRow({
    kind: 'motion', measurement: 'pressure', wrapperId: 'pressure-absolute',
    sourceUnit: 'inHg', displayUnit: 'inHg', dataPoint: 'baromabsin', name,
  });
  new PressureAbsoluteAccessory(platform, accessory, row);
  const info = accessory.getService(
    (platform as unknown as { Service: { AccessoryInformation: never } }).Service.AccessoryInformation,
  )!;
  const model = (info as unknown as {
    getCharacteristic(n: string): { value: unknown };
  }).getCharacteristic('Model').value;
  return { model };
}

describe('AccessoryInformation.Model against real HAP (R5-2)', () => {
  it('a one-character row name falls back to the AWN key, never "Default-Model"', () => {
    const { model } = buildWithRowName('X');
    expect(model).toBe('baromabsin');           // hapModelValue fallback
    expect(model).not.toBe('Default-Model');
  });

  it('long leading whitespace is trimmed before truncation (never empty)', () => {
    const { model } = buildWithRowName(' '.repeat(70) + 'Pressure (Station)');
    expect(model).toBe('Pressure (Station)');
    expect(model).not.toBe('Default-Model');
  });

  it('63 ASCII chars + emoji truncates on a code-point boundary (no unpaired surrogate)', () => {
    const name = 'A'.repeat(63) + '🌡️ extra';
    const { model } = buildWithRowName(name);
    const s = String(model);
    expect(s.length).toBeLessThanOrEqual(64);
    // No unpaired surrogate anywhere (a lone high surrogate at the cut
    // would make the string ill-formed UTF-16).
    expect([...s].every(ch => !/[\ud800-\udfff]/.test(ch) || ch.length === 2)).toBe(true);
    const lastUnit = s.charCodeAt(s.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
    expect(s.startsWith('A'.repeat(63))).toBe(true);
    expect(s).not.toBe('Default-Model');
  });

  it('a healthy long rename is truncated and accepted by real HAP', () => {
    const long = 'L'.repeat(100);
    const { model } = buildWithRowName(long);
    expect(model).toBe('L'.repeat(64));
    expect(model).not.toBe('Default-Model');
  });
});

describe('helper unit edges (R5-2)', () => {
  it('hapModelValue fallback chain', () => {
    expect(hapModelValue('Pressure (Station)', 'baromabsin')).toBe('Pressure (Station)');
    expect(hapModelValue('X', 'baromabsin')).toBe('baromabsin');
    expect(hapModelValue('X', 'y')).toBe('Ambient Weather Sensor');
    expect(hapModelValue('   ', 'uv')).toBe('uv');
  });

  it('truncateHapName trims before truncating and never splits a surrogate pair', () => {
    expect(truncateHapName(' '.repeat(70) + 'Name')).toBe('Name');
    const cut = truncateHapName('A'.repeat(63) + '🌡');
    expect(cut).toBe('A'.repeat(63));             // the pair would split at unit 64 — dropped
    expect(cut.length).toBeLessThanOrEqual(64);
  });
});

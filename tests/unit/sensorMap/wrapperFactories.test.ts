import { describe, expect, it } from 'vitest';

import {
  FACTORIES,
  WRAPPER_SPEC,
  assertRowMatchesWrapperId,
  instantiateWrapper,
} from '../../../src/sensorMap/wrapperFactories';
import { ALL_WRAPPERS } from '../../../src/sensorMap/wrappers';
import { AmbientWeatherSensorsPlatform } from '../../../src/platform';
import { TemperatureAccessory } from '../../../src/temperatureAccessory';
import { AirQualityAccessory } from '../../../src/airQualityAccessory';
import { WindSpeedAccessory } from '../../../src/extendedSensors/windAccessory';
import type {
  EffectiveSensorRow,
  NumericSensorRow,
  UnrecognizedRow,
  WrapperId,
} from '../../../src/sensorMap/types';
import { makeMockAccessory, makeMockPlatform } from '../../helpers/mockHomebridge';

const MAC = 'AA:BB:CC:DD:EE:FF';

/**
 * Build a minimal-but-valid configured row for a given wrapperId,
 * pulling the `(kind, measurement)` straight from WRAPPER_SPEC so the
 * row is self-consistent by construction. Only numeric-family wrappers
 * read `sourceUnit`/`displayUnit`, and the row-consuming constructors
 * DO consume them now — we still hand every row the same
 * fahrenheit/celsius pair because `toCanonical`/`toDisplayUnit` treat
 * a family-foreign unit as identity, so the dummy pair is harmless for
 * non-temperature families and exact for temperature. The
 * discriminated-union type is satisfied because WRAPPER_SPEC never
 * pairs a numeric wrapperId with the timestamp / boolean measurements
 * that forbid units.
 */
function rowFor(wrapperId: WrapperId): EffectiveSensorRow {
  const spec = WRAPPER_SPEC[wrapperId];
  const row = {
    kind: spec.kind,
    measurement: spec.measurement,
    dataPoint: `dp_${wrapperId}`,
    stationMac: MAC,
    name: `Sensor ${wrapperId}`,
    triggerEnabled: true,
    triggerDirection: 'above',
    batteryField: null,
    hasBatterySubService: false,
    embedName: false,
    enabled: true,
    structuralSignature: `sig-${wrapperId}`,
    wrapperId,
    // Numeric-family constructors consume these units for real (unit
    // conversion + display formatting); a family-foreign unit converts
    // as identity, so this fixed pair is harmless everywhere and exact
    // for temperature. Timestamp/boolean measurements forbid units, but
    // WRAPPER_SPEC pairs those measurements only with wrapperIds whose
    // rows are still ConfiguredRowBase — the cast below papers over
    // the fact that we hand every row numeric units.
    sourceUnit: 'fahrenheit',
    displayUnit: 'celsius',
  };
  return row as unknown as EffectiveSensorRow;
}

describe('WRAPPER_SPEC', () => {
  it('has exactly one entry per registered wrapper id', () => {
    const specKeys = Object.keys(WRAPPER_SPEC).sort();
    const wrapperIds = ALL_WRAPPERS.map(w => w.id).sort();
    expect(specKeys).toEqual(wrapperIds);
  });

  it('every entry names a non-empty kind and measurement', () => {
    for (const [id, { kind, measurement }] of Object.entries(WRAPPER_SPEC)) {
      expect(kind, `${id}.kind`).toBeTruthy();
      expect(measurement, `${id}.measurement`).toBeTruthy();
    }
  });

  it('the two air-quality ids share a kind family but differ in measurement', () => {
    expect(WRAPPER_SPEC['air-quality-pm25'].measurement).toBe('pm25');
    expect(WRAPPER_SPEC['air-quality-pm10'].measurement).toBe('pm10');
    expect(WRAPPER_SPEC['air-quality-pm25'].measurement)
      .not.toBe(WRAPPER_SPEC['air-quality-pm10'].measurement);
  });
});

describe('FACTORIES', () => {
  it('has exactly one factory per registered wrapper id', () => {
    const factoryKeys = Object.keys(FACTORIES).sort();
    const wrapperIds = ALL_WRAPPERS.map(w => w.id).sort();
    expect(factoryKeys).toEqual(wrapperIds);
  });

  it('every factory is a function', () => {
    for (const [id, factory] of Object.entries(FACTORIES)) {
      expect(typeof factory, id).toBe('function');
    }
  });
});

describe('assertRowMatchesWrapperId', () => {
  it('passes for a row whose (kind, measurement) matches its wrapperId', () => {
    expect(() => assertRowMatchesWrapperId(rowFor('temperature'))).not.toThrow();
    expect(() => assertRowMatchesWrapperId(rowFor('wind-speed'))).not.toThrow();
    expect(() => assertRowMatchesWrapperId(rowFor('last-rain'))).not.toThrow();
  });

  it('throws when the row measurement drifted from its wrapperId', () => {
    // A row that claims wrapperId 'temperature' but carries a humidity
    // measurement — the exact drift the runtime twin exists to catch.
    const drifted = {
      ...(rowFor('temperature') as NumericSensorRow),
      measurement: 'humidity',
    } as unknown as EffectiveSensorRow;
    expect(() => assertRowMatchesWrapperId(drifted))
      .toThrow(/expects \(temperature, temperature\)/);
  });

  it('throws when the row kind drifted from its wrapperId', () => {
    const drifted = {
      ...(rowFor('temperature') as NumericSensorRow),
      kind: 'humidity',
    } as unknown as EffectiveSensorRow;
    expect(() => assertRowMatchesWrapperId(drifted)).toThrow(/expects \(temperature/);
  });

  it('returns without throwing for an unrecognized row (no wrapper)', () => {
    const unrec: UnrecognizedRow = {
      kind: 'unrecognized',
      enabled: false,
      dataPoint: 'weird',
      stationMac: MAC,
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
    };
    expect(() => assertRowMatchesWrapperId(unrec)).not.toThrow();
  });
});

describe('instantiateWrapper', () => {
  it('constructs the correct concrete wrapper for a temperature row', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-tempf`, displayName: 'Outdoor' });
    const wrapper = instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      rowFor('temperature'),
    );
    expect(wrapper).toBeInstanceOf(TemperatureAccessory);
    expect(typeof wrapper.setValue).toBe('function');
  });

  it('constructs the correct concrete wrapper for a wind-speed row', () => {
    const platform = makeMockPlatform({ thresholds: { windSpeedMph: 25 } });
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-windspeedmph`, displayName: 'Wind Speed' });
    const wrapper = instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      rowFor('wind-speed'),
    );
    expect(wrapper).toBeInstanceOf(WindSpeedAccessory);
  });

  it('routes both air-quality variants to the shared AirQualityAccessory class', () => {
    const platform = makeMockPlatform();
    for (const id of ['air-quality-pm25', 'air-quality-pm10'] as const) {
      const accessory = makeMockAccessory({ uniqueId: `${MAC}-${id}`, displayName: id });
      const wrapper = instantiateWrapper(
        platform as unknown as AmbientWeatherSensorsPlatform,
        accessory as never,
        rowFor(id),
      );
      expect(wrapper).toBeInstanceOf(AirQualityAccessory);
    }
  });

  it('throws for an unrecognized row rather than silently no-op', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-weird`, displayName: 'Weird' });
    const unrec: UnrecognizedRow = {
      kind: 'unrecognized',
      enabled: false,
      dataPoint: 'weird',
      stationMac: MAC,
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
    };
    expect(() => instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      unrec,
    )).toThrow(/unrecognized row 'weird'/);
  });

  it('throws (via the runtime twin) when a row reaches dispatch with a drifted measurement', () => {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory({ uniqueId: `${MAC}-tempf`, displayName: 'Outdoor' });
    const drifted = {
      ...(rowFor('temperature') as NumericSensorRow),
      measurement: 'humidity',
    } as unknown as EffectiveSensorRow;
    expect(() => instantiateWrapper(
      platform as unknown as AmbientWeatherSensorsPlatform,
      accessory as never,
      drifted,
    )).toThrow(/expects \(temperature, temperature\)/);
  });
});

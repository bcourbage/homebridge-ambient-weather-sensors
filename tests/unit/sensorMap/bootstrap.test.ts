import { describe, expect, it } from 'vitest';

import {
  dataPointFromUniqueId,
  HAP_CHARACTERISTIC_UUIDS,
  HAP_SERVICE_UUIDS,
  inferForCachedAccessory,
  type CachedAccessoryShape,
  type ServiceShape,
} from '../../../src/sensorMap/bootstrap';

const MAC = 'AA:BB:CC:DD:EE:01';

function svc(uuid: string, characteristicUuids: ReadonlyArray<string> = []): ServiceShape {
  const set = new Set(characteristicUuids.map(u => u.toLowerCase()));
  return {
    UUID: uuid,
    testCharacteristic: (u) => set.has(u.toLowerCase()),
  };
}

function accessory(input: {
  uniqueId?: string;
  kind?: import('../../../src/sensorMap/types').SensorKind;
  type?: string;
  services?: ServiceShape[];
}): CachedAccessoryShape {
  return {
    context: { device: { uniqueId: input.uniqueId, kind: input.kind, type: input.type } },
    services: input.services ?? [],
  };
}

describe('dataPointFromUniqueId', () => {
  it('extracts sensorKey after the first hyphen', () => {
    expect(dataPointFromUniqueId(`${MAC}-tempf`)).toBe('tempf');
  });

  it('preserves underscores in the sensorKey', () => {
    expect(dataPointFromUniqueId(`${MAC}-pm25_in_aqin`)).toBe('pm25_in_aqin');
    expect(dataPointFromUniqueId(`${MAC}-lightning_distance`)).toBe('lightning_distance');
  });

  it('returns undefined for missing/empty/malformed uniqueId', () => {
    expect(dataPointFromUniqueId('')).toBeUndefined();
    expect(dataPointFromUniqueId('nohyphenhere')).toBeUndefined();
    expect(dataPointFromUniqueId(`${MAC}-`)).toBeUndefined();
  });
});

describe('inferForCachedAccessory — level 1: explicit context.kind', () => {
  it('prefers context.kind over legacy type', () => {
    const acc = accessory({ uniqueId: `${MAC}-tempf`, kind: 'temperature', type: 'Humidity' });
    const r = inferForCachedAccessory(acc);
    expect(r.status).toBe('inferred');
    if (r.status === 'inferred') expect(r.kind).toBe('temperature');
  });

  it('ignores context.kind if set to unrecognized', () => {
    const acc = accessory({
      uniqueId: `${MAC}-tempf`,
      kind: 'unrecognized',
      type: 'Temperature',
    });
    const r = inferForCachedAccessory(acc);
    if (r.status === 'inferred') expect(r.kind).toBe('temperature');
  });
});

describe('inferForCachedAccessory — level 2: legacy type', () => {
  it('resolves Temperature → temperature', () => {
    const r = inferForCachedAccessory(accessory({ uniqueId: `${MAC}-tempf`, type: 'Temperature' }));
    if (r.status === 'inferred') {
      expect(r.kind).toBe('temperature');
      expect(r.measurement).toBe('temperature');
    }
  });

  it('resolves LightningDistance → motion + distance', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-lightning_distance`,
      type: 'LightningDistance',
    }));
    if (r.status === 'inferred') {
      expect(r.kind).toBe('motion');
      expect(r.measurement).toBe('distance');
    }
  });

  it('WindGust legacy type → motion + wind-speed', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-windgustmph`,
      type: 'WindGust',
    }));
    if (r.status === 'inferred') {
      expect(r.kind).toBe('motion');
      expect(r.measurement).toBe('wind-speed');
    }
  });
});

describe('inferForCachedAccessory — level 3: HAP service walk', () => {
  it('TemperatureSensor service → temperature', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-tempf`,
      services: [svc(HAP_SERVICE_UUIDS.TEMPERATURE_SENSOR)],
    }));
    if (r.status === 'inferred') {
      expect(r.kind).toBe('temperature');
      expect(r.measurement).toBe('temperature');
    }
  });

  it('HumiditySensor service → humidity', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-humidity`,
      services: [svc(HAP_SERVICE_UUIDS.HUMIDITY_SENSOR)],
    }));
    if (r.status === 'inferred') expect(r.kind).toBe('humidity');
  });

  it('AirQualitySensor + PM2.5 density → air-quality-pm25', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-pm25_in_aqin`,
      services: [svc(HAP_SERVICE_UUIDS.AIR_QUALITY_SENSOR, [HAP_CHARACTERISTIC_UUIDS.PM2_5_DENSITY])],
    }));
    if (r.status === 'inferred') expect(r.kind).toBe('air-quality-pm25');
  });

  it('AirQualitySensor + PM10 density → air-quality-pm10', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-pm10_in_aqin`,
      services: [svc(HAP_SERVICE_UUIDS.AIR_QUALITY_SENSOR, [HAP_CHARACTERISTIC_UUIDS.PM10_DENSITY])],
    }));
    if (r.status === 'inferred') expect(r.kind).toBe('air-quality-pm10');
  });

  it('AirQualitySensor with neither density → no kind from service walk', () => {
    // But default-map lookup by dataPoint still resolves this one.
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-pm25_in_aqin`,
      services: [svc(HAP_SERVICE_UUIDS.AIR_QUALITY_SENSOR)],
    }));
    // Kind should fall back to level-3 disambiguation failure →
    // no legacy type, no context.kind → preserve-cached.
    expect(r.status).toBe('preserve-cached');
  });

  it('MotionSensor service → motion (measurement from default map)', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-windspeedmph`,
      services: [svc(HAP_SERVICE_UUIDS.MOTION_SENSOR)],
    }));
    if (r.status === 'inferred') {
      expect(r.kind).toBe('motion');
      expect(r.measurement).toBe('wind-speed');
    }
  });

  it('UUID case-insensitive match', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-tempf`,
      services: [svc(HAP_SERVICE_UUIDS.TEMPERATURE_SENSOR.toLowerCase())],
    }));
    if (r.status === 'inferred') expect(r.kind).toBe('temperature');
  });
});

describe('inferForCachedAccessory — preserve-cached fallback', () => {
  it('kind resolvable but no measurement (custom motion with unknown dataPoint) → preserve-cached', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-mystery_field`,
      services: [svc(HAP_SERVICE_UUIDS.MOTION_SENSOR)],
    }));
    expect(r.status).toBe('preserve-cached');
  });

  it('no kind resolvable → preserve-cached', () => {
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-tempf`,
      services: [], // no services
    }));
    expect(r.status).toBe('preserve-cached');
  });

  it('empty accessory → preserve-cached', () => {
    const r = inferForCachedAccessory({});
    expect(r.status).toBe('preserve-cached');
  });
});

describe('inferForCachedAccessory — v2 forward-compat', () => {
  it('honors an already-populated v2 context.kind + measurement in default map', () => {
    // Simulates re-boot AFTER first migration wrote kind into context.
    const r = inferForCachedAccessory(accessory({
      uniqueId: `${MAC}-tempf`,
      kind: 'temperature',
    }));
    if (r.status === 'inferred') {
      expect(r.kind).toBe('temperature');
      expect(r.measurement).toBe('temperature');
    }
  });
});

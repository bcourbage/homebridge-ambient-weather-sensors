import { describe, expect, it } from 'vitest';

import { AmbientWeatherSensorsPlatform } from '../../src/platform';
import { MockAPI, MockLogger } from '../helpers/mockHomebridge';

/**
 * Build a platform instance with a mocked HB API + logger + config.
 * parseDevices() only reads config and log; it doesn't touch api's
 * event methods. So no `didFinishLaunching` fires — safe for unit
 * testing.
 */
function makePlatform(config: Record<string, unknown> = {}): AmbientWeatherSensorsPlatform {
  return new AmbientWeatherSensorsPlatform(
    new MockLogger() as never,
    { platform: 'AmbientWeatherSensors', ...config } as never,
    new MockAPI() as never,
  );
}

/**
 * A minimal AWN device payload fixture. Real payloads have hundreds
 * of fields; this covers the shape parseDevices depends on: array of
 * device objects, each with macAddress + info.name + lastData.
 */
function makeStation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    macAddress: overrides.macAddress ?? 'AA:BB:CC:DD:EE:FF',
    info: overrides.info ?? { name: 'Test Station' },
    lastData: overrides.lastData ?? {
      tempf: 68,
      humidity: 45,
      tempinf: 72,
      humidityin: 50,
    },
  };
}

describe('parseDevices', () => {
  describe('sensor-category toggle gating', () => {
    it('returns empty array when no toggles are enabled', () => {
      const platform = makePlatform({});
      const devices = platform.parseDevices([makeStation()]);
      expect(devices).toEqual([]);
    });

    it('exposes temperature sensors when temperatureSensors=true', () => {
      const platform = makePlatform({ temperatureSensors: true });
      const devices = platform.parseDevices([makeStation()]);
      const types = devices.map((d) => d.type);
      expect(types).toContain('Temperature');
      // Should NOT include Humidity since that toggle is off.
      expect(types).not.toContain('Humidity');
    });

    it('exposes humidity sensors when humiditySensors=true', () => {
      const platform = makePlatform({ humiditySensors: true });
      const devices = platform.parseDevices([makeStation()]);
      const types = devices.map((d) => d.type);
      expect(types).toContain('Humidity');
      expect(types).not.toContain('Temperature');
    });

    it('produces one device per sensor field when both toggles are on', () => {
      const platform = makePlatform({ temperatureSensors: true, humiditySensors: true });
      const devices = platform.parseDevices([makeStation()]);
      // 2 temp + 2 humidity = 4 devices from the default fixture
      expect(devices).toHaveLength(4);
    });
  });

  describe('single-station display naming', () => {
    it('uses bare labels when only one station is present', () => {
      const platform = makePlatform({ temperatureSensors: true });
      const devices = platform.parseDevices([makeStation()]);
      const outdoor = devices.find((d) => d.uniqueId.endsWith('-tempf'));
      const indoor = devices.find((d) => d.uniqueId.endsWith('-tempinf'));
      expect(outdoor!.displayName).toBe('Outdoor Temperature');
      expect(indoor!.displayName).toBe('Indoor Temperature');
    });
  });

  describe('multi-station display naming', () => {
    it('prepends station name when >1 stations are present', () => {
      const platform = makePlatform({ temperatureSensors: true });
      const devices = platform.parseDevices([
        makeStation({ macAddress: '11:11:11:11:11:11', info: { name: 'Front Yard' }, lastData: { tempf: 70 } }),
        makeStation({ macAddress: '22:22:22:22:22:22', info: { name: 'Back Yard' }, lastData: { tempf: 75 } }),
      ]);
      const displayNames = devices.map((d) => d.displayName);
      expect(displayNames).toContain('Front Yard Outdoor Temperature');
      expect(displayNames).toContain('Back Yard Outdoor Temperature');
    });

    it('falls back to MAC (without colons) when info.name is missing', () => {
      const platform = makePlatform({ temperatureSensors: true });
      const devices = platform.parseDevices([
        makeStation({ macAddress: 'AA:BB:CC:11:22:33', info: {}, lastData: { tempf: 70 } }),
        makeStation({ macAddress: 'AA:BB:CC:44:55:66', info: {}, lastData: { tempf: 75 } }),
      ]);
      // Both stations lack info.name → MAC-without-colons fallback prefix.
      const names = devices.map((d) => d.displayName);
      expect(names.some((n) => n.startsWith('AABBCC112233 Outdoor Temperature'))).toBe(true);
      expect(names.some((n) => n.startsWith('AABBCC445566 Outdoor Temperature'))).toBe(true);
    });
  });

  describe('excludeSensors filtering', () => {
    it('drops accessories whose friendly name matches an exclude entry', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        humiditySensors: true,
        excludeSensors: ['Indoor Temperature'],
      });
      const devices = platform.parseDevices([makeStation()]);
      expect(devices.find((d) => d.displayName === 'Indoor Temperature')).toBeUndefined();
      expect(devices.find((d) => d.displayName === 'Outdoor Temperature')).toBeDefined();
    });

    it('drops accessories by AWN raw sensor key', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        excludeSensors: ['tempinf'],
      });
      const devices = platform.parseDevices([makeStation()]);
      expect(devices.find((d) => d.uniqueId.endsWith('-tempinf'))).toBeUndefined();
    });

    it('is case-insensitive and whitespace-tolerant', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        excludeSensors: ['  indoor temperature  '],
      });
      const devices = platform.parseDevices([makeStation()]);
      expect(devices.find((d) => d.displayName === 'Indoor Temperature')).toBeUndefined();
    });
  });

  describe('includeOnly filtering (allowlist)', () => {
    it('exposes only sensors matching an allowlist entry', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        humiditySensors: true,
        includeOnly: ['Outdoor Temperature'],
      });
      const devices = platform.parseDevices([makeStation()]);
      expect(devices).toHaveLength(1);
      expect(devices[0].displayName).toBe('Outdoor Temperature');
    });
  });

  describe('stationFilter (station-level allowlist)', () => {
    it('drops entire stations that do not match', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        stationFilter: ['Front Yard'],
      });
      const devices = platform.parseDevices([
        makeStation({ macAddress: '11:11:11:11:11:11', info: { name: 'Front Yard' }, lastData: { tempf: 70 } }),
        makeStation({ macAddress: '22:22:22:22:22:22', info: { name: 'Back Yard' }, lastData: { tempf: 75 } }),
      ]);
      // Only Front Yard's tempf survives. And because filter reduced to
      // one station, tile names should be bare (no station prefix).
      expect(devices).toHaveLength(1);
      expect(devices[0].displayName).toBe('Outdoor Temperature');
    });

    it('matches by MAC address as well as by station name', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        stationFilter: ['11:11:11:11:11:11'],
      });
      const devices = platform.parseDevices([
        makeStation({ macAddress: '11:11:11:11:11:11', info: { name: 'Front Yard' }, lastData: { tempf: 70 } }),
        makeStation({ macAddress: '22:22:22:22:22:22', info: { name: 'Back Yard' }, lastData: { tempf: 75 } }),
      ]);
      expect(devices).toHaveLength(1);
    });

    it('empty filter is a pass-through (no filtering)', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        stationFilter: [],
      });
      const devices = platform.parseDevices([makeStation()]);
      expect(devices.length).toBeGreaterThan(0);
    });

    it('zero-match filter drops every accessory (documented behavior — clean slate use)', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        stationFilter: ['Nonexistent Station'],
      });
      const devices = platform.parseDevices([makeStation()]);
      expect(devices).toEqual([]);
    });

    it('recomputes isMultiStation AFTER filtering — one station post-filter = bare names', () => {
      // TWO stations in the payload, but stationFilter reduces to ONE.
      // Tile names should be bare (no station prefix) — this is what
      // makes multi-Home setups work cleanly.
      const platform = makePlatform({
        temperatureSensors: true,
        stationFilter: ['Cabin'],
      });
      const devices = platform.parseDevices([
        makeStation({ macAddress: '11:11:11:11:11:11', info: { name: 'Main House' }, lastData: { tempf: 70 } }),
        makeStation({ macAddress: '22:22:22:22:22:22', info: { name: 'Cabin' }, lastData: { tempf: 65 } }),
      ]);
      expect(devices).toHaveLength(1);
      expect(devices[0].displayName).toBe('Outdoor Temperature');   // bare, not "Cabin Outdoor Temperature"
    });
  });

  describe('battery information handling', () => {
    it('surfaces batteryLow on the canonical sensor when AWN reports it', () => {
      const platform = makePlatform({ temperatureSensors: true });
      const devices = platform.parseDevices([makeStation({
        lastData: { tempf: 68, battout: 0 },   // AWN 0 = LOW
      })]);
      const outdoor = devices.find((d) => d.uniqueId.endsWith('-tempf'));
      expect(outdoor!.batteryLow).toBe(true);
    });

    it('leaves batteryLow undefined on non-canonical sensors sharing the same probe', () => {
      const platform = makePlatform({ temperatureSensors: true, humiditySensors: true });
      const devices = platform.parseDevices([makeStation({
        lastData: { tempf: 68, humidity: 42, battout: 0 },   // battout serves both, but only tempf is canonical
      })]);
      const outdoor = devices.find((d) => d.uniqueId.endsWith('-tempf'));
      const humidity = devices.find((d) => d.uniqueId.endsWith('-humidity'));
      expect(outdoor!.batteryLow).toBe(true);
      expect(humidity!.batteryLow).toBeUndefined();
    });

    it('honors excludeSensors -batt suffix for battery-only suppression', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        excludeSensors: ['Outdoor Temperature-batt'],
      });
      const devices = platform.parseDevices([makeStation({
        lastData: { tempf: 68, battout: 0 },
      })]);
      const outdoor = devices.find((d) => d.uniqueId.endsWith('-tempf'));
      // Accessory still exposed, just no battery sub-service.
      expect(outdoor).toBeDefined();
      expect(outdoor!.batteryLow).toBeUndefined();
    });

    it('honors excludeSensors with raw battery field name', () => {
      const platform = makePlatform({
        temperatureSensors: true,
        excludeSensors: ['battout'],
      });
      const devices = platform.parseDevices([makeStation({
        lastData: { tempf: 68, battout: 0 },
      })]);
      const outdoor = devices.find((d) => d.uniqueId.endsWith('-tempf'));
      expect(outdoor).toBeDefined();
      expect(outdoor!.batteryLow).toBeUndefined();
    });
  });

  describe('lastRain ISO-string handling', () => {
    it('converts AWN lastRain ISO string to Unix ms', () => {
      const platform = makePlatform({ extendedSensors: true, rainSensors: true });
      const devices = platform.parseDevices([makeStation({
        lastData: { lastRain: '2026-06-30T12:00:00.000Z' },
      })]);
      const lr = devices.find((d) => d.uniqueId.endsWith('-lastRain'));
      expect(lr).toBeDefined();
      expect(lr!.value).toBe(new Date('2026-06-30T12:00:00.000Z').getTime());
    });

    it('falls back to 0 for unparseable lastRain values', () => {
      const platform = makePlatform({ extendedSensors: true, rainSensors: true });
      const devices = platform.parseDevices([makeStation({
        lastData: { lastRain: 'not-a-date' },
      })]);
      const lr = devices.find((d) => d.uniqueId.endsWith('-lastRain'));
      expect(lr!.value).toBe(0);
    });
  });

  describe('non-array input handling', () => {
    it('returns empty for non-array input', () => {
      const platform = makePlatform({ temperatureSensors: true });
      expect(platform.parseDevices(null as never)).toEqual([]);
      expect(platform.parseDevices({} as never)).toEqual([]);
      expect(platform.parseDevices('not an array' as never)).toEqual([]);
    });

    it('returns empty for empty array', () => {
      const platform = makePlatform({ temperatureSensors: true });
      expect(platform.parseDevices([])).toEqual([]);
    });
  });
});

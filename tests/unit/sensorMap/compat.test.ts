import { describe, expect, it } from 'vitest';

import { buildEffectiveSensorMap } from '../../../src/sensorMap/buildEffectiveMap';
import { compatToOverrides, type LegacyConfig } from '../../../src/sensorMap/compat';
import { DEFAULT_SENSOR_MAP } from '../../../src/sensorMap/defaultMap';
import type {
  DiscoveryStore,
  StationInventory,
  UiStateStore,
} from '../../../src/sensorMap/types';

const MAC = 'AA:BB:CC:DD:EE:01';
const STATIONS: StationInventory = [{ macAddress: MAC, name: 'Home' }];

function baseInput(overrides = compatToOverrides({})) {
  return {
    userOverrides: overrides,
    discovery: { schemaVersion: 1, entries: [] } as DiscoveryStore,
    uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] } as UiStateStore,
    stations: STATIONS,
    configMode: 'legacy' as const,
  };
}

function rowFor(dp: string, overrides = compatToOverrides({})) {
  const r = buildEffectiveSensorMap(baseInput(overrides));
  return r.rows.find(row => row.dataPoint === dp && row.stationMac === MAC);
}

describe('compatToOverrides — empty legacy config', () => {
  it('disables every default row when no category toggle is set', () => {
    const overrides = compatToOverrides({});
    // Every default row gets an entry with enabled: false because no
    // category toggle is on.
    expect(overrides.length).toBeGreaterThanOrEqual(DEFAULT_SENSOR_MAP.length);
    const tempf = rowFor('tempf', overrides);
    if (tempf && tempf.kind !== 'unrecognized') {
      expect(tempf.enabled).toBe(false);
    }
  });

  it('all overrides are global (no stationMac)', () => {
    const overrides = compatToOverrides({});
    for (const o of overrides) {
      expect(o.stationMac).toBeUndefined();
    }
  });
});

describe('compatToOverrides — category toggles', () => {
  it('temperatureSensors: true enables temperature rows', () => {
    const legacy: LegacyConfig = { temperatureSensors: true };
    const row = rowFor('tempf', compatToOverrides(legacy));
    if (row && row.kind !== 'unrecognized') {
      expect(row.enabled).toBe(true);
    }
  });

  it('humiditySensors: true enables humidity rows independently of temperature', () => {
    const legacy: LegacyConfig = { humiditySensors: true };
    const rows = compatToOverrides(legacy);
    const humidity = rowFor('humidity', rows);
    const tempf = rowFor('tempf', rows);
    if (humidity && humidity.kind !== 'unrecognized') expect(humidity.enabled).toBe(true);
    if (tempf && tempf.kind !== 'unrecognized') expect(tempf.enabled).toBe(false);
  });

  it('airQualitySensors: true enables both pm25 and pm10 rows', () => {
    const legacy: LegacyConfig = { airQualitySensors: true };
    const rows = compatToOverrides(legacy);
    const pm25 = rowFor('pm25_in_aqin', rows);
    const pm10 = rowFor('pm10_in_aqin', rows);
    if (pm25?.kind !== 'unrecognized') expect(pm25?.enabled).toBe(true);
    if (pm10?.kind !== 'unrecognized') expect(pm10?.enabled).toBe(true);
  });
});

describe('compatToOverrides — extended sensors master + sub-toggles', () => {
  it('extendedSensors: false disables all motion rows even with sub-toggles on', () => {
    const legacy: LegacyConfig = {
      extendedSensors: false,
      windSensors: true,
      rainSensors: true,
    };
    const rows = compatToOverrides(legacy);
    const wind = rowFor('windspeedmph', rows);
    if (wind?.kind !== 'unrecognized') expect(wind?.enabled).toBe(false);
  });

  it('extendedSensors + windSensors: true enables wind but not rain', () => {
    const legacy: LegacyConfig = { extendedSensors: true, windSensors: true };
    const rows = compatToOverrides(legacy);
    const wind = rowFor('windspeedmph', rows);
    const rain = rowFor('hourlyrainin', rows);
    if (wind?.kind !== 'unrecognized') expect(wind?.enabled).toBe(true);
    if (rain?.kind !== 'unrecognized') expect(rain?.enabled).toBe(false);
  });

  it('rainSensors covers lastRain (timestamp)', () => {
    const legacy: LegacyConfig = { extendedSensors: true, rainSensors: true };
    const rows = compatToOverrides(legacy);
    const lastRain = rowFor('lastRain', rows);
    if (lastRain?.kind !== 'unrecognized') expect(lastRain?.enabled).toBe(true);
  });

  it('lightningSensors covers lightning_time (timestamp)', () => {
    const legacy: LegacyConfig = { extendedSensors: true, lightningSensors: true };
    const rows = compatToOverrides(legacy);
    const lightningTime = rowFor('lightning_time', rows);
    if (lightningTime?.kind !== 'unrecognized') expect(lightningTime?.enabled).toBe(true);
  });
});

describe('compatToOverrides — per-threshold enable checkboxes', () => {
  it('windSpeedEnabled: false disables windspeedmph even with windSensors on', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      thresholds: { windSpeedEnabled: false },
    };
    const rows = compatToOverrides(legacy);
    const wind = rowFor('windspeedmph', rows);
    if (wind?.kind !== 'unrecognized') expect(wind?.enabled).toBe(false);
  });

  it('windGustEnabled: false disables BOTH windgustmph and maxdailygust', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      thresholds: { windGustEnabled: false },
    };
    const rows = compatToOverrides(legacy);
    const gust = rowFor('windgustmph', rows);
    const maxGust = rowFor('maxdailygust', rows);
    if (gust?.kind !== 'unrecognized') expect(gust?.enabled).toBe(false);
    if (maxGust?.kind !== 'unrecognized') expect(maxGust?.enabled).toBe(false);
  });

  it('pressureEnabled: false disables both baromrelin and baromabsin', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      pressureSensors: true,
      thresholds: { pressureEnabled: false },
    };
    const rows = compatToOverrides(legacy);
    const rel = rowFor('baromrelin', rows);
    const abs = rowFor('baromabsin', rows);
    if (rel?.kind !== 'unrecognized') expect(rel?.enabled).toBe(false);
    if (abs?.kind !== 'unrecognized') expect(abs?.enabled).toBe(false);
  });

  it('missing threshold-enable key defaults to true (v1.6.0 default-true semantics)', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      // thresholds omitted entirely
    };
    const rows = compatToOverrides(legacy);
    const wind = rowFor('windspeedmph', rows);
    if (wind?.kind !== 'unrecognized') expect(wind?.enabled).toBe(true);
  });
});

describe('compatToOverrides — threshold values', () => {
  it('windSpeedMph gets set on windspeedmph row', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      thresholds: { windSpeedMph: 25 },
    };
    const wind = rowFor('windspeedmph', compatToOverrides(legacy));
    if (wind?.kind !== 'unrecognized') expect(wind?.threshold).toBe(25);
  });

  it('windGustMph applies to both windgustmph AND maxdailygust', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      thresholds: { windGustMph: 40 },
    };
    const overrides = compatToOverrides(legacy);
    const gust = rowFor('windgustmph', overrides);
    const maxGust = rowFor('maxdailygust', overrides);
    if (gust?.kind !== 'unrecognized') expect(gust?.threshold).toBe(40);
    if (maxGust?.kind !== 'unrecognized') expect(maxGust?.threshold).toBe(40);
  });

  it('pressureInHg applies to both pressure rows', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      pressureSensors: true,
      thresholds: { pressureInHg: 29.5 },
    };
    const rel = rowFor('baromrelin', compatToOverrides(legacy));
    if (rel?.kind !== 'unrecognized') expect(rel?.threshold).toBe(29.5);
  });
});

describe('compatToOverrides — units', () => {
  it('units.windSpeed = kph sets displayUnit on wind rows', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      units: { windSpeed: 'kph' },
    };
    const wind = rowFor('windspeedmph', compatToOverrides(legacy));
    if (wind?.kind !== 'unrecognized' && wind?.measurement !== 'boolean' && wind?.measurement !== 'timestamp') {
      expect(wind?.displayUnit).toBe('kph');
    }
  });

  it('units.rain = mm maps rain-rate rows to mm_per_hr and accumulation rows to mm', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      rainSensors: true,
      units: { rain: 'mm' },
    };
    const overrides = compatToOverrides(legacy);
    const rate = rowFor('hourlyrainin', overrides);
    const daily = rowFor('dailyrainin', overrides);
    if (rate?.kind !== 'unrecognized' && rate?.measurement === 'rain-rate') {
      expect(rate?.displayUnit).toBe('mm_per_hr');
    }
    if (daily?.kind !== 'unrecognized' && daily?.measurement === 'rain-accumulation') {
      expect(daily?.displayUnit).toBe('mm');
    }
  });

  it('units.pressure = hPa sets displayUnit on pressure rows', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      pressureSensors: true,
      units: { pressure: 'hPa' },
    };
    const rel = rowFor('baromrelin', compatToOverrides(legacy));
    if (rel?.kind !== 'unrecognized' && rel?.measurement === 'pressure') {
      expect(rel?.displayUnit).toBe('hPa');
    }
  });

  it('units.distance = km sets displayUnit on lightning_distance', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      lightningSensors: true,
      units: { distance: 'km' },
    };
    const dist = rowFor('lightning_distance', compatToOverrides(legacy));
    if (dist?.kind !== 'unrecognized' && dist?.measurement === 'distance') {
      expect(dist?.displayUnit).toBe('km');
    }
  });
});

describe('compatToOverrides — embed mode', () => {
  it('extendedDisplayMode: embed sets embedName: true on motion rows', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      windSensors: true,
      extendedDisplayMode: 'embed',
    };
    const wind = rowFor('windspeedmph', compatToOverrides(legacy));
    if (wind?.kind !== 'unrecognized') expect(wind?.embedName).toBe(true);
  });

  it('extendedDisplayMode: embed does NOT affect value-tile rows', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      extendedDisplayMode: 'embed',
    };
    const temp = rowFor('tempf', compatToOverrides(legacy));
    if (temp?.kind !== 'unrecognized') expect(temp?.embedName).toBe(false);
  });
});

describe('compatToOverrides — excludeSensors / includeOnly', () => {
  it('excludeSensors matches by sensorKey', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['tempinf'],
    };
    const overrides = compatToOverrides(legacy);
    const outside = rowFor('tempf', overrides);
    const inside = rowFor('tempinf', overrides);
    if (outside?.kind !== 'unrecognized') expect(outside?.enabled).toBe(true);
    if (inside?.kind !== 'unrecognized') expect(inside?.enabled).toBe(false);
  });

  it('excludeSensors matches by friendly name (case-insensitive)', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['indoor temperature'],
    };
    const inside = rowFor('tempinf', compatToOverrides(legacy));
    if (inside?.kind !== 'unrecognized') expect(inside?.enabled).toBe(false);
  });

  it('includeOnly with a non-matching row disables it', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      includeOnly: ['tempf'],
    };
    const outside = rowFor('tempf', compatToOverrides(legacy));
    const inside = rowFor('tempinf', compatToOverrides(legacy));
    if (outside?.kind !== 'unrecognized') expect(outside?.enabled).toBe(true);
    if (inside?.kind !== 'unrecognized') expect(inside?.enabled).toBe(false);
  });

  it('empty includeOnly list has no effect', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      includeOnly: [],
    };
    const outside = rowFor('tempf', compatToOverrides(legacy));
    if (outside?.kind !== 'unrecognized') expect(outside?.enabled).toBe(true);
  });
});

describe('compatToOverrides — -batt suppression', () => {
  it('raw battery field name in excludeSensors suppresses the sub-service', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['battout'],
    };
    const tempf = rowFor('tempf', compatToOverrides(legacy));
    if (tempf?.kind !== 'unrecognized') {
      expect(tempf?.batteryField).toBeNull();
      expect(tempf?.hasBatterySubService).toBe(false);
    }
  });

  it('"<friendlyName>-batt" suffix suppresses the sub-service', () => {
    const legacy: LegacyConfig = {
      extendedSensors: true,
      lightningSensors: true,
      excludeSensors: ['Lightning Strikes Today-batt'],
    };
    const lightning = rowFor('lightning_day', compatToOverrides(legacy));
    if (lightning?.kind !== 'unrecognized') {
      expect(lightning?.batteryField).toBeNull();
    }
  });

  it('"<sensorKey>-batt" suffix suppresses the sub-service', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['tempf-batt'],
    };
    const tempf = rowFor('tempf', compatToOverrides(legacy));
    if (tempf?.kind !== 'unrecognized') {
      expect(tempf?.batteryField).toBeNull();
    }
  });
});

describe('compatToOverrides — determinism', () => {
  it('running twice with the same legacy config produces byte-equal output', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      humiditySensors: true,
      extendedSensors: true,
      windSensors: true,
      thresholds: { windSpeedMph: 25 },
      units: { windSpeed: 'kph' },
      excludeSensors: ['tempinf'],
    };
    const a = compatToOverrides(legacy);
    const b = compatToOverrides(legacy);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---- Review finding #2: v1 include/exclude matcher parity ----
//
// v1's platform.ts:661 builds SEVEN candidate forms per accessory
// (uniqueId, current displayName, prefixed form, sensorKey, friendly
// name, station MAC, station name); an exclude/include entry can
// target any of them. Pre-fix, compat only compared against sensorKey
// + friendly name — the four station-scoped forms were silently
// ignored, breaking migration parity for anyone using them.
describe('compatToOverrides — station-scoped exclude/include (finding #2)', () => {
  const MAC_1 = 'AA:BB:CC:DD:EE:01';
  const MAC_2 = 'AA:BB:CC:DD:EE:02';
  const TWO_STATIONS: StationInventory = [
    { macAddress: MAC_1, name: 'Home' },
    { macAddress: MAC_2, name: 'Cabin' },
  ];

  function findOverride(overrides: ReturnType<typeof compatToOverrides>, dp: string, stationMac?: string) {
    return overrides.find(o => o.dataPoint === dp && o.stationMac === stationMac);
  }

  it('uniqueId (`MAC-sensorKey`) drops that accessory on that station only', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: [`${MAC_1}-tempf`],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    // Station 1 has a station-scoped disable override.
    const s1 = findOverride(overrides, 'tempf', MAC_1);
    expect(s1?.enabled).toBe(false);
    // Station 2 has NO station-scoped override — tempf is still enabled there.
    const s2 = findOverride(overrides, 'tempf', MAC_2);
    expect(s2).toBeUndefined();
  });

  it('station MAC alone excludes every row on that station', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      humiditySensors: true,
      excludeSensors: [MAC_1],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    // Every default-map row on MAC_1 gets a station-scoped disable.
    // We sample the two we enabled: tempf + humidity.
    expect(findOverride(overrides, 'tempf', MAC_1)?.enabled).toBe(false);
    expect(findOverride(overrides, 'humidity', MAC_1)?.enabled).toBe(false);
    // Nothing on MAC_2.
    expect(findOverride(overrides, 'tempf', MAC_2)).toBeUndefined();
    expect(findOverride(overrides, 'humidity', MAC_2)).toBeUndefined();
  });

  it('station name (as user typed it) drops every row on that station', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['Cabin'],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    expect(findOverride(overrides, 'tempf', MAC_2)?.enabled).toBe(false);
    expect(findOverride(overrides, 'tempf', MAC_1)).toBeUndefined();
  });

  it('prefixed form ("<station> <friendly>") drops that row on that station only', () => {
    // v1 also matches on hapClean(stationName + " " + friendly).
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['Cabin Outdoor Temperature'],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    expect(findOverride(overrides, 'tempf', MAC_2)?.enabled).toBe(false);
    expect(findOverride(overrides, 'tempf', MAC_1)).toBeUndefined();
  });

  it('includeOnly with a uniqueId keeps only that one accessory', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      humiditySensors: true,
      includeOnly: [`${MAC_1}-tempf`],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    // tempf on MAC_1 kept (no station-scoped disable).
    expect(findOverride(overrides, 'tempf', MAC_1)).toBeUndefined();
    // humidity on MAC_1 dropped (not in includeOnly list).
    expect(findOverride(overrides, 'humidity', MAC_1)?.enabled).toBe(false);
    // tempf on MAC_2 dropped (not in includeOnly list — MAC differs).
    expect(findOverride(overrides, 'tempf', MAC_2)?.enabled).toBe(false);
    // humidity on MAC_2 dropped.
    expect(findOverride(overrides, 'humidity', MAC_2)?.enabled).toBe(false);
  });

  it('includeOnly with a station MAC keeps every row on that station', () => {
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      humiditySensors: true,
      includeOnly: [MAC_1],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    // Everything on MAC_1 kept.
    expect(findOverride(overrides, 'tempf', MAC_1)).toBeUndefined();
    expect(findOverride(overrides, 'humidity', MAC_1)).toBeUndefined();
    // Everything on MAC_2 dropped.
    expect(findOverride(overrides, 'tempf', MAC_2)?.enabled).toBe(false);
    expect(findOverride(overrides, 'humidity', MAC_2)?.enabled).toBe(false);
  });

  it('sensorKey-only entries disable the row on every station', () => {
    // A global-form entry (sensorKey or friendly name) matches every
    // station because the seven-candidate list per (row, station)
    // always includes those forms. Emission is per-station (verbose
    // but semantically equivalent to a single global disable) so
    // the station-scoped code path stays uniform. Tests below just
    // check the effective result — tempf is off on both stations.
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: ['tempf'],
    };
    const overrides = compatToOverrides(legacy, TWO_STATIONS);
    expect(findOverride(overrides, 'tempf', MAC_1)?.enabled).toBe(false);
    expect(findOverride(overrides, 'tempf', MAC_2)?.enabled).toBe(false);
  });

  it('empty station inventory falls back to global-only forms (no crash)', () => {
    // Boot-before-fetch path: no stations yet. Global forms still
    // work; station-scoped entries produce nothing (they can't
    // match without an inventory).
    const legacy: LegacyConfig = {
      temperatureSensors: true,
      excludeSensors: [`${MAC_1}-tempf`, 'tempf'],
    };
    const overrides = compatToOverrides(legacy, []);
    // Global-form entry still applies.
    expect(findOverride(overrides, 'tempf', undefined)?.enabled).toBe(false);
  });
});

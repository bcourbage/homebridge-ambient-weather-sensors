/**
 * The byte-real conversion, shared by the migration proofs: exactly
 * what the guarded save pipeline writes for a legacy config — compat
 * translation, canonical sensorMap, legacy mirror, configVersion 2 —
 * with the v2 flag on (the editor requires the flag before it may
 * convert). Also the documented rollback: the marker-key deletion the
 * README prescribes, which leaves the mirror's legacy fields as the
 * running configuration for a 1.7.x install.
 */
import { expect } from 'vitest';

import { buildEffectiveSensorMap } from '../../src/sensorMap/buildEffectiveMap';
import { canonicalizeSensorMap } from '../../src/sensorMap/canonicalizeSensorMap';
import { compatToOverrides, type LegacyConfig } from '../../src/sensorMap/compat';
import { composeV2ConfigSave } from '../../src/sensorMap/legacyMirror';
import { emptyDiscoveryStore } from '../../src/sensorMap/persistence/discoveryStore';
import { emptyUiStateStore } from '../../src/sensorMap/persistence/uiStateStore';
import type { StationInventory } from '../../src/sensorMap/types';

import type { RawStation } from './legacyConfigCorpus';

export function inventoryOf(stations: RawStation[]): StationInventory {
  return stations.map(s => ({ macAddress: s.macAddress, name: s.info?.name ?? s.macAddress }));
}

export function convertedConfigFor(config: LegacyConfig, stations: RawStation[]): Record<string, unknown> {
  const inventory = inventoryOf(stations);
  const overrides = compatToOverrides(config, inventory);
  const canonical = canonicalizeSensorMap({
    overrides,
    stations: inventory,
    discovery: emptyDiscoveryStore(),
    uiState: emptyUiStateStore(),
  });
  const effectiveMap = buildEffectiveSensorMap({
    userOverrides: canonical,
    discovery: emptyDiscoveryStore(),
    uiState: emptyUiStateStore(),
    stations: inventory,
    configMode: 'v2',
  });
  expect(effectiveMap.errors).toEqual([]);
  const { nextConfig } = composeV2ConfigSave(
    { platform: 'AmbientWeatherSensors', apiKey: 'k', applicationKey: 'k', _sensorMapV2: true, ...config },
    canonical,
    effectiveMap,
    'legacy',
  );
  return nextConfig as Record<string, unknown>;
}

/** The README's documented rollback: delete the v2 marker keys, keep the mirror's legacy fields. */
export function documentedRollback(converted: Record<string, unknown>): Record<string, unknown> {
  const { sensorMap: _s, configVersion: _c, _legacyMirror: _m, _sensorMapV2: _f, ...rest } = converted;
  return rest;
}

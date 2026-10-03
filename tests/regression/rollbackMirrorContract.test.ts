/**
 * Mirror verification proves synchronization, not preservation of every v2
 * behavior. Pin the real rollback limitation behind the user-facing warning;
 * do not weaken it to a resolver-only assertion or silently broaden 1.x.
 */
import { describe, expect, it } from 'vitest';
import hap from '@homebridge/hap-nodejs';

import { buildEffectiveSensorMap } from '../../dist/sensorMap/buildEffectiveMap.js';
import { composeV2ConfigSave, recognizeMirror } from '../../dist/sensorMap/legacyMirror.js';
import { emptyDiscoveryStore } from '../../dist/sensorMap/persistence/discoveryStore.js';
import { emptyUiStateStore } from '../../dist/sensorMap/persistence/uiStateStore.js';
import { WindSpeedAccessory } from '../../dist/extendedSensors/windAccessory.js';
import { WindSpeedAccessory as WindSpeed173 } from '../../node_modules/awn-v1-7-3/dist/extendedSensors/windAccessory.js';
import type { EffectiveSensorRow } from '../../src/sensorMap/types';
import { HapLifecyclePlatformAccessory } from '../helpers/hapLifecycle';

const MAC = 'AA:BB:CC:DD:EE:01';
type Wrapper = new (platform: never, accessory: never, row?: never) => { setValue(value: number): void };

function motionAt30(Ctor: Wrapper, config: object, row?: EffectiveSensorRow) {
  const accessory = new HapLifecyclePlatformAccessory('Wind Speed', hap.uuid.generate('rollback-limit-wind'));
  accessory.context.device = { uniqueId: `${MAC}-windspeedmph`, displayName: 'Wind Speed' };
  const platform = {
    api: { hap }, Service: hap.Service, Characteristic: hap.Characteristic, config,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  new Ctor(platform as never, accessory as never, row as never).setValue(30);
  const service = accessory.getService(hap.Service.MotionSensor) as InstanceType<typeof hap.Service.MotionSensor>;
  return service.getCharacteristic(hap.Characteristic.MotionDetected).value;
}

describe('verified mirror is a legacy-compatible projection, not a lossless rollback', () => {
  it.each([
    { triggerDirection: 'below' as const, triggerEnabled: true, label: 'below-threshold direction' },
    { triggerDirection: 'above' as const, triggerEnabled: false, label: 'disabled motion trigger' },
  ])('discloses the loss of $label even when the wind accessory remains', rowSettings => {
    const { label: _label, ...settings } = rowSettings;
    const sensorMap = [{ dataPoint: 'windspeedmph', enabled: true, threshold: 25, ...settings }];
    const effective = buildEffectiveSensorMap({
      userOverrides: sensorMap,
      discovery: { ...emptyDiscoveryStore(), entries: [{
        stationMac: MAC, dataPoint: 'windspeedmph',
        firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z',
      }] },
      uiState: emptyUiStateStore(), stations: [{ macAddress: MAC, name: 'Home' }],
      configMode: 'v2', catalogBaseline: 1, catalogAdopted: 1,
    });
    expect(effective.errors).toEqual([]);
    const row = effective.rows.find(r => r.dataPoint === 'windspeedmph')!;
    expect(row.enabled).toBe(true);
    expect(row.triggerEnabled).toBe(settings.triggerEnabled);
    expect(row.triggerDirection).toBe(settings.triggerDirection);
    const { nextConfig } = composeV2ConfigSave(
      { platform: 'AmbientWeatherSensors', configVersion: 2, sensorMap },
      sensorMap, effective, 'v2', { catalogBaseline: 1, catalogAdopted: 1 },
    );
    expect(recognizeMirror(nextConfig).state).toBe('recognized');
    expect(nextConfig.thresholds).toMatchObject({ windSpeedMph: 25 });
    const rollback = { ...nextConfig } as Record<string, unknown>;
    delete rollback.sensorMap;
    delete rollback.configVersion;
    delete rollback._legacyMirror;
    rollback._sensorMapV2 = false;

    expect(motionAt30(WindSpeedAccessory as unknown as Wrapper, nextConfig, row)).toBe(false);
    expect(motionAt30(WindSpeed173 as unknown as Wrapper, rollback)).toBe(true);
  });
});

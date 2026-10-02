import { describe, expect, it } from 'vitest';
import { cachedPairFromUniqueId, cachedPairsFromUniqueIds } from '../../../src/sensorMap/cachedInventory';

describe('factual cached field inventory', () => {
  it('normalizes only the MAC and preserves a field containing hyphens', () => {
    expect(cachedPairFromUniqueId('aa:bb:cc:dd:ee:01-barn-temp-extra')).toEqual({
      stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'barn-temp-extra',
    });
  });

  it.each([undefined, null, 17, {}, 'AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:01-',
    'AA:BB:CC:DD:EE:01/tempf', 'not-a-mac-tempf'])('ignores a malformed identity: %j', value => {
    expect(cachedPairFromUniqueId(value)).toBeUndefined();
  });

  it('deduplicates identical pairs without fabricating observation metadata', () => {
    const pairs = cachedPairsFromUniqueIds([
      'aa:bb:cc:dd:ee:01-tempf', 'AA:BB:CC:DD:EE:01-tempf',
      'AA:BB:CC:DD:EE:02-tempf', 'not-a-pair', null,
    ]);
    expect(pairs).toEqual([
      { stationMac: 'AA:BB:CC:DD:EE:01', dataPoint: 'tempf' },
      { stationMac: 'AA:BB:CC:DD:EE:02', dataPoint: 'tempf' },
    ]);
    expect(cachedPairsFromUniqueIds(undefined)).toEqual([]);
    expect(cachedPairsFromUniqueIds({})).toEqual([]);
  });
});

/**
 * The post-flip v2 construction gate (GA #65): DEFAULT ON, explicit
 * opt-outs honored, env taking precedence over config.
 */
import { describe, expect, it } from 'vitest';

import { v2ConstructionEnabled } from '../../../src/sensorMap/v2Flag';

describe('v2ConstructionEnabled (default ON since beta.17)', () => {
  it('is ON for a bare config and empty env', () => {
    expect(v2ConstructionEnabled({ env: {}, config: {} })).toBe(true);
    expect(v2ConstructionEnabled({ env: {}, config: undefined })).toBe(true);
  });

  it('config opt-out forms are honored (false, "false", 0)', () => {
    for (const v of [false, 'false', 0]) {
      expect(v2ConstructionEnabled({ env: {}, config: { _sensorMapV2: v } }), String(v)).toBe(false);
    }
  });

  it('the pre-flip opt-IN forms stay ON (true, "true", 1) and junk values default ON', () => {
    for (const v of [true, 'true', 1, 'yes', null, 'junk']) {
      expect(v2ConstructionEnabled({ env: {}, config: { _sensorMapV2: v } }), String(v)).toBe(true);
    }
  });

  it('env opt-out forms force OFF over a silent config', () => {
    for (const e of ['0', 'false']) {
      expect(v2ConstructionEnabled({ env: { SENSOR_MAP_V2: e }, config: {} }), e).toBe(false);
    }
  });

  it('env opt-in wins over a config opt-out; env opt-out wins over a config opt-in', () => {
    expect(v2ConstructionEnabled({ env: { SENSOR_MAP_V2: '1' }, config: { _sensorMapV2: false } })).toBe(true);
    expect(v2ConstructionEnabled({ env: { SENSOR_MAP_V2: '0' }, config: { _sensorMapV2: true } })).toBe(false);
  });
});

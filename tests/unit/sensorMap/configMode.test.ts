import { describe, expect, it } from 'vitest';

import { CURRENT_CONFIG_VERSION, detectConfigMode } from '../../../src/sensorMap/configMode';

describe('detectConfigMode — legacy detection', () => {
  it('undefined config → legacy', () => {
    const r = detectConfigMode(undefined);
    expect(r.mode).toBe('legacy');
    expect(r.warnings).toHaveLength(0);
  });

  it('missing configVersion → legacy', () => {
    const r = detectConfigMode({ temperatureSensors: true });
    expect(r.mode).toBe('legacy');
    expect(r.warnings).toHaveLength(0);
  });

  it('configVersion: 1 (pre-v2 hand-labeled) → legacy, no warn', () => {
    const r = detectConfigMode({ configVersion: 1, temperatureSensors: true });
    expect(r.mode).toBe('legacy');
    expect(r.warnings).toHaveLength(0);
  });
});

describe('detectConfigMode — v2', () => {
  it('configVersion: 2 alone → v2, no warnings', () => {
    const r = detectConfigMode({ configVersion: 2, sensorMap: [] });
    expect(r.mode).toBe('v2');
    expect(r.warnings).toHaveLength(0);
  });

  it('configVersion: 2 with legacy toggles → v2 with ambiguity warn', () => {
    const r = detectConfigMode({
      configVersion: 2,
      sensorMap: [],
      temperatureSensors: true,
      windSensors: true,
    });
    expect(r.mode).toBe('v2');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/configVersion: 2 takes precedence/);
    expect(r.warnings[0]).toContain('temperatureSensors');
    expect(r.warnings[0]).toContain('windSensors');
  });
});

describe('detectConfigMode — safe mode on future version', () => {
  it(`configVersion: ${CURRENT_CONFIG_VERSION + 1} → safe-mode with banner`, () => {
    const r = detectConfigMode({ configVersion: CURRENT_CONFIG_VERSION + 1 });
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toBeDefined();
    expect(r.safeModeBanner).toMatch(/newer plugin version/);
    expect(r.safeModeBanner).toContain(String(CURRENT_CONFIG_VERSION + 1));
  });

  it('configVersion: 99 → safe-mode', () => {
    const r = detectConfigMode({ configVersion: 99 });
    expect(r.mode).toBe('safe-mode');
  });
});

describe('detectConfigMode — safe mode on malformed version', () => {
  it('non-integer number → safe-mode', () => {
    const r = detectConfigMode({ configVersion: 2.5 });
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toMatch(/not a supported integer/);
  });

  it('negative integer → safe-mode', () => {
    const r = detectConfigMode({ configVersion: -1 });
    expect(r.mode).toBe('safe-mode');
  });

  it('zero → safe-mode', () => {
    const r = detectConfigMode({ configVersion: 0 });
    expect(r.mode).toBe('safe-mode');
  });

  it('string value → safe-mode', () => {
    const r = detectConfigMode({ configVersion: '2' as unknown as number });
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toContain('"2"');
  });

  it('NaN → safe-mode', () => {
    const r = detectConfigMode({ configVersion: Number.NaN });
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toContain('NaN');
  });

  it('null → safe-mode', () => {
    const r = detectConfigMode({ configVersion: null as unknown as number });
    expect(r.mode).toBe('safe-mode');
    expect(r.safeModeBanner).toContain('null');
  });

  it('boolean → safe-mode', () => {
    const r = detectConfigMode({ configVersion: true as unknown as number });
    expect(r.mode).toBe('safe-mode');
  });
});

describe('detectConfigMode — determinism', () => {
  it('same input produces byte-equal result', () => {
    const cfg = { configVersion: 2, sensorMap: [], temperatureSensors: true };
    const a = detectConfigMode(cfg);
    const b = detectConfigMode(cfg);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

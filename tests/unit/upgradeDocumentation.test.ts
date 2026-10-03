import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const upgrade = readFileSync(new URL('../../UPGRADING.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const historical = upgrade.split('## Earlier upgrades (historical)\n')[1].split('## Where to get help\n')[0];

describe('shipping upgrade and rollback guidance', () => {
  it('nests the archived guides, steps and FAQ below the historical umbrella', () => {
    expect(historical).not.toMatch(/^## /m);
    for (const heading of ['v1.5.x', 'v1.4.x', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'Troubleshooting / FAQ']) {
      expect(historical).toContain(`### ${heading}`);
    }
    expect(historical).toContain('#### "Will my existing automations break?"');
    expect(historical).toContain('[v2.0.0 instructions](#upgrading-to-v2)');
    expect(upgrade).toContain('<a id="upgrading-to-v2"></a>');
  });

  it('does not present historical versions or floating install commands as current guidance', () => {
    const text = historical.replace(/\s+/g, ' ');
    for (const stale of ['currently `1.4.3`', 'where v1.5.0 currently lives', 'latest `1.5.0-beta.x`', 'v1.5.0 is fully additive', 'Use the new `stationFilter`']) {
      expect(text).not.toContain(stale);
    }
    const commands = [...historical.matchAll(/^sudo npm install -g ([^\s]+)$/gm)].map(m => m[1]);
    expect(commands).toEqual([
      '@bcourbage/homebridge-ambient-weather-sensors@1.6.0',
      '@bcourbage/homebridge-ambient-weather-sensors@1.5.0',
    ]);
  });

  it('warns that verified rollback can change automation behavior and reconversion is not recovery', () => {
    for (const doc of [upgrade, readme]) {
      const text = doc.replace(/\s+/g, ' ');
      expect(text).toMatch(/[Mm]otion sensors may trigger again/);
      expect(text).toContain('under different conditions');
      expect(text).toContain('Back up your full Homebridge configuration');
      expect(text).toContain('check your sensors and automations after restarting');
    }
    expect(readme).not.toContain('Operational rollback to your CURRENT settings');
    expect(readme).not.toContain('This rollback is a two-way door');
    expect(readme.replace(/\s+/g, ' ')).toContain('You will need your backup to recover lost v2 settings');
    expect(readme.replace(/\s+/g, ' ')).toContain('reinstalling v2 or converting your settings again will not restore them');
  });
});

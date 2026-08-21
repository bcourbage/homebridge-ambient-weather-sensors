/**
 * Top-banner truthfulness regression (review #45 round 2): the
 * fragment page's status banner must branch on the v2 flag — never
 * claiming a config-converting save is available while the server
 * would refuse it, and never hiding that saving exists when it is.
 *
 * The banner lives in the handwritten inline script, so this pins the
 * source: the branch condition and both texts' load-bearing claims.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const html = readFileSync(
  path.join(__dirname, '..', '..', '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');

describe('status banner flag-truthfulness', () => {
  it('branches on status.v2Flag.enabled', () => {
    expect(html).toContain('status.v2Flag && status.v2Flag.enabled');
  });

  it('the flag-ON text describes guarded saving with confirmation', () => {
    expect(html).toMatch(/can draft, preview, and save changes[\s\S]*guarded snapshot-first boundary[\s\S]*explicit confirmation/);
  });

  it('the flag-OFF text says draft-and-preview only and directs to the flag + restart', () => {
    expect(html).toMatch(/draft-and-preview only while the sensor-map v2 flag is off — saving is disabled/);
    expect(html).toMatch(/restart Homebridge to edit for real/);
  });

  it('no unconditional claim that the editor saves', () => {
    // Both save-capable phrasings must live inside the ternary that
    // tests the flag: strip the branch and assert no save claim
    // remains elsewhere in the page.
    const withoutBranch = html.replace(/status\.v2Flag && status\.v2Flag\.enabled[\s\S]*?restart Homebridge to edit for real\.';/, '');
    expect(withoutBranch).not.toContain('save changes');
  });
});

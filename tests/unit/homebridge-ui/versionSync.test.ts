/**
 * Release-version synchronization (PR #25 review F2): the UI bridge
 * displays a STATIC version constant (a deliberate choice — the bridge
 * subprocess avoids a runtime dependency on package.json's on-disk
 * path), which silently drifts on every version bump unless something
 * fails loudly. This test is that something: it fails whenever
 * package.json's version and homebridge-ui/server.ts's PLUGIN_VERSION
 * disagree — in BOTH source and the shipped compiled bridge.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const pkgVersion: string = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;

function extractPluginVersion(file: string): string | undefined {
  const src = readFileSync(path.join(root, file), 'utf8');
  return /const PLUGIN_VERSION(?:: string)? = '([^']+)'/.exec(src)?.[1];
}

describe('UI bridge version stamp stays in sync with package.json', () => {
  it('homebridge-ui/server.ts matches', () => {
    expect(extractPluginVersion('homebridge-ui/server.ts')).toBe(pkgVersion);
  });

  it('the compiled homebridge-ui/server.js (what actually ships) matches', () => {
    expect(extractPluginVersion('homebridge-ui/server.js')).toBe(pkgVersion);
  });
});

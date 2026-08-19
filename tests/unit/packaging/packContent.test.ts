/**
 * npm package-content gate (GA task #69, §10.1 packaging invariants).
 *
 * The editor app ships as COMMITTED build artifacts — no install-time
 * builds — so the published tarball must contain the fragment page,
 * exactly one content-hashed app bundle, and that bundle must be the
 * one index.html references. Build inputs (app sources, Angular
 * config, build scripts, tests) must never ship.
 *
 * Runs `npm pack --dry-run --json` against the working tree: the same
 * files list `npm publish` would use.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..', '..');

let files: string[];

beforeAll(() => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const report = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  files = report[0].files.map(f => f.path);
}, 60_000);

describe('published package contents', () => {
  it('ships the runtime surfaces', () => {
    for (const required of [
      'package.json',
      'config.schema.json',
      'dist/index.js',
      'homebridge-ui/server.js',
      'homebridge-ui/handlers.js',
      'homebridge-ui/public/index.html',
    ]) {
      expect(files).toContain(required);
    }
  });

  it('ships exactly one hashed app bundle, and it is the one index.html references', () => {
    const bundles = files.filter(f => /^homebridge-ui\/public\/app\/main-[0-9A-Z]{8}\.js$/.test(f));
    expect(bundles).toHaveLength(1);
    const html = readFileSync(path.join(root, 'homebridge-ui', 'public', 'index.html'), 'utf8');
    const referenced = /<script type="module" src="app\/(main-[0-9A-Z]{8}\.js)"><\/script>/.exec(html);
    expect(referenced).not.toBeNull();
    expect(bundles[0]).toBe(`homebridge-ui/public/app/${referenced![1]}`);
  });

  it('ships no build inputs, caches, or tests', () => {
    const forbidden = [
      /^homebridge-ui\/app-src\//,
      /^homebridge-ui\/angular\.json$/,
      /^homebridge-ui\/tsconfig/,
      /^homebridge-ui\/\.angular\//,
      /^scripts\//,
      /^tests\//,
      /^src\//,
      /^package-lock\.json$/,
    ];
    const offenders = files.filter(f => forbidden.some(re => re.test(f)));
    expect(offenders).toEqual([]);
  });
});

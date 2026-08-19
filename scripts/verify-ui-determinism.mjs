/**
 * Reproducibility gate for the committed Angular editor artifacts
 * (GA task #69, §10.1 packaging invariants):
 *
 *   1. TWO cold builds must be byte-identical (build determinism);
 *   2. the rebuild must be byte-identical to the COMMITTED artifacts
 *     (no stale/hand-edited outputs in git);
 *   3. the fragment updater must be a no-op afterwards (index.html's
 *      asset references match the committed bundles).
 *
 * Run by the canonical Node 22.12 CI job. Exits non-zero with a
 * per-file diagnosis on any mismatch.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coldBuild } from './build-ui-app.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'homebridge-ui', 'public', 'app');
const indexPath = path.join(root, 'homebridge-ui', 'public', 'index.html');

function manifest() {
  const out = new Map();
  for (const f of fs.readdirSync(appDir).sort()) {
    out.set(f, createHash('sha256').update(fs.readFileSync(path.join(appDir, f))).digest('hex'));
  }
  return out;
}

function compare(label, a, b) {
  const problems = [];
  for (const [f, h] of a) {
    if (!b.has(f)) {
      problems.push(`${f}: only in ${label.split(' vs ')[0]}`);
    } else if (b.get(f) !== h) {
      problems.push(`${f}: content differs`);
    }
  }
  for (const f of b.keys()) {
    if (!a.has(f)) {
      problems.push(`${f}: only in ${label.split(' vs ')[1]}`);
    }
  }
  if (problems.length > 0) {
    console.error(`[verify-ui-determinism] MISMATCH (${label}):`);
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }
  console.log(`[verify-ui-determinism] OK: ${label} (${a.size} files)`);
}

const committed = manifest();
const committedIndex = fs.readFileSync(indexPath, 'utf8');

coldBuild();
const first = manifest();

coldBuild();
const second = manifest();

compare('build #1 vs build #2', first, second);
compare('committed vs rebuild', committed, first);

execFileSync(process.execPath, [path.join(root, 'scripts', 'update-ui-fragment.mjs')], {
  stdio: 'inherit',
});
if (fs.readFileSync(indexPath, 'utf8') !== committedIndex) {
  console.error('[verify-ui-determinism] MISMATCH: fragment updater changed index.html — committed asset references are stale');
  process.exit(1);
}
console.log('[verify-ui-determinism] OK: committed index.html asset references are current');

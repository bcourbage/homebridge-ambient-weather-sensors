/**
 * Cold, reproducible build of the Angular editor app (GA task #69).
 *
 * Always builds from scratch: the output directory and Angular's build
 * cache are removed first, so the committed artifacts never depend on
 * incremental-build state. After the build, the fragment updater
 * rewrites index.html's asset references.
 *
 * The CANONICAL artifact producer is the Node 22.13 CI job
 * (ui-app-determinism in build.yml); local runs on other Node versions
 * are for development, and CI fails the build if committed artifacts
 * don't match the canonical rebuild.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(root, 'homebridge-ui');

export function coldBuild() {
  const appDir = path.join(uiDir, 'public', 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(path.join(uiDir, '.angular'), { recursive: true, force: true });
  execFileSync(path.join(root, 'node_modules', '.bin', 'ng'), ['build'], {
    cwd: uiDir,
    stdio: 'inherit',
  });
  // Normalize trailing whitespace in the generated license report so
  // `git diff --check` can stay a repository-wide gate. Deterministic:
  // pure function of ng's output, applied on every cold build.
  const licenses = path.join(appDir, '3rdpartylicenses.txt');
  if (fs.existsSync(licenses)) {
    const normalized = fs.readFileSync(licenses, 'utf8').replace(/[ \t]+$/gm, '');
    fs.writeFileSync(licenses, normalized);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  coldBuild();
  execFileSync(process.execPath, [path.join(root, 'scripts', 'update-ui-fragment.mjs')], {
    stdio: 'inherit',
  });
}

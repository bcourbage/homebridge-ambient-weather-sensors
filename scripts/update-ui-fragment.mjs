/**
 * Deterministic asset-reference updater for the custom-UI fragment
 * (GA task #69). Angular writes content-hashed bundles into
 * homebridge-ui/public/app/; this script rewrites the marked block in
 * homebridge-ui/public/index.html to reference them.
 *
 * Deterministic by construction: output depends only on the sorted
 * directory listing, so updater runs are idempotent and two runs over
 * identical build output produce byte-identical HTML. Any surprise in
 * the output shape (no main bundle, more than one, unknown top-level
 * file kind) is a hard failure — silently guessing would ship a UI
 * that can't boot.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'homebridge-ui', 'public', 'app');
const indexPath = path.join(root, 'homebridge-ui', 'public', 'index.html');

const BEGIN = '<!-- awn-app:assets:begin -->';
const END = '<!-- awn-app:assets:end -->';

// Angular emits an 8-char uppercase base36 content hash with
// outputHashing "all". Non-referenced build metadata is allowlisted so
// a NEW kind of output file forces a human decision here instead of
// being silently ignored.
const MAIN_RE = /^main-[0-9A-Z]{8}\.js$/;
const STYLES_RE = /^styles-[0-9A-Z]{8}\.css$/;
const CHUNK_RE = /^chunk-[0-9A-Z]{8}\.js$/; // loaded via import(), no tag needed
const METADATA = new Set(['3rdpartylicenses.txt', 'prerendered-routes.json']);

const files = fs.readdirSync(appDir).sort();
const mains = files.filter((f) => MAIN_RE.test(f));
const styles = files.filter((f) => STYLES_RE.test(f));
const unknown = files.filter(
  (f) => !MAIN_RE.test(f) && !STYLES_RE.test(f) && !CHUNK_RE.test(f) && !METADATA.has(f),
);

if (mains.length !== 1) {
  throw new Error(`expected exactly one main-*.js in ${appDir}, found: ${mains.join(', ') || '(none)'}`);
}
if (unknown.length > 0) {
  throw new Error(`unrecognized build output in ${appDir}: ${unknown.join(', ')} — extend the allowlist deliberately`);
}

const tags = [
  ...styles.map((f) => `  <link rel="stylesheet" href="app/${f}" />`),
  ...mains.map((f) => `  <script type="module" src="app/${f}"></script>`),
];

const html = fs.readFileSync(indexPath, 'utf8');
const begin = html.indexOf(BEGIN);
const end = html.indexOf(END);
if (begin === -1 || end === -1 || end < begin) {
  throw new Error(`asset markers missing or malformed in ${indexPath}`);
}

const next =
  html.slice(0, begin + BEGIN.length) + '\n' + tags.join('\n') + '\n  ' + html.slice(end);

if (next !== html) {
  fs.writeFileSync(indexPath, next);
  console.log(`[update-ui-fragment] rewrote asset block: ${[...styles, ...mains].join(', ')}`);
} else {
  console.log('[update-ui-fragment] asset block already current');
}

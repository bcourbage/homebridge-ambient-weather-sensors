import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function hasVisibleContent(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}#{1,6}(?:[ \t].*)?$/gm, '')
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
    .replace(/^\s*\[[^\]]+\]:[^\n]*$/gm, '').trim().length > 0;
}

/** Refuse publication before npm can receive a version without its release copy. */
export function prepareReleaseNotes({ version, tag, changelog, readme }) {
  assert.equal(tag, `v${version}`, 'release tag must match package.json');
  assert.ok(hasVisibleContent(readme), 'the npm README must contain visible content');
  // A heading inside a Markdown example is not a release boundary. Preserve
  // the original body, including its examples, while recognizing boundaries.
  let fence;
  let comment = false;
  let first;
  const lines = [];
  for (const line of changelog.split(/\r?\n/)) {
    if (fence) {
      if (first) lines.push(line);
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    let structural = '';
    let offset = 0;
    while (offset < line.length) {
      if (comment) {
        const end = line.indexOf('-->', offset);
        if (end < 0) break;
        comment = false;
        offset = end + 3;
      } else {
        const start = line.indexOf('<!--', offset);
        if (start < 0) { structural += line.slice(offset); break; }
        structural += line.slice(offset, start);
        comment = true;
        offset = start + 4;
      }
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(structural);
    if (opening) {
      fence = opening[1];
    } else if (/^ {1,3}##(?:[ \t]|$)/.test(structural)) {
      assert.fail('release-section headings must start at column one');
    } else if (/^##(?:[ \t]|$)/.test(structural)) {
      if (first) break;
      first = structural;
      continue;
    }
    if (first) lines.push(line);
  }
  assert.ok(first, 'CHANGELOG.md must have a version section');
  assert.ok(!fence && !comment, 'release notes contain an unclosed fence or comment');
  const heading = /^## \[([^\]]+)\] (?:-|—) (\d{4}-\d{2}-\d{2})$/.exec(first);
  assert.ok(heading, 'the first changelog section must have a release date, not Unreleased');
  assert.equal(heading[1], version, 'the first changelog version must match package.json');
  const date = new Date(`${heading[2]}T00:00:00Z`);
  assert.ok(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === heading[2], 'invalid release date');
  const body = lines.join('\n').trim();
  assert.ok(hasVisibleContent(body), 'release notes must contain substantive visible content');
  return `${body}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const notes = prepareReleaseNotes({
    version: manifest.version,
    tag: process.env.GITHUB_REF_NAME,
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    readme: readFileSync('README.md', 'utf8'),
  });
  writeFileSync('release-notes.md', notes);
  console.log(`Release copy verified for v${manifest.version}.`);
}

import { describe, expect, it } from 'vitest';
import { prepareReleaseNotes } from '../../scripts/prepare-release-notes.mjs';

const input = {
  version: '2.0.0', tag: 'v2.0.0', readme: '# Ambient Weather\n\nGA summary.',
  changelog: '# Changelog\n\n## [2.0.0] - 2026-10-01\n\nApproved GA copy.\n\n## [2.0.0-beta.19] - 2026-09-26\n\nOld copy.\n',
};

describe('pre-publication release copy', () => {
  it('extracts exactly the dated current section, not older release copy', () => {
    expect(prepareReleaseNotes(input)).toBe('Approved GA copy.\n');
  });
  it('accepts the historical heading separator and prerelease version', () => {
    expect(prepareReleaseNotes({ ...input, version: '2.0.0-beta.19', tag: 'v2.0.0-beta.19',
      changelog: '## [2.0.0-beta.19] — 2026-09-26\n\nBeta copy.\n\n[link]: https://example.test\n',
    })).toBe('Beta copy.\n\n[link]: https://example.test\n');
  });
  it('preserves headings inside fenced examples and all following copy', () => {
    const body = 'Before.\n\n```md\n## [Example]\n```\n\nAfter.\n';
    expect(prepareReleaseNotes({ ...input,
      changelog: `## [2.0.0] - 2026-10-01\n\n${body}\n## [1.0.0] - 2026-01-01\nOld.`,
    })).toBe(body);
  });
  it('ignores headings in leading comments and supports CRLF and tilde fences', () => {
    const changelog = '<!--\n## Unreleased\n-->\n## [2.0.0] - 2026-10-01\n\nText.\n~~~md\n## Example\n~~~\nMore.\n';
    expect(prepareReleaseNotes({ ...input, changelog: changelog.replaceAll('\n', '\r\n') }))
      .toBe('Text.\n~~~md\n## Example\n~~~\nMore.\n');
  });
  it.each([
    ['wrong tag', { tag: 'v2.0.1' }],
    ['missing tag', { tag: undefined }],
    ['empty npm README', { readme: ' \n' }],
    ['missing section', { changelog: '# Changelog\n' }],
    ['undated candidate', { changelog: input.changelog.replace('2026-10-01', 'Unreleased') }],
    ['wrong leading version', { changelog: input.changelog.replace('[2.0.0]', '[2.0.1]') }],
    ['invalid calendar date', { changelog: input.changelog.replace('2026-10-01', '2026-02-30') }],
    ['empty current notes', { changelog: input.changelog.replace('Approved GA copy.', '') }],
    ['comment-only notes', { changelog: input.changelog.replace('Approved GA copy.', '<!-- Awaiting approval -->') }],
    ['heading-only scaffolding', { changelog: input.changelog.replace('Approved GA copy.', '### Added\n\n### Fixed') }],
    ['invisible npm README', { readme: '<!-- TODO -->' }],
    ['bare unreleased section', { changelog: '## Unreleased\n\nPending\n' + input.changelog }],
    ['unterminated code example', { changelog: '## [2.0.0] - 2026-10-01\n\nText.\n```md\n## Example' }],
    ['indented release heading', { changelog: input.changelog.replace('## [2.0.0]', ' ## [2.0.0]') }],
    ['malformed first heading', { changelog: '## [Unreleased]\n\nPending\n' + input.changelog }],
  ])('refuses %s instead of publishing with fallback text', (_name, patch) => {
    expect(() => prepareReleaseNotes({ ...input, ...patch })).toThrow();
  });
});

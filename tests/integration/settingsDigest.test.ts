/** Settings-only previews must bind the stamps the running binary will write. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as handlers from '../../homebridge-ui/handlers.js';
import { CURRENT_CATALOG_VERSION } from '../../dist/sensorMap/catalogVersion.js';
import { DraftStore } from '../../homebridge-ui/app-src/draft-store';

const roots: string[] = [];
function rig(block?: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'settings-digest-'));
  roots.push(root);
  const persistDir = path.join(root, 'plugin-data');
  mkdirSync(persistDir);
  const configPath = path.join(root, 'config.json');
  const before = JSON.stringify({ platforms: block ? [block] : [] });
  writeFileSync(configPath, before);
  return { before, configPath, persistDir, deps: {
    configPath, persistDir, version: 'test', log: { info() {}, warn() {}, debug() {} },
  } };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

/**
 * Execute the committed bridge with just its running-version constant changed.
 * The real imports, patch application, digest, compose and commit all run.
 * Fresh settings-only creation never resolves catalog rows, so this isolates
 * the exact binary-upgrade difference without a second engine or a test-only
 * production version override. Existing blocks provide a preservation control.
 */
async function bridgeAt(version: number): Promise<typeof handlers> {
  const url = pathToFileURL(path.resolve('homebridge-ui/handlers.js'));
  const source = readFileSync(url, 'utf8');
  const binding = 'import { CURRENT_CATALOG_VERSION, parseCatalogStamps }';
  expect(source.split(binding)).toHaveLength(2);
  const executable = source
    .replace(binding, 'import { CURRENT_CATALOG_VERSION as _runningVersion, parseCatalogStamps }')
    .replace(/from '(\.\.?\/[^']+)'/g, (_, specifier: string) => `from '${new URL(specifier, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(
    `const CURRENT_CATALOG_VERSION = ${version};\n${executable}`,
  ).toString('base64')}`);
}

const settings = { name: 'Home Weather', apiKey: { set: 'private-api-key' }, applicationKey: { set: 'private-app-key' } };
const freshPayload = { baseDigest: handlers.FRESH_INSTALL_DIGEST, proposal: [], settings };

describe('settings-only birth-stamp confirmation', () => {
  it('refuses a preview replay across a running-catalog change before compose or commit can return a config', async () => {
    const oldBridge = await bridgeAt(CURRENT_CATALOG_VERSION - 1);
    const r = rig();
    const oldPreview = await oldBridge.handlePreviewSave(r.deps, freshPayload);
    const preview = await handlers.handlePreviewSave(r.deps, freshPayload);
    expect(oldPreview.ok && preview.ok).toBe(true);
    if (!oldPreview.ok || !preview.ok) throw new Error('preview failed');
    const oldCompose = await oldBridge.handleComposeSave(r.deps, { ...freshPayload, confirmDigest: oldPreview.digest });
    expect(oldCompose).toMatchObject({ ok: true, nextConfig: {
      catalogBaseline: CURRENT_CATALOG_VERSION - 1, catalogAdopted: CURRENT_CATALOG_VERSION - 1,
    } });
    expect(preview.digest).not.toBe(oldPreview.digest);
    const stale = { ...freshPayload, confirmDigest: oldPreview.digest };
    expect(await handlers.handleComposeSave(r.deps, stale)).toMatchObject({ ok: false, error: { code: 'stale-confirmation' } });
    expect(await handlers.handleCommitSave(r.deps, {
      ...stale, validationToken: oldCompose.ok ? oldCompose.validationToken : '',
    })).toMatchObject({ ok: false, error: { code: 'stale-confirmation' } });
    expect(readFileSync(r.configPath, 'utf8')).toBe(r.before);
    expect(readdirSync(r.persistDir)).toEqual([]);
  });

  it('accepts a fresh current preview through both phases, with no sensor conversion or durable records', async () => {
    const r = rig();
    const preview = await handlers.handlePreviewSave(r.deps, freshPayload);
    if (!preview.ok) throw new Error('preview failed');
    expect(preview).not.toHaveProperty('configurationTransition');
    expect(JSON.stringify(preview)).not.toContain('private-');
    const compose = await handlers.handleComposeSave(r.deps, { ...freshPayload, confirmDigest: preview.digest });
    if (!compose.ok) throw new Error('compose failed');
    const commit = await handlers.handleCommitSave(r.deps, {
      ...freshPayload, confirmDigest: preview.digest, validationToken: compose.validationToken,
    });
    expect(commit).toMatchObject({ ok: true, snapshot: 'not-applicable', nextConfig: {
      platform: 'AmbientWeatherSensors', name: settings.name,
      apiKey: settings.apiKey.set, applicationKey: settings.applicationKey.set,
      catalogBaseline: CURRENT_CATALOG_VERSION, catalogAdopted: CURRENT_CATALOG_VERSION,
    } });
    if (!commit.ok) throw new Error('commit failed');
    expect(commit.nextConfig).not.toHaveProperty('sensorMap');
    expect(commit.nextConfig).not.toHaveProperty('configVersion');
    expect(readFileSync(r.configPath, 'utf8')).toBe(r.before);
    expect(readdirSync(r.persistDir)).toEqual([]);
  });

  it.each([undefined, { catalogBaseline: 1, catalogAdopted: 3 }])('preserves existing stamps and permits the same preview across binary versions: %j', async stamps => {
    const oldBridge = await bridgeAt(CURRENT_CATALOG_VERSION - 1);
    const block = { platform: 'AmbientWeatherSensors', name: 'Existing', apiKey: 'original', ...stamps };
    const r = rig(block);
    const state = await handlers.handleGetEditorState(r.deps, {});
    const drafts = new DraftStore();
    drafts.reset(state.authored);
    const payload = { baseDigest: state.baseDigest, formBlock: block, proposal: drafts.proposal(), settings };
    const oldPreview = await oldBridge.handlePreviewSave(r.deps, payload);
    const preview = await handlers.handlePreviewSave(r.deps, payload);
    if (!oldPreview.ok || !preview.ok) throw new Error('preview failed');
    expect(preview.digest).toBe(oldPreview.digest);
    const compose = await handlers.handleComposeSave(r.deps, { ...payload, confirmDigest: oldPreview.digest });
    if (!compose.ok) throw new Error('compose failed');
    const commit = await handlers.handleCommitSave(r.deps, { ...payload, confirmDigest: preview.digest, validationToken: compose.validationToken });
    expect(commit).toMatchObject({ ok: true, nextConfig: { ...block, name: settings.name, apiKey: settings.apiKey.set } });
    if (!commit.ok) throw new Error('commit failed');
    expect(commit.nextConfig.catalogBaseline).toBe(stamps?.catalogBaseline);
    expect(commit.nextConfig.catalogAdopted).toBe(stamps?.catalogAdopted);
    expect(readdirSync(r.persistDir)).toEqual([]);
  });

  it('retires the old unbound projection and preserves credential-intent privacy', async () => {
    const r = rig();
    // Exact pre-hardening canonical projection. This must require a new preview,
    // not accept a legacy digest as a compatibility fallback.
    const unbound = createHash('sha256').update(JSON.stringify({
      base: null, settingsChanged: ['apiKey', 'applicationKey', 'name'], v: 'settings-only-1',
    })).digest('hex');
    expect(await handlers.handleComposeSave(r.deps, { ...freshPayload, confirmDigest: unbound }))
      .toMatchObject({ ok: false, error: { code: 'stale-confirmation' } });
    const a = await handlers.handlePreviewSave(r.deps, freshPayload);
    const b = await handlers.handlePreviewSave(r.deps, {
      ...freshPayload, settings: { ...settings, apiKey: { set: 'different-secret' } },
    });
    if (!a.ok || !b.ok) throw new Error('preview failed');
    // Binding stamps must not turn the public confirmation digest into an
    // oracle for proposed credential values. The private commit token already
    // binds the exact composed output between validation and commit.
    expect(a.digest).toBe(b.digest);
    expect(readFileSync(r.configPath, 'utf8')).toBe(r.before);
    expect(readdirSync(r.persistDir)).toEqual([]);
  });
});

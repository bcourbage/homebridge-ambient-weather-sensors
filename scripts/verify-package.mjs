/**
 * Install the actual npm tarball with production dependencies only, then
 * exercise its entry point and real custom-UI subprocess. No source imports,
 * repository node_modules, compiler, Homebridge dev dependency, or install
 * scripts are available to the installed plugin.
 */
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(tmpdir(), 'awn-production-package-'));
const install = path.join(root, 'install');
const storage = path.join(root, 'homebridge');
const configPath = path.join(storage, 'config.json');
const persistDir = path.join(storage, 'plugin-data', 'ambient-weather');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache') };
delete env.NODE_PATH;
delete env.SENSOR_MAP_V2;
let child;
let requestId = 0;
let output = '';
const pending = new Map();
const secrets = ['FAKE-P5-API-KEY', 'FAKE-P5-APPLICATION-KEY', 'FAKE-P5-REPLACEMENT'];
const quietRead = file => readFileSync(file, 'utf8');

function command(args, cwd) {
  return execFileSync(npm, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
}
function safe(payload) {
  const text = JSON.stringify(payload);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'secret leaked through a read model or diagnostic');
}
async function request(endpoint, body = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Packaged UI did not answer ${endpoint}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.send({ action: 'request', requestId: id, path: endpoint, body });
  });
}
async function readState(body = {}) {
  const before = quietRead(configPath);
  const state = await request('/editor-state', body);
  safe(state);
  assert.equal(quietRead(configPath), before, 'opening the editor changed config.json');
  return state;
}
async function saveSettings(state, settings) {
  const disk = JSON.parse(quietRead(configPath));
  const current = disk.platforms.find(b => b.platform === 'AmbientWeatherSensors');
  const proposal = state.authored.map(fragment => {
    assert.ok(!fragment.unreconstructable && !fragment.unknownKeys?.length);
    return {
      ...(fragment.dataPoint !== undefined ? { dataPoint: fragment.dataPoint } : {}),
      ...(fragment.stationMac !== undefined ? { stationMac: fragment.stationMac } : {}),
      ...fragment.identityRaw,
      ...fragment.fields,
    };
  });
  const payload = { baseDigest: state.baseDigest, proposal, settings, ...(current ? { formBlock: current } : {}) };
  const before = quietRead(configPath);
  const preview = await request('/preview-save', payload);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  safe(preview);
  assert.equal(preview.configurationTransition, undefined, 'settings-only creation is not catalog adoption');
  const composed = await request('/compose-save', { ...payload, confirmDigest: preview.digest });
  assert.equal(composed.ok, true, JSON.stringify(composed));
  const committed = await request('/commit-save', {
    ...payload, confirmDigest: preview.digest, validationToken: composed.validationToken,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(quietRead(configPath), before, 'the server wrote config.json without the client persistence step');
  assert.ok(!existsSync(persistDir) || readdirSync(persistDir).length === 0, 'connection save created migration records');
  // The real IPC boundary returns the persistable block. Simulate only HB
  // UI's final disk write, preserving unrelated platform blocks verbatim.
  disk.platforms = current
    ? disk.platforms.map(b => b === current ? committed.nextConfig : b)
    : [...disk.platforms, committed.nextConfig];
  writeFileSync(configPath, JSON.stringify(disk));
  return committed.nextConfig;
}

try {
  mkdirSync(install);
  mkdirSync(storage);
  const packed = JSON.parse(command(['pack', '--ignore-scripts', '--json', '--pack-destination', root], repo))[0];
  const archive = path.join(root, packed.filename);
  writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  command(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], install);
  const installed = path.join(install, 'node_modules', '@bcourbage', 'homebridge-ambient-weather-sensors');
  const manifest = JSON.parse(quietRead(path.join(installed, 'package.json')));
  assert.equal(manifest.version, JSON.parse(quietRead(path.join(repo, 'package.json'))).version);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `runtime install must not need ${hook}`);
  }
  for (const devOnly of ['typescript', 'vitest', 'homebridge', 'awn-v1-7-3', 'awn-v2-beta17', '@angular/core']) {
    assert.ok(!existsSync(path.join(install, 'node_modules', devOnly)), `${devOnly} masked a missing production dependency`);
  }
  for (const excluded of ['src', 'tests', 'scripts', 'homebridge-ui/app-src']) {
    assert.ok(!existsSync(path.join(installed, excluded)), `${excluded} was accidentally published`);
  }
  const index = quietRead(path.join(installed, 'homebridge-ui/public/index.html'));
  const bundles = [...index.matchAll(/src="(?:\.\/)?(app\/[^"?]+\.js)"/g)].map(m => m[1]);
  assert.equal(bundles.length, 1, 'the fragment must reference exactly one compiled app');
  assert.ok(existsSync(path.join(installed, 'homebridge-ui/public', bundles[0])));
  const entry = await import(pathToFileURL(path.join(installed, 'dist/index.js')).href);
  let registrations = 0;
  entry.default({ registerPlatform(name, ctor) {
    assert.equal(name, 'AmbientWeatherSensors');
    assert.equal(typeof ctor, 'function');
    registrations++;
  } });
  assert.equal(registrations, 1);

  const other = { platform: 'UnrelatedPlatform', name: 'Preserve me', nested: { enabled: false } };
  writeFileSync(configPath, JSON.stringify({ platforms: [other] }));
  child = fork(path.join(installed, 'homebridge-ui/server.js'), [], {
    cwd: install,
    env: { ...env, HOMEBRIDGE_STORAGE_PATH: storage, HOMEBRIDGE_CONFIG_PATH: configPath },
    silent: true,
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged UI server never became ready')), 10_000);
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`UI server exited (${code})`)); }
      pending.clear();
      reject(new Error(`UI server exited before readiness (${code})`));
    });
    child.on('message', message => {
      if (message.action === 'ready') { clearTimeout(timer); resolve(); }
      if (message.action === 'response') {
        const p = pending.get(message.payload.requestId);
        if (!p) return;
        pending.delete(message.payload.requestId);
        clearTimeout(p.timer);
        if (message.payload.success) p.resolve(message.payload.data);
        else p.reject(new Error(`UI request refused: ${JSON.stringify(message.payload.data)}`));
      }
    });
  });
  await ready;
  const fresh = await readState();
  assert.equal(fresh.freshInstall, true);
  assert.deepEqual(fresh.rows, []);
  assert.equal(fresh.settings.apiKeySet, false);
  const vocabulary = await request('/vocabulary', { vocabularyProtocol: 2 });
  assert.equal(vocabulary.vocabularyProtocol, 2);
  safe(vocabulary);
  safe(await request('/notices'));
  assert.ok(!existsSync(persistDir), 'read-only startup created plugin-data');
  const first = await saveSettings(fresh, {
    name: 'Package proof', apiKey: { set: secrets[0] }, applicationKey: { set: secrets[1] },
  });
  assert.equal(first.apiKey, secrets[0]);
  assert.equal(first.applicationKey, secrets[1]);
  assert.equal(first.catalogBaseline, fresh.catalog.current);
  assert.equal(first.catalogAdopted, fresh.catalog.current);
  for (const key of ['sensorMap', 'configVersion', '_legacyMirror']) assert.equal(first[key], undefined);
  assert.deepEqual(JSON.parse(quietRead(configPath)).platforms[0], other);
  const credentialState = await readState();
  assert.equal(credentialState.settings.apiKeySet, true);
  assert.equal(credentialState.settings.applicationKeySet, true);
  const replaced = await saveSettings(credentialState, { apiKey: { set: secrets[2] } });
  assert.equal(replaced.apiKey, secrets[2]);
  assert.equal(replaced.applicationKey, secrets[1]);
  assert.equal(replaced.catalogBaseline, first.catalogBaseline);
  const cleared = await saveSettings(await readState(), { apiKey: { clear: true } });
  assert.ok(!cleared.apiKey);
  assert.equal(cleared.applicationKey, secrets[1]);

  // A manually authored never-converted block with unusable credentials must
  // be repairable before any station inventory exists.
  writeFileSync(configPath, JSON.stringify({ platforms: [other, {
    platform: 'AmbientWeatherSensors', name: 'Manual installation',
    apiKey: secrets[0], temperatureSensors: false,
  }] }));
  const manual = await readState();
  assert.equal(manual.freshInstall, undefined);
  assert.deepEqual(manual.rows, []);
  const fixed = await saveSettings(manual, { apiKey: { set: secrets[2] }, applicationKey: { set: secrets[1] } });
  assert.equal(fixed.temperatureSensors, false);
  assert.equal(fixed.configVersion, undefined);
  assert.equal(fixed.catalogBaseline, undefined, 'credential repair must not adopt the catalog');
  for (const secret of secrets) assert.ok(!output.includes(secret), 'UI subprocess logged a credential');
  console.log(`Production package verified: ${manifest.version}; entry point, packaged app, real UI IPC, fresh/manual connection saves, secret handling.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    try { await stopped; } finally { clearTimeout(killTimer); }
  }
  for (const p of pending.values()) clearTimeout(p.timer);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

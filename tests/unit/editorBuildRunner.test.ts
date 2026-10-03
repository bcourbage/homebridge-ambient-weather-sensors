import { afterEach, describe, expect, it, vi } from 'vitest';
import { Architect } from '@angular-devkit/architect';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runEditorBuild } from '../../scripts/run-editor-build.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

function fixture(options: object = {}, production: object = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'awn-editor-runner-'));
  roots.push(root);
  const pkg = path.join(root, 'node_modules', 'fixture-builder');
  mkdirSync(pkg, { recursive: true });
  json(path.join(root, 'angular.json'), { version: 1, projects: { 'awn-editor': {
    root: '', projectType: 'application', architect: { build: {
      builder: 'fixture-builder:build', options,
      defaultConfiguration: 'production', configurations: { production },
    } },
  } } });
  json(path.join(pkg, 'package.json'), { name: 'fixture-builder', version: '1.0.0', builders: 'builders.json' });
  json(path.join(pkg, 'builders.json'), { builders: { build: {
    implementation: './index.cjs', schema: './schema.json', description: 'Build runner contract fixture',
  } } });
  json(path.join(pkg, 'schema.json'), { type: 'object', additionalProperties: false, properties: {
    count: { type: 'number', default: 3 },
    conditions: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string', enum: ['success', 'failure', 'throw', 'later-failure'], default: 'success' },
  } });
  writeFileSync(path.join(pkg, 'index.cjs'), `
const { createBuilder } = require(${JSON.stringify(require.resolve('@angular-devkit/architect'))});
const { of } = require(${JSON.stringify(require.resolve('rxjs'))});
const { writeFileSync } = require('node:fs');
const path = require('node:path');
module.exports = createBuilder((options, context) => {
  writeFileSync(path.join(context.workspaceRoot, 'entered'), 'yes');
  context.logger.warn('fixture diagnostic');
  if (options.mode === 'throw') throw new Error('fixture thrown failure');
  if (options.mode === 'failure') return { success: false, error: 'fixture failed output' };
  if (options.mode === 'later-failure') return of({ success: true }, { success: false, error: 'fixture final failure' });
  return { success: true, options, workspaceRoot: context.workspaceRoot, target: context.target };
});
`);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function observeStop() {
  const state = { calls: 0, completed: false };
  const schedule = Architect.prototype.scheduleTarget;
  vi.spyOn(Architect.prototype, 'scheduleTarget').mockImplementation(async function (...args) {
    const run = await schedule.apply(this, args);
    const stop = run.stop.bind(run);
    vi.spyOn(run, 'stop').mockImplementation(async () => {
      state.calls++;
      await stop();
      await new Promise<void>(resolve => setImmediate(resolve));
      state.completed = true;
    });
    return run;
  });
  return state;
}

describe('editor Architect runner without CLI installation tooling', () => {
  it('uses the workspace target, default configuration and Angular-build defaults', async () => {
    const root = fixture({ count: 5 }, { count: 7 });
    const stopped = observeStop();
    const result = await runEditorBuild(root);
    expect(result.options).toStrictEqual({ count: 7, mode: 'success', conditions: undefined });
    expect(result.workspaceRoot).toBe(root);
    expect(result.target).toMatchObject({ project: 'awn-editor', target: 'build' });
    // Completed jobs do not execute cancellation-only addTeardown hooks.
    // Observe the real stop promise to prove the runner calls and awaits it.
    expect(stopped).toEqual({ calls: 1, completed: true });
    // Generic Architect CLI defaults would invent conditions: [].
    expect(result.options.conditions).toBeUndefined();
  });

  it('validates options before executing a builder', async () => {
    const root = fixture({ count: 'invalid' });
    await expect(runEditorBuild(root)).rejects.toThrow(/schema validation/i);
    expect(existsSync(path.join(root, 'entered'))).toBe(false);
  });

  it.each(['failure', 'throw'])('propagates %s and completes teardown', async mode => {
    const root = fixture({ mode });
    const stopped = observeStop();
    await expect(runEditorBuild(root)).rejects.toThrow(/fixture (failed output|thrown failure)/);
    expect(stopped).toEqual({ calls: 1, completed: true });
  });

  it('rejects a final failure even when the builder first emits success', async () => {
    const root = fixture({ mode: 'later-failure' });
    const stopped = observeStop();
    await expect(runEditorBuild(root)).rejects.toThrow('fixture final failure');
    expect(stopped).toEqual({ calls: 1, completed: true });
  });

  it.each([
    [{ count: 'invalid' }, /schema validation/i],
    [{ mode: 'failure' }, /fixture failed output/],
  ])('a real Node subprocess returns nonzero on invalid or failed builds', (options, message) => {
    const root = fixture(options);
    const runner = new URL('../../scripts/run-editor-build.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runEditorBuild } from ${JSON.stringify(runner)}; await runEditorBuild(${JSON.stringify(root)});`,
    ], { cwd: root, encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });

  it('pins the matching build runner and excludes the CLI cache/install dependency chain', () => {
    const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
    const builder = require('@angular/build/package.json');
    const architect = require('@angular-devkit/architect/package.json');
    expect(manifest.devDependencies['@angular-devkit/architect']).toBe(builder.dependencies['@angular-devkit/architect']);
    expect(manifest.devDependencies['@angular-devkit/core']).toBe(architect.dependencies['@angular-devkit/core']);
    for (const name of ['@angular/cli', 'pacote', 'make-fetch-happen', 'http-cache-semantics']) {
      expect(manifest.devDependencies[name]).toBeUndefined();
      expect(Object.keys(lock.packages).some(key => key.endsWith(`node_modules/${name}`))).toBe(false);
      expect(existsSync(path.join(repo, 'node_modules', name))).toBe(false);
    }
  });
});

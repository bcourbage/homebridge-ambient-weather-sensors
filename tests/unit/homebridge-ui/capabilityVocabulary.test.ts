/** Pair-aware vocabulary and full-map preview projection contracts. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FRESH_INSTALL_DIGEST, handleCommitSave, handleComposeSave, handleGetEditorState,
  handleGetVocabulary, handlePreviewSave, type HandlerDeps,
} from '../../../homebridge-ui/handlers.js';
import { composeAndPersist, type OrchestratorDeps } from '../../../homebridge-ui/saveOrchestrator.js';
import type { LegacyVocabularyDto, VocabularyDto } from '../../../homebridge-ui/app-src/dto/editor-state.js';
import { DISPLAY_FAMILIES, MEASUREMENT_LABELS, UNIT_VOCABULARY, unitOptionsFor } from '../../../dist/sensorMap/unitVocabulary.js';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT, WRAPPER_PAIR_SINCE } from '../../../dist/sensorMap/wrappers.js';
import { NON_TRIGGERING_MEASUREMENTS } from '../../../dist/sensorMap/validation.js';
import { buildEffectiveSensorMap } from '../../../dist/sensorMap/buildEffectiveMap.js';
import { coerceValue } from '../../../dist/sensorMap/coerceValue.js';
import type { Measurement } from '../../../dist/sensorMap/types.js';

const MAC = 'AA:BB:CC:DD:EE:01';
const roots: string[] = [];
const quiet = { info: () => {}, warn: () => {}, debug: () => {} };

function rig(block?: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'p4-capabilities-'));
  roots.push(root);
  const persistDir = path.join(root, 'plugin-data');
  mkdirSync(persistDir);
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ platforms: block ? [block] : [] }));
  writeFileSync(path.join(persistDir, 'discovery.json'), JSON.stringify({ schemaVersion: 1, entries: [
    { stationMac: MAC, stationName: 'Home', dataPoint: 'tempf', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z' },
  ] }));
  return { root, persistDir, configPath, deps: { persistDir, configPath, log: quiet, version: 'test' } as HandlerDeps };
}

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function negotiated(): VocabularyDto {
  const value = handleGetVocabulary({ vocabularyProtocol: 2 });
  expect(value).toHaveProperty('vocabularyProtocol', 2);
  return value as VocabularyDto;
}

function legacyContract(): LegacyVocabularyDto {
  const order = Object.keys(UNIT_VOCABULARY) as Measurement[];
  return {
    measurements: Object.fromEntries(order.map(m => [m, {
      customSource: unitOptionsFor(m, 'custom-source').map(o => ({ unit: o.unit, label: o.label })),
      extendedDisplay: unitOptionsFor(m, 'extended-display').map(o => ({ unit: o.unit, label: o.label })),
    }])),
    families: DISPLAY_FAMILIES.map(f => ({ key: f.key, label: f.label, measurements: [...f.measurements], choices: f.choices.map(c => ({ id: c.id, label: c.label, units: { ...c.units } })) })),
    assignments: Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT)
      .filter(key => (WRAPPER_PAIR_SINCE[key as keyof typeof WRAPPER_PAIR_SINCE] ?? 1) <= 1)
      .map(key => {
        const [kind, measurement] = key.split('|') as [string, Measurement];
        return { kind, measurement, label: MEASUREMENT_LABELS[measurement], triggering: kind === 'motion' && !NON_TRIGGERING_MEASUREMENTS.includes(measurement) };
      }).sort((a, b) => order.indexOf(a.measurement) - order.indexOf(b.measurement)),
  };
}

describe('P4 negotiated capabilities', () => {
  it('retains the exact legacy response and measurement-keyed assignment set without negotiation', () => {
    expect(handleGetVocabulary()).toEqual(legacyContract());
    expect(handleGetVocabulary({})).toEqual(legacyContract());
    expect(Object.keys(handleGetVocabulary()).sort()).toEqual(['assignments', 'families', 'measurements']);
    const measurements = handleGetVocabulary().assignments.map(a => a.measurement);
    expect(new Set(measurements).size).toBe(measurements.length);
  });

  it.each([0, 2, '2', [], true, { vocabularyProtocol: 1 }, { vocabularyProtocol: 3 }, { vocabularyProtocol: null }, { vocabularyProtocol: '2' }, { vocabularyProtocol: [] }].map(payload => [payload]))('refuses malformed or unsupported protocol %j', payload => {
    expect(handleGetVocabulary(payload)).toMatchObject({ ok: false, error: { code: 'unsupported-vocabulary-protocol' } });
  });

  it('projects every implemented pair, version, trigger and source policy through the real resolver', () => {
    const dto = negotiated();
    const pairs = Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT);
    expect(dto.assignments.map(a => a.id).sort()).toEqual(pairs.sort());
    expect(new Set(dto.assignments.map(a => a.id)).size).toBe(pairs.length);
    expect(dto.assignments.some(a => a.kind === 'co')).toBe(false);
    for (const option of dto.assignments) {
      expect(option.id).toBe(`${option.kind}|${option.measurement}`);
      expect(option.since).toBe(WRAPPER_PAIR_SINCE[option.id as keyof typeof WRAPPER_PAIR_SINCE] ?? 1);
      expect(option.triggering).toBe(option.kind === 'motion' && !NON_TRIGGERING_MEASUREMENTS.includes(option.measurement as Measurement));
      const fragment: Record<string, unknown> = { dataPoint: 'x_probe_field', kind: option.kind, measurement: option.measurement };
      if (option.source.type === 'selectable') {
        expect(dto.measurements[option.measurement].customSource.length).toBeGreaterThan(0);
        fragment.sourceUnit = dto.measurements[option.measurement].customSource[0].unit;
      } else if (option.source.type === 'fixed-authored') {
        expect(option.measurement).toBe('numeric');
        expect(option.source.unit).toBe('raw');
        fragment.sourceUnit = option.source.unit;
      } else if (option.source.type === 'fixed-implicit') {
        expect(option.measurement).toBe('timestamp');
        expect(option.source.unit).toBe('ms');
      } else {
        expect(option.measurement).toBe('boolean');
      }
      const map = buildEffectiveSensorMap({ userOverrides: [fragment], stations: [{ macAddress: MAC, name: 'Home' }], discovery: { schemaVersion: 1, entries: [] }, uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] }, configMode: 'v2', catalogBaseline: 1, catalogAdopted: 4 });
      expect(map.errors, option.id).toEqual([]);
      const row = map.rows.find(r => r.dataPoint === 'x_probe_field');
      expect(row).toMatchObject({ kind: option.kind, measurement: option.measurement });
      if (option.source.type === 'fixed-authored' || option.source.type === 'fixed-implicit') expect(row).toHaveProperty('sourceUnit', option.source.unit);
      if (option.measurement === 'boolean') {
        expect(option.output).toBe('native-state');
        expect(option.triggering).toBe(false);
        expect(option.inputHelp).toContain('Missing data retains');
        expect(option.state?.active).toBeTruthy();
      }
    }
    expect(dto.assignments.find(a => a.id === 'contact|boolean')).toMatchObject({ label: 'Contact', state: { normal: 'Closed', active: 'Open' } });
    expect(dto.assignments.find(a => a.id === 'motion|numeric')).toMatchObject({ label: 'Numeric value', output: 'extended-numeric' });
    expect(JSON.stringify(dto)).not.toMatch(/apiKey|applicationKey|structuralSignature|wrapperId/);
  });

  it('keeps an already-open legacy picker safe across a bridge upgrade, with the wrong-kind counterexample', async () => {
    // Frozen pre-P4 behavior: request has no marker, option values and dispatch
    // use measurement, and assignmentFor selects the FIRST matching pair.
    let bridge: () => LegacyVocabularyDto = legacyContract;
    const page = {
      options: [] as LegacyVocabularyDto['assignments'],
      async reconnect() { this.options = (await Promise.resolve(bridge())).assignments; },
      select(label: string) {
        const selected = this.options.find(a => a.label === label);
        return selected && this.options.find(a => a.measurement === selected.measurement)?.kind;
      },
    };
    await page.reconnect();
    expect(page.select('Contact')).toBeUndefined();
    bridge = () => negotiated(); // The unguarded all-pairs upgrade is wrong.
    await page.reconnect();
    expect(page.select('Contact')).toBe('leak');
    bridge = () => handleGetVocabulary(); // The real marker-free request stays safe.
    await page.reconnect();
    expect(page.select('Contact')).toBeUndefined();
    expect(page.options).toEqual(legacyContract().assignments);
  });

  it('timestamp help includes the date-string input already accepted by the real coercer', () => {
    const option = negotiated().assignments.find(a => a.id === 'motion|timestamp')!;
    const map = buildEffectiveSensorMap({
      userOverrides: [{ dataPoint: 'x_timestamp', kind: 'motion', measurement: 'timestamp' }],
      stations: [{ macAddress: MAC }], discovery: { schemaVersion: 1, entries: [] },
      uiState: { schemaVersion: 1, dismissedNoticeIds: [], forgottenFields: [] },
      configMode: 'v2', catalogBaseline: 1, catalogAdopted: 4,
    });
    expect(map.errors).toEqual([]);
    const row = map.rows.find(r => r.dataPoint === 'x_timestamp')!;
    const reported = '2026-04-21T22:19:00.000Z';
    expect(coerceValue(row, reported)).toBe(Date.parse(reported));
    expect(coerceValue(row, Date.parse(reported))).toBe(Date.parse(reported));
    expect(option.inputHelp).toMatch(/milliseconds/);
    expect(option.inputHelp).toMatch(/ISO|date strings?/i);
  });
});

describe('P4 full-map-only configuration transition', () => {
  const legacy = { platform: 'AmbientWeatherSensors', name: 'Weather', apiKey: 'test-secret', applicationKey: 'test-app-secret', humiditySensors: false };

  it.each([undefined, { catalogBaseline: 4, catalogAdopted: 4 }])('pure conversion projects the actual commit and preserves stamp presence %j', stamps => {
    return (async () => {
      const block = { ...legacy, ...stamps };
      const r = rig(block);
      const preview = await handlePreviewSave(r.deps, { base: block });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      const expected = stamps ? 4 : 1;
      expect(preview.configurationTransition).toEqual({ before: { mode: 'legacy', baseline: expected, adopted: expected, stamped: !!stamps }, after: { mode: 'v2', baseline: expected, adopted: expected, stamped: true } });
      expect(JSON.stringify(preview)).not.toContain('test-secret');
      const validated = await handleComposeSave(r.deps, { base: block, confirmDigest: preview.digest });
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const committed = await handleCommitSave(r.deps, { base: block, confirmDigest: preview.digest, validationToken: validated.validationToken });
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.nextConfig).toMatchObject({ configVersion: 2, catalogBaseline: expected, catalogAdopted: expected, humiditySensors: false });
    })();
  });

  it('excludes a catalog confirmation from fresh and existing settings-only previews', async () => {
    const fresh = rig();
    const created = await handlePreviewSave(fresh.deps, { baseDigest: FRESH_INSTALL_DIGEST, proposal: [], settings: { name: 'First Weather', apiKey: { set: 'secret' } } });
    expect(created.ok).toBe(true);
    expect(created).not.toHaveProperty('configurationTransition');
    const block = { ...legacy, configVersion: 2, sensorMap: [], catalogBaseline: 1, catalogAdopted: 3 };
    const existing = rig(block);
    const edited = await handlePreviewSave(existing.deps, { base: block, proposal: [], settings: { apiKey: { set: 'replacement-secret' } } });
    expect(edited.ok).toBe(true);
    expect(edited).not.toHaveProperty('configurationTransition');
    expect(edited).toHaveProperty('settingsChanged', ['apiKey']);
  });

  it.each([
    { kind: 'contact', measurement: 'boolean', adopted: 1 },
    { kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', adopted: 3 },
  ])('preserves a dormant %j assignment through explicit adoption and both orchestrator phases', async ({ adopted, ...identity }) => {
    const proposal = [{ dataPoint: 'x_probe_field', ...identity }];
    const block = { ...legacy, configVersion: 2, sensorMap: proposal, catalogBaseline: 1, catalogAdopted: adopted };
    const r = rig(block);
    const state = await handleGetEditorState(r.deps, {});
    expect(state.errors.some(e => e.code === 'no-wrapper')).toBe(true);
    const beforeBytes = readFileSync(r.configPath, 'utf8');
    const files = readdirSync(r.persistDir);
    const refused = await handlePreviewSave(r.deps, { base: block, proposal });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-rows' } });
    expect(readFileSync(r.configPath, 'utf8')).toBe(beforeBytes);
    expect(readdirSync(r.persistDir)).toEqual(files);
    const preview = await handlePreviewSave(r.deps, { base: block, proposal, adoptCatalogVersion: 4 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.configurationTransition).toMatchObject({ before: { adopted }, after: { adopted: 4 } });
    expect(preview.changes.some(c => c.dataPoint === 'x_probe_field' && c.change === 'added')).toBe(true);
    let session: Record<string, unknown>[] = [block];
    const requests: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const deps: OrchestratorDeps = {
      request: async (endpoint, payload) => {
        requests.push({ endpoint, payload: payload as Record<string, unknown> });
        return endpoint === '/compose-save' ? handleComposeSave(r.deps, payload) : handleCommitSave(r.deps, payload);
      },
      getPluginConfig: async () => session,
      updatePluginConfig: async next => { session = next; },
      savePluginConfig: async () => { writeFileSync(r.configPath, JSON.stringify({ platforms: session })); },
      freezeSettingsForm: () => {}, unfreezeSettingsForm: () => {},
    };
    const saved = await composeAndPersist(deps, { base: block, proposal, adoptCatalogVersion: 4, confirmDigest: preview.digest });
    expect(saved.ok).toBe(true);
    expect(requests.map(r => r.endpoint)).toEqual(['/compose-save', '/commit-save']);
    expect(requests.every(r => r.payload.adoptCatalogVersion === 4)).toBe(true);
    expect(session[0]).toMatchObject({ catalogBaseline: 1, catalogAdopted: 4 });
    expect((session[0].sensorMap as Record<string, unknown>[]).find(r => r.dataPoint === 'x_probe_field')).toMatchObject(identity);
  });

  it('requires raw for numeric and still refuses a forged unadopted assignment without durable records', async () => {
    const block = { ...legacy, configVersion: 2, sensorMap: [], catalogBaseline: 1, catalogAdopted: 3 };
    const r = rig(block);
    const bytes = readFileSync(r.configPath, 'utf8');
    const files = readdirSync(r.persistDir);
    const row = { dataPoint: 'x_probe_field', kind: 'motion', measurement: 'numeric' };
    for (const payload of [
      { base: block, proposal: [row], adoptCatalogVersion: 4 },
      { base: block, proposal: [{ ...row, sourceUnit: 'raw' }] },
    ]) {
      expect(await handlePreviewSave(r.deps, payload)).toMatchObject({ ok: false, error: { code: 'invalid-rows' } });
      expect(await handleComposeSave(r.deps, payload)).toMatchObject({ ok: false, error: { code: 'invalid-rows' } });
    }
    expect(readFileSync(r.configPath, 'utf8')).toBe(bytes);
    expect(readdirSync(r.persistDir)).toEqual(files);
  });
});

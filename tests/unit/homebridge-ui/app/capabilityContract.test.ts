import { describe, expect, it } from 'vitest';
import { handleGetVocabulary } from '../../../../homebridge-ui/handlers.js';
import { isCapabilityVocabulary, sourceSelectionValid } from '../../../../homebridge-ui/app-src/capability-contract';
import type { VocabularyDto } from '../../../../homebridge-ui/app-src/dto/editor-state';

const wire = (): VocabularyDto => structuredClone(handleGetVocabulary({ vocabularyProtocol: 2 })) as VocabularyDto;
// Start from a valid wire DTO, then corrupt one field as an untrusted response
// could. These accessors loosen only the mutation boundary, not production types.
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const entries = (value: unknown): unknown[] => value as unknown[];
const assignment = (v: Record<string, unknown>, id?: string): Record<string, unknown> => record(
  id === undefined ? entries(v.assignments)[0]
    : entries(v.assignments).find(a => record(a).id === id),
);
const family = (v: Record<string, unknown>): Record<string, unknown> => record(entries(v.families)[0]);

describe('pair-aware vocabulary consumer boundary', () => {
  it('accepts the real compiled protocol-2 projection without a second metadata table', () => {
    expect(isCapabilityVocabulary(wire())).toBe(true);
  });

  it('rejects an old bridge response even when the new client requested protocol 2', () => {
    expect(isCapabilityVocabulary(handleGetVocabulary())).toBe(false);
  });

  const malformed: Array<[string, (v: Record<string, unknown>) => void]> = [
    ['missing version', v => { delete v.vocabularyProtocol; }],
    ['unknown version', v => { v.vocabularyProtocol = 3; }],
    ['missing introduction version', v => { delete assignment(v).since; }],
    ['fractional introduction version', v => { assignment(v).since = 1.5; }],
    ['duplicate pair', v => { entries(v.assignments).push(assignment(v)); }],
    ['mismatched pair identity', v => { assignment(v).id = 'leak|boolean'; }],
    ['source policy missing', v => { delete assignment(v).source; }],
    ['unknown source policy', v => { assignment(v).source = { type: 'guess' }; }],
    ['raw carrier renamed', v => { record(assignment(v, 'motion|numeric').source).unit = 'ppm'; }],
    ['state encoding missing', v => { delete assignment(v, 'contact|boolean').state; }],
    ['unit option malformed', v => { record(record(v.measurements).temperature).customSource = [null]; }],
    ['display option malformed', v => { record(record(v.measurements)['wind-speed']).extendedDisplay = [null]; }],
    ['family malformed', v => { v.families = [null]; }],
    ['family measurements missing', v => { delete family(v).measurements; }],
    ['family choice malformed', v => { family(v).choices = [null]; }],
    ['family unit mapping malformed', v => { record(entries(family(v).choices)[0]).units = null; }],
  ];
  it.each(malformed)('fails closed on %s before rendering controls', (_name, mutate) => {
    const v = wire();
    mutate(record(v));
    expect(isCapabilityVocabulary(v)).toBe(false);
  });

  it('requires a legal physical source while fixed raw, timestamp and boolean policies omit a select', () => {
    const v = wire();
    const wind = v.assignments.find(a => a.id === 'motion|wind-speed')!;
    expect(sourceSelectionValid(wind, '', v)).toBe(false);
    expect(sourceSelectionValid(wind, 'celsius', v)).toBe(false);
    expect(sourceSelectionValid(wind, 'mph', v)).toBe(true);
    for (const id of ['motion|numeric', 'motion|timestamp', 'contact|boolean']) {
      expect(sourceSelectionValid(v.assignments.find(a => a.id === id)!, '', v)).toBe(true);
    }
  });
});

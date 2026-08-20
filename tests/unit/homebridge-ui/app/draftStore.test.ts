/**
 * DraftStore (#69 PR B) — the client-side draft state. Pure TS, no
 * Angular: patches over authored fragments, §3.3.2 last-fragment
 * targeting, override removal, and faithful proposal reconstruction
 * (invalid identities included).
 */
import { describe, expect, it } from 'vitest';

import { DraftStore, rowDraftKey } from '../../../../homebridge-ui/app-src/draft-store';
import type { EditorAuthoredFragmentDto, EditorRowDto } from '../../../../homebridge-ui/app-src/dto/editor-state';

const MAC = 'AA:BB:CC:DD:EE:01';

function row(partial: Partial<EditorRowDto> & { dataPoint: string; origin: EditorRowDto['origin'] }): EditorRowDto {
  return {
    stationMac: MAC, kind: 'temperature', measurement: 'temperature',
    name: 'Row', enabled: true, batteryField: null, ...partial,
  };
}

function frag(partial: Partial<EditorAuthoredFragmentDto> & { index: number }): EditorAuthoredFragmentDto {
  return { layer: 'global', fields: {}, ...partial };
}

describe('draft targeting', () => {
  it('edits target the layer that authored the row', () => {
    expect(rowDraftKey(row({ dataPoint: 'tempf', origin: 'global' }))).toBe('*|tempf');
    expect(rowDraftKey(row({ dataPoint: 'tempf', origin: 'station' }))).toBe(`${MAC}|tempf`);
    // Default rows draft a NEW station-scoped fragment (PR B does not
    // author global templates from the UI).
    expect(rowDraftKey(row({ dataPoint: 'tempf', origin: 'default' }))).toBe(`${MAC}|tempf`);
  });

  it('patches land on the LAST fragment of a key (later-field-wins)', () => {
    const store = new DraftStore();
    store.reset([
      frag({ index: 0, dataPoint: 'tempf', fields: { name: 'First' } }),
      frag({ index: 1, dataPoint: 'tempf', fields: { enabled: true } }),
    ]);
    store.setField(row({ dataPoint: 'tempf', origin: 'global' }), 'name', 'Patched');
    const proposal = store.proposal();
    expect(proposal).toHaveLength(2);
    expect(proposal[0]).toEqual({ dataPoint: 'tempf', name: 'First' });
    expect(proposal[1]).toEqual({ dataPoint: 'tempf', enabled: true, name: 'Patched' });
  });
});

describe('dirty tracking', () => {
  it('drafting a value back to the authored value un-drafts the field', () => {
    const store = new DraftStore();
    store.reset([frag({ index: 0, dataPoint: 'tempf', fields: { name: 'Authored' } })]);
    const r = row({ dataPoint: 'tempf', origin: 'global', name: 'Authored' });
    store.setField(r, 'name', 'Changed');
    expect(store.dirty).toBe(true);
    store.setField(r, 'name', 'Authored');
    expect(store.dirty).toBe(false);
    expect(store.proposal()).toEqual([{ dataPoint: 'tempf', name: 'Authored' }]);
  });

  it('clearField withdraws a single drafted field without touching others', () => {
    const store = new DraftStore();
    store.reset([]);
    const r = row({ dataPoint: 'tempf', origin: 'default' });
    store.setField(r, 'enabled', false);
    store.setField(r, 'name', 'X');
    store.clearField(r, 'enabled');
    expect(store.draftedValue(r, 'enabled')).toBeUndefined();
    expect(store.draftedValue(r, 'name')).toBe('X');
    store.clearField(r, 'name');
    expect(store.dirty).toBe(false);
  });

  it('clearField never resurrects a remove-override draft', () => {
    const store = new DraftStore();
    store.reset([frag({ index: 0, dataPoint: 'uv', fields: { enabled: false } })]);
    const r = row({ dataPoint: 'uv', origin: 'global' });
    store.removeOverride(r);
    store.clearField(r, 'enabled');
    expect(store.draftCount).toBe(1); // the removal stands
    expect(store.proposal()).toEqual([]);
  });

  it('prune sees values authored by EARLIER fragments (field-wise later-wins, review #43 P1-3)', () => {
    const store = new DraftStore();
    // Two fragments, same key: the FIRST authors name, the SECOND
    // only enabled. A last-fragment-only baseline would miss 'X'.
    store.reset([
      frag({ index: 0, dataPoint: 'tempf', fields: { name: 'X' } }),
      frag({ index: 1, dataPoint: 'tempf', fields: { enabled: false } }),
    ]);
    const r = row({ dataPoint: 'tempf', origin: 'global', name: 'X' });
    store.setField(r, 'name', 'X'); // equals the field-wise authored value
    expect(store.dirty).toBe(false);
  });

  it('discardAll and resetRow clear drafts', () => {
    const store = new DraftStore();
    store.reset([]);
    const r = row({ dataPoint: 'tempf', origin: 'default' });
    store.setField(r, 'enabled', false);
    expect(store.isRowDirty(r)).toBe(true);
    store.resetRow(r);
    expect(store.dirty).toBe(false);
    store.setField(r, 'enabled', false);
    store.discardAll();
    expect(store.dirty).toBe(false);
  });
});

describe('proposal reconstruction', () => {
  it('is verbatim for untouched fragments, including invalid identities', () => {
    const store = new DraftStore();
    store.reset([
      frag({ index: 0, layer: 'invalid', identityRaw: { stationMac: 42 }, dataPoint: 'tempf', fields: { enabled: false } }),
      frag({ index: 1, identityRaw: { dataPoint: null }, fields: { threshold: 'oops' } }),
      frag({ index: 2, layer: 'station', stationMac: 'aa:bb:cc:dd:ee:01', stationMacKey: MAC, dataPoint: 'uv', fields: { batteryField: null } }),
    ]);
    expect(store.proposal()).toEqual([
      { dataPoint: 'tempf', stationMac: 42, enabled: false },
      { dataPoint: null, threshold: 'oops' },
      { dataPoint: 'uv', stationMac: 'aa:bb:cc:dd:ee:01', batteryField: null },
    ]);
  });

  it('removeOverride drops every fragment of the key; new drafts append', () => {
    const store = new DraftStore();
    store.reset([
      frag({ index: 0, dataPoint: 'uv', fields: { enabled: false } }),
      frag({ index: 1, dataPoint: 'uv', fields: { name: 'UV' } }),
    ]);
    store.removeOverride(row({ dataPoint: 'uv', origin: 'global' }));
    store.setField(row({ dataPoint: 'tempf', origin: 'default' }), 'name', 'Patio');
    expect(store.proposal()).toEqual([
      { dataPoint: 'tempf', stationMac: MAC, name: 'Patio' },
    ]);
    expect(store.draftCount).toBe(2);
  });

  it('reset() from a fresh editor-state clears drafts', () => {
    const store = new DraftStore();
    store.reset([]);
    store.setField(row({ dataPoint: 'tempf', origin: 'default' }), 'enabled', false);
    store.reset([]);
    expect(store.dirty).toBe(false);
    expect(store.proposal()).toEqual([]);
  });
});

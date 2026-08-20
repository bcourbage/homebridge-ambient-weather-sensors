/**
 * Client-side draft state for the sensor-map editor (GA task #69,
 * PR B). Holds the user's UNSAVED edits as patches over the authored
 * fragments served by /editor-state, and reconstructs the proposal
 * array for /preview-save.
 *
 * The store deliberately knows NOTHING about resolver semantics — no
 * merging, no validation, no defaults (design decision 2026-08-19:
 * the browser never reconstructs the effective map). It relies on
 * exactly one documented ordering guarantee: §3.3.2 merges fragments
 * for the same (stationMac?, dataPoint) key with later-field-wins, so
 * a field set on the LAST fragment of a key is the value that takes
 * effect. Everything else (validity, effective rows, structural
 * consequences) comes back from the server via /preview-save.
 *
 * PR B scope: field edits on existing rows, new station-scoped
 * fragments for rows with no override, and override removal. Kind /
 * measurement editing and unrecognized-field assignment arrive with
 * a later PR.
 */
import type { EditorAuthoredFragmentDto, EditorRowDto } from './dto/editor-state';

/** The fields the PR B editor can draft. */
export type DraftableField =
  | 'enabled' | 'name' | 'displayUnit' | 'threshold' | 'triggerEnabled' | 'triggerDirection';

/** Draft key: global fragments under '*', station fragments under the MAC key. */
function keyFor(scope: string | undefined, dataPoint: string): string {
  return `${scope ?? '*'}|${dataPoint}`;
}

/** The draft key a ROW's edits target, derived from its resolved origin. */
export function rowDraftKey(row: EditorRowDto): string {
  // Rows authored by a global template edit the template; everything
  // else (station exceptions, defaults) edits a station-scoped
  // fragment for THIS station. PR B does not author new global
  // templates from the UI.
  return row.origin === 'global' ? keyFor(undefined, row.dataPoint) : keyFor(row.stationMac, row.dataPoint);
}

interface DraftEntry {
  /** Field patches to apply (undefined value = not drafted). */
  patches: Map<DraftableField, unknown>;
  /** Remove every authored fragment for this key. */
  remove: boolean;
}

export class DraftStore {
  private authored: EditorAuthoredFragmentDto[] = [];
  private drafts = new Map<string, DraftEntry>();

  /** (Re)initialize from a fresh /editor-state response. Clears drafts. */
  reset(authored: EditorAuthoredFragmentDto[]): void {
    this.authored = authored;
    this.drafts.clear();
  }

  private entry(key: string): DraftEntry {
    let e = this.drafts.get(key);
    if (!e) {
      e = { patches: new Map(), remove: false };
      this.drafts.set(key, e);
    }
    return e;
  }

  /** Draft a field value for the fragment a row's edits target. */
  setField(row: EditorRowDto, field: DraftableField, value: unknown): void {
    const key = rowDraftKey(row);
    const e = this.entry(key);
    e.remove = false;
    e.patches.set(field, value);
    this.prune(key);
  }

  /**
   * Withdraw a drafted field (review #43 P1-3): the form syncs EVERY
   * field on every event — a value typed back to the original clears
   * its patch instead of leaving a stale draft behind the equal-
   * looking control.
   */
  clearField(row: EditorRowDto, field: DraftableField): void {
    const key = rowDraftKey(row);
    const e = this.drafts.get(key);
    if (!e || e.remove) {
      return; // never resurrect a remove-override draft
    }
    e.patches.delete(field);
    if (e.patches.size === 0) {
      this.drafts.delete(key);
    }
  }

  /**
   * The authored value of a field at a key: FIELD-WISE later-wins
   * across every fragment of the key (§3.3.2 merge order — review #43
   * P1-3: a value authored by an EARLIER fragment and untouched by
   * later ones is still the authored value).
   */
  private authoredBaseline(key: string): { [k: string]: unknown } {
    const baseline: { [k: string]: unknown } = {};
    for (const f of this.authored) {
      if (this.fragmentKey(f) === key) {
        Object.assign(baseline, f.fields);
      }
    }
    return baseline;
  }

  /**
   * Drop patches that equal what the authored fragments already say —
   * typing a value back to its authored state un-drafts the field.
   * (No comparison against resolver DEFAULTS: for a row with no
   * authored fragment, any patch is a real draft.)
   */
  private prune(key: string): void {
    const e = this.drafts.get(key);
    if (!e || e.remove) {
      return;
    }
    const baseline = this.authoredBaseline(key);
    for (const [field, value] of [...e.patches]) {
      if (field in baseline && baseline[field] === value) {
        e.patches.delete(field);
      }
    }
    if (e.patches.size === 0 && !e.remove) {
      this.drafts.delete(key);
    }
  }

  /** Remove the override a row's configuration comes from (§9.4). */
  removeOverride(row: EditorRowDto): void {
    if (row.origin !== 'global' && row.origin !== 'station') {
      return; // defaults have no override to remove
    }
    const key = row.origin === 'global'
      ? keyFor(undefined, row.dataPoint)
      : keyFor(row.stationMac, row.dataPoint);
    const e = this.entry(key);
    e.patches.clear();
    e.remove = true;
  }

  /** Discard the draft for one row. */
  resetRow(row: EditorRowDto): void {
    this.drafts.delete(rowDraftKey(row));
    // A remove-override draft may sit under the row's ORIGIN key.
    if (row.origin === 'global') {
      this.drafts.delete(keyFor(undefined, row.dataPoint));
    }
  }

  /** Discard everything. */
  discardAll(): void {
    this.drafts.clear();
  }

  /** True when the draft would change anything. */
  get dirty(): boolean {
    return this.draftCount > 0;
  }

  /** Number of keys with live drafts. */
  get draftCount(): number {
    let n = 0;
    for (const e of this.drafts.values()) {
      if (e.remove || e.patches.size > 0) {
        n++;
      }
    }
    return n;
  }

  /** Does this row have draft edits? */
  isRowDirty(row: EditorRowDto): boolean {
    const e = this.drafts.get(rowDraftKey(row));
    return !!e && (e.remove || e.patches.size > 0);
  }

  /** The drafted value for a field, or undefined when not drafted. */
  draftedValue(row: EditorRowDto, field: DraftableField): unknown {
    return this.drafts.get(rowDraftKey(row))?.patches.get(field);
  }

  private fragmentKey(f: EditorAuthoredFragmentDto): string | undefined {
    if (f.dataPoint === undefined) {
      return undefined; // invalid-identity fragment: passes through verbatim
    }
    return keyFor(f.layer === 'station' ? f.stationMacKey : undefined, f.dataPoint);
  }

  /**
   * Reconstruct one authored fragment as a proposal entry, verbatim:
   * hoisted identity or the preserved invalid identity, plus the
   * authored fields (wrong types included). Keys outside the known
   * override vocabulary were withheld by the server and are dropped —
   * the same thing canonical serialization does on save.
   */
  private toProposalFragment(f: EditorAuthoredFragmentDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (f.dataPoint !== undefined) {
      out.dataPoint = f.dataPoint;
    } else if (f.identityRaw && 'dataPoint' in f.identityRaw) {
      out.dataPoint = f.identityRaw.dataPoint;
    }
    if (f.stationMac !== undefined) {
      out.stationMac = f.stationMac;
    } else if (f.identityRaw && 'stationMac' in f.identityRaw) {
      out.stationMac = f.identityRaw.stationMac;
    }
    for (const [k, v] of Object.entries(f.fields)) {
      out[k] = v;
    }
    return out;
  }

  /**
   * The proposal array for /preview-save: authored fragments in their
   * original order with draft patches applied (on the LAST fragment
   * of each key — later-field-wins makes that value take effect),
   * removed keys dropped, and new fragments appended for keys with no
   * authored fragment.
   */
  proposal(): Record<string, unknown>[] {
    // Last authored index per key, so patches land where they win.
    const lastIndexForKey = new Map<string, number>();
    this.authored.forEach((f, i) => {
      const key = this.fragmentKey(f);
      if (key !== undefined) {
        lastIndexForKey.set(key, i);
      }
    });

    const out: Record<string, unknown>[] = [];
    this.authored.forEach((f, i) => {
      const key = this.fragmentKey(f);
      const draft = key !== undefined ? this.drafts.get(key) : undefined;
      if (draft?.remove) {
        return; // drop every fragment of a removed key
      }
      const frag = this.toProposalFragment(f);
      if (draft && lastIndexForKey.get(key!) === i) {
        for (const [field, value] of draft.patches) {
          frag[field] = value;
        }
      }
      out.push(frag);
    });

    // New fragments: drafted keys with no authored fragment.
    for (const [key, draft] of this.drafts) {
      if (draft.remove || draft.patches.size === 0 || lastIndexForKey.has(key)) {
        continue;
      }
      const [scope, dataPoint] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      const frag: Record<string, unknown> = { dataPoint };
      if (scope !== '*') {
        frag.stationMac = scope;
      }
      for (const [field, value] of draft.patches) {
        frag[field] = value;
      }
      out.push(frag);
    }
    return out;
  }
}

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
  /**
   * Remove every authored fragment for this key. NOT mutually
   * exclusive with `patches` (PR #53 review F3): patches drafted
   * after a removal describe a MINIMAL REPLACEMENT fragment — the
   * authored fragments stay dropped, and only the patched fields are
   * re-authored. A patch must never resurrect the removed fragment's
   * unrelated fields.
   */
  remove: boolean;
  /**
   * Delete these fields from every authored fragment of this key
   * (PR #53 review F1: a family unit choice strips displayUnit from
   * station exceptions so the global template governs).
   */
  fieldRemovals: Set<DraftableField>;
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
      e = { patches: new Map(), remove: false, fieldRemovals: new Set() };
      this.drafts.set(key, e);
    }
    return e;
  }

  /** Draft a field value for the fragment a row's edits target. */
  setField(row: EditorRowDto, field: DraftableField, value: unknown): void {
    this.setFieldAt(rowDraftKey(row), field, value);
  }

  /**
   * Draft a field value at an explicit key: `stationMac` undefined
   * targets the GLOBAL template for the dataPoint — the family unit
   * action authors global fragments this way regardless of any row's
   * resolved origin (PR #53 review F1).
   *
   * On a key drafted for removal, the removal STANDS and the patch
   * describes the minimal replacement fragment (review F3) — setting
   * a field never resurrects the removed fragment's other fields.
   */
  setFieldFor(stationMac: string | undefined, dataPoint: string, field: DraftableField, value: unknown): void {
    this.setFieldAt(keyFor(stationMac, dataPoint), field, value);
  }

  private setFieldAt(key: string, field: DraftableField, value: unknown): void {
    const e = this.entry(key);
    e.fieldRemovals.delete(field); // a patch and a removal are exclusive per field
    e.patches.set(field, value);
    this.prune(key);
  }

  /**
   * Draft the DELETION of one field from every authored fragment of
   * a station-scoped key (review F1: a family choice strips
   * displayUnit from station exceptions so the global template
   * governs current and future stations alike). A removal of a field
   * the authored fragments never set is a no-op.
   */
  removeFieldFor(stationMac: string, dataPoint: string, field: DraftableField): void {
    const key = keyFor(stationMac, dataPoint);
    if (!(field in this.authoredBaseline(key))) {
      return;
    }
    const e = this.entry(key);
    if (e.remove) {
      return; // the whole fragment is already being removed
    }
    e.patches.delete(field);
    e.fieldRemovals.add(field);
    this.prune(key);
  }

  /**
   * Withdraw a drafted field (review #43 P1-3): the form syncs EVERY
   * field on every event — a value typed back to the original clears
   * its patch instead of leaving a stale draft behind the equal-
   * looking control. On a removal draft this clears only the field's
   * patch (shrinking the minimal replacement), never the removal.
   */
  clearField(row: EditorRowDto, field: DraftableField): void {
    const key = rowDraftKey(row);
    const e = this.drafts.get(key);
    if (!e) {
      return;
    }
    e.patches.delete(field);
    this.dropIfEmpty(key);
  }

  private dropIfEmpty(key: string): void {
    const e = this.drafts.get(key);
    if (e && !e.remove && e.patches.size === 0 && e.fieldRemovals.size === 0) {
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
      // No baseline pruning under a removal: the authored fragments
      // are dropped, so a replacement field equal to what they said
      // is still a REAL field of the minimal replacement.
      return;
    }
    const baseline = this.authoredBaseline(key);
    for (const [field, value] of [...e.patches]) {
      if (field in baseline && baseline[field] === value) {
        e.patches.delete(field);
      }
    }
    this.dropIfEmpty(key);
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
    e.fieldRemovals.clear();
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
      if (e.remove || e.patches.size > 0 || e.fieldRemovals.size > 0) {
        n++;
      }
    }
    return n;
  }

  /** Does this row have draft edits? */
  isRowDirty(row: EditorRowDto): boolean {
    const e = this.drafts.get(rowDraftKey(row));
    return !!e && (e.remove || e.patches.size > 0 || e.fieldRemovals.size > 0);
  }

  /** The drafted value for a field, or undefined when not drafted. */
  draftedValue(row: EditorRowDto, field: DraftableField): unknown {
    return this.drafts.get(rowDraftKey(row))?.patches.get(field);
  }

  /** The drafted value at an explicit key, or undefined. */
  draftedValueFor(stationMac: string | undefined, dataPoint: string, field: DraftableField): unknown {
    return this.drafts.get(keyFor(stationMac, dataPoint))?.patches.get(field);
  }

  /** Withdraw a drafted field at an explicit key (removals stand). */
  clearFieldFor(stationMac: string | undefined, dataPoint: string, field: DraftableField): void {
    const key = keyFor(stationMac, dataPoint);
    const e = this.drafts.get(key);
    if (!e) {
      return;
    }
    e.patches.delete(field);
    this.dropIfEmpty(key);
  }

  /** Is this field drafted for deletion at the station-scoped key? */
  fieldRemovedFor(stationMac: string, dataPoint: string, field: DraftableField): boolean {
    return this.drafts.get(keyFor(stationMac, dataPoint))?.fieldRemovals.has(field) ?? false;
  }

  /** Is the whole key drafted for removal? */
  keyRemovedFor(stationMac: string | undefined, dataPoint: string): boolean {
    return this.drafts.get(keyFor(stationMac, dataPoint))?.remove ?? false;
  }

  /**
   * The station macs whose authored fragments set `field` for this
   * dataPoint — the exceptions a family choice must strip (review F1).
   */
  stationsAuthoringField(dataPoint: string, field: DraftableField): string[] {
    const macs = new Set<string>();
    for (const f of this.authored) {
      if (f.dataPoint === dataPoint && f.layer === 'station'
        && f.stationMacKey !== undefined && field in f.fields) {
        macs.add(f.stationMacKey);
      }
    }
    return [...macs];
  }

  /**
   * The authored value of a field at an explicit key, or undefined.
   * Accepts any authored field name (not just draftable ones): the
   * family action reads identity fields (kind, measurement) to decide
   * whether a station fragment survives a global-template removal.
   */
  authoredValueFor(stationMac: string | undefined, dataPoint: string, field: string): unknown {
    return this.authoredBaseline(keyFor(stationMac, dataPoint))[field];
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
      if (draft) {
        // Field removals strip EVERY fragment of the key: with
        // later-field-wins, the field could take effect from any of
        // them (review F1).
        for (const field of draft.fieldRemovals) {
          delete frag[field];
        }
        if (lastIndexForKey.get(key!) === i) {
          for (const [field, value] of draft.patches) {
            frag[field] = value;
          }
        }
        // A fragment reduced to bare identity sets nothing — drop it
        // rather than authoring noise.
        if (Object.keys(frag).every(k => k === 'dataPoint' || k === 'stationMac')) {
          return;
        }
      }
      out.push(frag);
    });

    // New fragments: drafted keys whose patches have no authored
    // fragment to land on — never authored, or authored but drafted
    // for removal (the patches then form the MINIMAL REPLACEMENT of
    // review F3: the removed fragment's other fields stay gone).
    for (const [key, draft] of this.drafts) {
      const patchesNeedNewFragment = draft.patches.size > 0
        && (!lastIndexForKey.has(key) || draft.remove);
      if (!patchesNeedNewFragment) {
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

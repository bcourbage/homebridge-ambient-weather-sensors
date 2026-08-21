/**
 * Sensor-map editor, draft stage (GA task #69, PR B). Renders the
 * /editor-state read model grouped by station, lets the user DRAFT
 * row edits (enable/disable, rename, display unit, thresholds,
 * remove-override), and dry-runs drafts through the server's
 * /preview-save — the exact save pipeline with zero writes.
 *
 * PERSISTENCE (PR C / finding 5): saving runs EXCLUSIVELY through
 * composeAndPersist — /compose-save validates against the on-disk
 * config, verifies the structural confirmation digest, writes the
 * legacy snapshot FIRST, and only then does the returned config reach
 * updatePluginConfig/savePluginConfig, verbatim. Structural saves
 * demand explicit confirmation in a modal; every refusal produces
 * zero config writes.
 *
 * Styling deliberately leans on the fragment page's #awn scope: this
 * component renders inside <div id="awn">, so the page's table rules
 * and theme variables (light + dark) apply to it as-is. Component
 * styles below add only what the page doesn't define.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { DraftStore } from './draft-store';
import { HomebridgeService } from './homebridge.service';
import { composeAndPersist } from '../saveOrchestrator';
import type {
  EditorRowDto,
  EditorStateDto,
  PreviewResultDto,
  UnitOptionDto,
  VocabularyDto,
} from './dto/editor-state';

interface StationGroup {
  mac: string;
  title: string;
  source: string;
  rows: EditorRowDto[];
}

@Component({
  selector: 'awn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  styles: `
    h3 { font-size: 0.95rem; margin: 16px 0 4px 0; }
    .origin {
      display: inline-block; padding: 1px 7px; border-radius: 999px;
      font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em;
      background: var(--code-bg); color: var(--fg-sub);
    }
    .origin.station { background: var(--info-bg); color: var(--info-fg); }
    .origin.global  { background: var(--on-bg);   color: var(--on-fg); }
    .origin.unrecognized { background: var(--warn-bg); color: var(--warn-fg); }
    .station-meta { color: var(--fg-sub); font-size: 0.85rem; font-weight: 400; margin-left: 8px; }
    .muted { color: var(--fg-empty); }
    .field-error { color: var(--error-fg); background: var(--error-bg); padding: 2px 8px; border-radius: 4px; font-size: 0.82rem; margin-right: 12px; }
    .dirty-dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 999px;
      background: var(--warn-edge); margin-right: 6px;
    }
    .draft-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; border-radius: 6px; margin: 12px 0;
      background: var(--panel-bg); border: 1px solid var(--rule);
    }
    .draft-bar .grow { flex: 1; }
    .editor-form {
      background: var(--panel-bg); border-top: 2px solid var(--rule);
      padding: 10px 14px;
    }
    .editor-form label { display: inline-flex; align-items: center; gap: 6px; margin: 4px 16px 4px 0; font-size: 0.88rem; }
    .editor-form input[type="text"], .editor-form input[type="number"], .editor-form select {
      background: var(--btn-bg); color: var(--btn-fg);
      border: 1px solid var(--btn-edge); border-radius: 4px; padding: 4px 8px;
    }
    .change-kind {
      display: inline-block; min-width: 64px; text-align: center;
      padding: 1px 7px; border-radius: 999px; font-size: 0.72rem; font-weight: 600;
    }
    .change-kind.added    { background: var(--on-bg);    color: var(--on-fg); }
    .change-kind.removed  { background: var(--off-bg);   color: var(--off-fg); }
    .change-kind.modified { background: var(--info-bg);  color: var(--info-fg); }
    .structural-chip {
      display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 999px;
      font-size: 0.72rem; font-weight: 600;
      background: var(--warn-bg); color: var(--warn-fg);
    }
    .change-row { padding: 4px 0; border-bottom: 1px solid var(--row-rule); font-size: 0.88rem; }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
      display: flex; align-items: center; justify-content: center; z-index: 1000;
    }
    .modal {
      background: var(--panel-bg); color: var(--fg);
      border: 1px solid var(--rule); border-radius: 8px;
      padding: 16px 20px; max-width: 560px; width: 90%;
      max-height: 70vh; overflow-y: auto;
    }
  `,
  template: `
    <h2>Sensor map <span class="station-meta">draft editor preview</span></h2>
    @if (!available) {
      <div class="banner">
        This page is running outside Homebridge UI X, so the sensor map
        cannot be loaded.
      </div>
    } @else if (loadError()) {
      <div class="banner safe-mode">Failed to load the sensor map: {{ loadError() }}</div>
    } @else if (!state()) {
      <p class="empty">Loading sensor map…</p>
    } @else {
      @for (w of state()!.warnings; track $index) {
        <div class="banner">{{ w.message }}</div>
      }
      @for (e of state()!.errors; track $index) {
        <div class="banner safe-mode">{{ e.message }}</div>
      }
      @if (state()!.notes.length > 0) {
        <h3>Notes</h3>
        @for (n of state()!.notes; track $index) {
          <div class="banner info">{{ n.message }}</div>
        }
      }

      @if (draftCount() > 0) {
        <div class="draft-bar">
          <span class="grow"><strong>{{ draftCount() }}</strong> draft change(s) — nothing is saved; preview runs the real save pipeline without writing.</span>
          <button type="button" (click)="preview()" [disabled]="previewPending() || editFormInvalid()">Preview changes</button>
          <button type="button" (click)="discardAll()">Discard drafts</button>
        </div>
      }

      @if (previewPending()) {
        <p class="empty">Previewing…</p>
      }
      @if (previewResult(); as pr) {
        @if (pr.ok) {
          <h3>Preview</h3>
          @if (pr.changes.length === 0) {
            <div class="banner info">No accessory changes: nothing registers, deregisters, or updates. (Edits to disabled rows still save and take effect when the row is enabled.)</div>
          } @else {
            @for (c of pr.changes; track $index) {
              <div class="change-row">
                <span class="change-kind {{ c.change }}">{{ c.change }}</span>
                @if (c.structural) {
                  <span class="structural-chip">{{ structuralVerb(c.change) }}</span>
                }
                <code>{{ c.dataPoint }}</code>
                <span class="station-meta">{{ c.stationMac }}</span>
                @if (c.change === 'modified') {
                  <span class="muted"> {{ changeSummary(c.before!, c.after!) }}</span>
                }
              </div>
            }
            @if (pr.structuralChangeCount > 0) {
              <div class="banner">
                {{ pr.structuralChangeCount }} accessor{{ pr.structuralChangeCount === 1 ? 'y' : 'ies' }} would register, deregister, or re-register on save
                (a re-registered accessory may need its HomeKit room assignment redone; a deregistered one leaves HomeKit).
                Saving from this editor arrives in a later beta; this preview wrote nothing.
              </div>
            } @else {
              <div class="banner info">All changes apply in place; no accessory registers, deregisters, or re-registers. Saving from this editor arrives in a later beta; this preview wrote nothing.</div>
            }
          }
          @for (w of pr.warnings; track $index) {
            <div class="banner">{{ w.message }}</div>
          }
          @if (pr.notes.length > 0) {
            <h3>Preview notes</h3>
            @for (n of pr.notes; track $index) {
              <div class="banner info">{{ n.message }}</div>
            }
          }
          @if (state()!.editorAvailable && pr.changes.length >= 0) {
            <div class="draft-bar">
              <span class="grow">
                @if (pr.structuralChangeCount > 0) {
                  Saving will ask for confirmation of the {{ pr.structuralChangeCount }} registration change(s) above.
                } @else {
                  Saving applies these changes without registering or deregistering any accessory.
                }
              </span>
              <button type="button" (click)="saveClicked(pr)" [disabled]="saving()">Save changes</button>
            </div>
          }
        } @else {
          <div class="banner safe-mode">Preview refused ({{ pr.error.code }}): {{ pr.error.message }}</div>
        }
      }
      @if (saving()) {
        <p class="empty">Saving…</p>
      }
      @if (saveResult(); as sr) {
        @if (sr.ok) {
          <div class="banner info">
            Saved. The sensor map was written through the guarded boundary
            @if (sr.snapshot === 'written') {
              — your original legacy settings were preserved first in
              <code>legacy-config-snapshot.json</code> (plugin data directory)
            } @else if (sr.snapshot === 'exists') {
              — the existing legacy snapshot was verified before writing
            }.
            Homebridge applies structural changes on the next restart.
          </div>
        } @else {
          <div class="banner safe-mode">Save refused ({{ sr.code }}): {{ sr.message }} Nothing was written.</div>
        }
      }
      @if (confirmOpen() && previewResult()?.ok) {
        <div class="modal-backdrop">
          <div class="modal">
            <h3>Confirm registration changes</h3>
            <p>These accessories will register, deregister, or re-register when saved. A re-registered accessory may need its HomeKit room assignment redone; a deregistered one leaves HomeKit.</p>
            @for (c of structuralChanges(); track $index) {
              <div class="change-row">
                <span class="change-kind {{ c.change }}">{{ c.change }}</span>
                <span class="structural-chip">{{ structuralVerb(c.change) }}</span>
                <code>{{ c.dataPoint }}</code>
                <span class="station-meta">{{ c.stationMac }}</span>
              </div>
            }
            <div class="draft-bar">
              <span class="grow"></span>
              <button type="button" (click)="confirmSave()" [disabled]="saving()">Confirm save</button>
              <button type="button" (click)="confirmOpen.set(false)">Cancel</button>
            </div>
          </div>
        </div>
      }

      @if (groups().length === 0) {
        <p class="empty">No stations or sensor rows to show yet.</p>
      }
      @for (group of groups(); track group.mac) {
        <h3>
          {{ group.title }}
          <span class="station-meta"><code>{{ group.mac }}</code> · {{ group.source }}</span>
        </h3>
        <table>
          <thead>
            <tr>
              <th>Data point</th><th>Name</th><th>Kind</th><th>Units</th>
              <th>Enabled</th><th>Layer</th><th>Battery</th><th></th>
            </tr>
          </thead>
          <tbody>
            @for (row of group.rows; track row.dataPoint) {
              <tr>
                <td>
                  @if (isDirty(row)) { <span class="dirty-dot" title="draft edits"></span> }
                  <code>{{ row.dataPoint }}</code>
                </td>
                <td>{{ row.name ?? '' }}</td>
                <td>
                  @if (row.kind === 'unrecognized') {
                    <span class="muted">unrecognized</span>
                  } @else {
                    {{ row.kind }}<span class="muted"> · {{ row.measurement }}</span>
                  }
                </td>
                <td>{{ unitCell(row) }}</td>
                <td>{{ row.kind === 'unrecognized' ? '—' : (row.enabled ? 'on' : 'off') }}</td>
                <td><span class="origin {{ row.origin }}">{{ row.origin }}</span></td>
                <td>
                  @if (row.batteryField) {
                    <code>{{ row.batteryField }}</code>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td>
                  @if (row.kind !== 'unrecognized') {
                    <button type="button" (click)="toggleEdit(row)">{{ isExpanded(row) ? 'Close' : 'Edit' }}</button>
                  }
                </td>
              </tr>
              @if (isExpanded(row)) {
                <tr>
                  <td colspan="8" class="editor-form">
                    <form [formGroup]="editForm!">
                      <label><input type="checkbox" formControlName="enabled" /> Enabled</label>
                      <label>Name <input type="text" formControlName="name" /></label>
                      @if (editForm!.get('name')?.invalid) {
                        <span class="field-error">Name is required — restore a value or use Reset row.</span>
                      }
                      @if (displayUnitOptions(row).length > 0) {
                        <label>Display unit
                          <select formControlName="displayUnit">
                            @for (u of displayUnitOptions(row); track u.unit) {
                              <option [value]="u.unit">{{ u.label }}</option>
                            }
                          </select>
                        </label>
                      }
                      @if (row.kind === 'motion') {
                        <label>Threshold <input type="number" step="any" formControlName="threshold" /></label>
                        @if (editForm!.get('threshold')?.invalid) {
                          <span class="field-error">Threshold is required for this row — restore a value or use Reset row.</span>
                        }
                        <label>Trigger
                          <select formControlName="triggerDirection">
                            <option value="above">above</option>
                            <option value="below">below</option>
                          </select>
                        </label>
                      }
                      @if (row.origin === 'global' || row.origin === 'station') {
                        <button type="button" (click)="removeOverride(row)">Remove override</button>
                      }
                      @if (isDirty(row)) {
                        <button type="button" (click)="resetRow(row)">Reset row</button>
                      }
                    </form>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      }
    }
  `,
})
export class AwnRootComponent {
  private readonly hb = inject(HomebridgeService);
  private readonly fb = inject(FormBuilder);
  readonly store = new DraftStore();

  protected readonly available = this.hb.available;
  protected readonly state = signal<EditorStateDto | undefined>(undefined);
  protected readonly vocab = signal<VocabularyDto | undefined>(undefined);
  protected readonly loadError = signal<string | undefined>(undefined);
  protected readonly previewResult = signal<PreviewResultDto | null>(null);
  protected readonly previewPending = signal(false);
  /** True while an OPEN edit form holds an invalid (blanked) control. */
  protected readonly editFormInvalid = signal(false);
  protected readonly saving = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly saveResult = signal<
    | { ok: true; snapshot: 'written' | 'exists' | 'not-applicable' }
    | { ok: false; code: string; message: string }
    | null
  >(null);
  /** Bumped on every draft mutation so computed()s re-read the store. */
  protected readonly draftVersion = signal(0);

  protected readonly expandedKey = signal<string | null>(null);
  protected editForm: ReturnType<FormBuilder['group']> | null = null;

  protected readonly draftCount = computed(() => {
    this.draftVersion();
    return this.store.draftCount;
  });

  /** Flat unit-code → display-label map across all measurements (#70). */
  private readonly unitLabels = computed<ReadonlyMap<string, string>>(() => {
    const out = new Map<string, string>();
    const vocab = this.vocab();
    for (const entry of Object.values(vocab?.measurements ?? {})) {
      for (const o of [...entry.customSource, ...entry.extendedDisplay]) {
        out.set(o.unit, o.label);
      }
    }
    return out;
  });

  protected readonly groups = computed<StationGroup[]>(() => {
    const state = this.state();
    if (!state) {
      return [];
    }
    const stationByMac = new Map(state.stations.map(s => [s.mac, s]));
    const byMac = new Map<string, EditorRowDto[]>();
    for (const row of state.rows) {
      const list = byMac.get(row.stationMac) ?? [];
      list.push(row);
      byMac.set(row.stationMac, list);
    }
    // /editor-state rows arrive sorted by (stationMac, dataPoint), so
    // group order and in-group order are already deterministic.
    return [...byMac.entries()].map(([mac, rows]) => {
      const station = stationByMac.get(mac);
      return {
        mac,
        title: station?.name || 'Station',
        source: station?.source ?? 'override',
        rows,
      };
    });
  });

  constructor() {
    if (this.hb.available) {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    try {
      const cachedAccessoryUniqueIds = await this.hb.cachedAccessoryUniqueIds();
      const [state, vocab] = await Promise.all([
        this.hb.request<EditorStateDto>('/editor-state', { cachedAccessoryUniqueIds }),
        this.hb.request<VocabularyDto>('/vocabulary'),
      ]);
      this.state.set(state);
      this.vocab.set(vocab);
      this.store.reset(state.authored);
      // Fresh baseline: drafts and preview are void, but NOT the save
      // banner — a post-save reload must not erase its own receipt
      // (bump() is for USER mutations, which do retire it).
      this.draftVersion.update(v => v + 1);
      this.previewResult.set(null);
    } catch (e) {
      this.loadError.set(e instanceof Error ? e.message : String(e));
    }
  }

  private bump(): void {
    this.draftVersion.update(v => v + 1);
    // Any draft mutation invalidates a shown preview — it no longer
    // describes the draft — and retires a previous save's banner.
    this.previewResult.set(null);
    this.saveResult.set(null);
  }

  protected rowKey(row: EditorRowDto): string {
    return `${row.stationMac}|${row.dataPoint}`;
  }

  protected isExpanded(row: EditorRowDto): boolean {
    return this.expandedKey() === this.rowKey(row);
  }

  protected isDirty(row: EditorRowDto): boolean {
    this.draftVersion();
    return this.store.isRowDirty(row);
  }

  protected displayUnitOptions(row: EditorRowDto): UnitOptionDto[] {
    if (!row.measurement) {
      return [];
    }
    return this.vocab()?.measurements[row.measurement]?.extendedDisplay ?? [];
  }

  protected toggleEdit(row: EditorRowDto): void {
    if (this.isExpanded(row)) {
      this.expandedKey.set(null);
      this.editForm = null;
      this.editFormInvalid.set(false);
      return;
    }
    const current = (field: 'enabled' | 'name' | 'displayUnit' | 'threshold' | 'triggerDirection'): unknown =>
      this.store.draftedValue(row, field) ?? (row as unknown as Record<string, unknown>)[field];
    // Blank-control policy (review #43 round 2): a blanked required
    // value is an INVALID form state — inline error, Preview blocked —
    // never a silent no-draft. `name` is always required; `threshold`
    // is required exactly when the row currently displays one (a
    // threshold-less row may stay blank; removing an authored value
    // is Remove override's job, and a default-sourced value cannot be
    // removed by an override at all).
    this.editForm = this.fb.group({
      enabled: [current('enabled') === true],
      name: [typeof current('name') === 'string' ? current('name') : '', Validators.required],
      displayUnit: [typeof current('displayUnit') === 'string' ? current('displayUnit') : ''],
      threshold: [
        typeof current('threshold') === 'number' ? current('threshold') : null,
        typeof current('threshold') === 'number' ? Validators.required : [],
      ],
      triggerDirection: [current('triggerDirection') === 'below' ? 'below' : 'above'],
    });
    this.editFormInvalid.set(this.editForm.invalid);
    this.editForm.valueChanges.subscribe((v: Record<string, unknown>) => {
      this.applyEdit(row, v);
      this.editFormInvalid.set(this.editForm?.invalid ?? false);
    });
    this.expandedKey.set(this.rowKey(row));
  }

  /**
   * Synchronize EVERY field with the form on every event (review #43
   * P1-3): a value differing from the row's original becomes a patch;
   * a value equal to the original CLEARS its patch — so reverting a
   * control in the form always reverts the draft, and for VALID form
   * states the proposal always matches what the form displays. An
   * INVALID blank clears its patch too, but remains visibly blank —
   * that state shows an inline error and blocks Preview entirely
   * (round 2), so no proposal is generated while form and draft
   * disagree.
   */
  private applyEdit(row: EditorRowDto, v: Record<string, unknown>): void {
    const sync = (field: 'enabled' | 'name' | 'displayUnit' | 'threshold' | 'triggerDirection',
      formValue: unknown, original: unknown, valid: boolean): void => {
      if (!valid || formValue === original) {
        this.store.clearField(row, field);
      } else {
        this.store.setField(row, field, formValue);
      }
    };
    sync('enabled', v.enabled === true, row.enabled, true);
    sync('name', v.name, row.name, typeof v.name === 'string' && v.name !== '');
    sync('displayUnit', v.displayUnit, row.displayUnit,
      typeof v.displayUnit === 'string' && v.displayUnit !== '');
    if (row.kind === 'motion') {
      sync('threshold', v.threshold, row.threshold, typeof v.threshold === 'number');
      sync('triggerDirection', v.triggerDirection, row.triggerDirection,
        v.triggerDirection === 'above' || v.triggerDirection === 'below');
    }
    this.bump();
  }

  protected removeOverride(row: EditorRowDto): void {
    this.store.removeOverride(row);
    // Close the form: its controls show pre-removal values, and a
    // later form event would resurrect the override as patches.
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    this.bump();
  }

  protected resetRow(row: EditorRowDto): void {
    this.store.resetRow(row);
    // Close the form (review #43 P1-3): the controls still hold the
    // edited values, and the next form event would re-draft them.
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    this.bump();
  }

  protected discardAll(): void {
    this.store.discardAll();
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    this.bump();
  }

  protected async preview(): Promise<void> {
    if (this.editFormInvalid()) {
      return; // an invalid (blanked) control blocks previewing
    }
    // Bind the request to the draft version it previews (review #43
    // P2-4): inputs stay editable while the request runs, and a
    // response for an OLDER draft must never install its results (or
    // its digest) over the newer state.
    const draftVersionAtStart = this.draftVersion();
    this.previewPending.set(true);
    this.previewResult.set(null);
    try {
      const [base, cachedAccessoryUniqueIds] = await Promise.all([
        this.hb.pluginConfigBlock(),
        this.hb.cachedAccessoryUniqueIds(),
      ]);
      const result = await this.hb.request<PreviewResultDto>('/preview-save', {
        base,
        proposal: this.store.proposal(),
        cachedAccessoryUniqueIds,
      });
      if (this.draftVersion() === draftVersionAtStart) {
        this.previewResult.set(result);
      }
    } catch (e) {
      if (this.draftVersion() === draftVersionAtStart) {
        this.previewResult.set({
          ok: false,
          error: { code: 'transport', message: e instanceof Error ? e.message : String(e) },
        });
      }
    } finally {
      this.previewPending.set(false);
    }
  }

  /** The structural subset of the current preview, for the modal. */
  protected structuralChanges(): Array<{ change: 'added' | 'removed' | 'modified'; dataPoint: string; stationMac: string }> {
    const pr = this.previewResult();
    return pr?.ok ? pr.changes.filter(c => c.structural) : [];
  }

  /**
   * Save entry point (PR C / finding 5): structural consequences open
   * the confirmation modal; in-place changes save directly. Either
   * path runs EXCLUSIVELY through composeAndPersist with the digest
   * of the preview the user is looking at — the server re-derives and
   * verifies it before anything is written.
   */
  protected saveClicked(pr: Extract<PreviewResultDto, { ok: true }>): void {
    if (pr.structuralChangeCount > 0) {
      this.confirmOpen.set(true);
      return;
    }
    void this.doSave(pr.digest);
  }

  protected confirmSave(): void {
    const pr = this.previewResult();
    if (pr?.ok) {
      void this.doSave(pr.digest);
    }
  }

  private async doSave(confirmDigest: string): Promise<void> {
    this.saving.set(true);
    this.saveResult.set(null);
    try {
      const result = await composeAndPersist(this.hb.orchestratorDeps(), {
        proposal: this.store.proposal(),
        confirmDigest,
      });
      if (result.ok) {
        this.saveResult.set({ ok: true, snapshot: result.snapshot });
        // Reload the authoritative state: the config on disk changed,
        // so drafts and the preview are consumed, not merely stale.
        this.store.discardAll();
        this.previewResult.set(null);
        this.expandedKey.set(null);
        this.editForm = null;
        this.editFormInvalid.set(false);
        this.draftVersion.update(v => v + 1);
        await this.load();
      } else {
        this.saveResult.set({ ok: false, code: result.error.code, message: result.error.message });
      }
    } catch (e) {
      this.saveResult.set({
        ok: false, code: 'transport',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.saving.set(false);
      this.confirmOpen.set(false);
    }
  }

  /** What a structural change DOES to the accessory (review #43 P1-1). */
  protected structuralVerb(change: 'added' | 'removed' | 'modified'): string {
    return change === 'added' ? 'registers' : change === 'removed' ? 'deregisters' : 're-registers';
  }

  protected changeSummary(before: EditorRowDto, after: EditorRowDto): string {
    const parts: string[] = [];
    if (before.name !== after.name) {
      parts.push(`"${before.name}" → "${after.name}"`);
    }
    if (before.enabled !== after.enabled) {
      parts.push(after.enabled ? 'enabled' : 'disabled');
    }
    if (before.displayUnit !== after.displayUnit) {
      parts.push(`${this.unitLabel(before.displayUnit)} → ${this.unitLabel(after.displayUnit)}`);
    }
    if (before.threshold !== after.threshold) {
      parts.push(`threshold ${before.threshold ?? '—'} → ${after.threshold ?? '—'}`);
    }
    if (before.triggerDirection !== after.triggerDirection) {
      parts.push(`trigger ${after.triggerDirection}`);
    }
    if (before.batteryField !== after.batteryField) {
      parts.push(`battery ${before.batteryField ?? '—'} → ${after.batteryField ?? '—'}`);
    }
    return parts.join(', ');
  }

  private unitLabel(u: string | undefined): string {
    return u === undefined ? '—' : (this.unitLabels().get(u) ?? u);
  }

  protected unitCell(row: EditorRowDto): string {
    if (!row.sourceUnit) {
      return '—';
    }
    const label = (u: string): string => this.unitLabels().get(u) ?? u;
    return row.displayUnit && row.displayUnit !== row.sourceUnit
      ? `${label(row.sourceUnit)} → ${label(row.displayUnit)}`
      : label(row.sourceUnit);
  }
}

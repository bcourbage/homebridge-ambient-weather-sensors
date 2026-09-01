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
import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild, type ElementRef } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { DraftStore } from './draft-store';
import { HomebridgeService } from './homebridge.service';
import { KIND_HELP } from './kind-support';
import { composeAndPersist } from '../saveOrchestrator';
import type {
  DisplayFamilyChoiceDto,
  DisplayFamilyDto,
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
  // Pre-focus form controls on mousedown WITHOUT scrolling: this page
  // runs in HB UI X's content-height iframe, and the browser's
  // click-focus scroll-into-view step scrolled the OUTER settings
  // page while a select's native popup opened at the pre-scroll
  // mouse position, detaching the menu from its control (Bruno's
  // beta.15 RC feedback). An already-focused control skips that
  // scroll step entirely.
  host: { '(mousedown)': 'preFocus($event)' },
  imports: [ReactiveFormsModule],
  styles: `
    h3 { font-size: 0.95rem; margin: 16px 0 4px 0; }
    /* Provenance dot (Bruno's beta.14 table feedback): the Layer
       column earned its space only for the few non-default rows, so
       layer provenance is a small dot on the data point instead —
       green = a global setting, blue = a station-scoped exception;
       the tooltip names it. Battery moved to the row editor and the
       data-point tooltip the same round. */
    .layer-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 999px;
      margin-left: 5px; vertical-align: 1px;
    }
    .layer-dot.global  { background: var(--on-fg); }
    .layer-dot.station { background: var(--info-fg); }
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
    .unit-families {
      display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center;
      margin: 0 0 4px;
    }
    .unit-families-title { font-weight: 600; }
    .unit-families label {
      display: inline-flex; gap: 6px; align-items: center;
      font-size: 0.85rem; color: var(--fg-sub);
    }
    /* Same themed control chrome as the row editor's selects: the UA
       default select ignored the page theme entirely (white in dark
       mode) and sat below the label baseline, reading as a vertical
       jump against the label text (Bruno's beta.15 RC feedback). */
    .unit-families select {
      background: var(--btn-bg); color: var(--btn-fg);
      border: 1px solid var(--btn-edge); border-radius: 4px;
      padding: 3px 6px; font-size: 0.85rem; vertical-align: middle;
    }
    .unit-families-note { margin-bottom: 10px; }
    .editor-form {
      background: var(--panel-bg); border-top: 2px solid var(--rule);
      padding: 10px 14px;
    }
    .editor-form label { display: inline-flex; align-items: center; gap: 6px; margin: 4px 16px 4px 0; font-size: 0.88rem; }
    .row-facts { display: inline-block; margin-left: 12px; font-size: 0.82rem; }
    .editor-form input[type="text"], .editor-form input[type="number"], .editor-form select {
      background: var(--btn-bg); color: var(--btn-fg);
      border: 1px solid var(--btn-edge); border-radius: 4px; padding: 4px 8px;
    }
    /* Dialog-shaped footer: Use defaults on the left (the one action
       that changes saved configuration), OK / Cancel on the right. */
    .editor-footer { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .editor-footer .grow { flex: 1; }
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
    /* In-flow confirmation card (beta.14 smoke #4): a fixed overlay
       is unusable inside HB UI X's content-height iframe. The class
       name must stay OUT of Bootstrap's namespace: HB UI X mirrors
       its stylesheets into this iframe, and Bootstrap's ".modal"
       rule (display:none; position:fixed) hid this card entirely
       while confirmOpen disabled every control (beta.14 smoke #6).
       display:block is set explicitly as a second line of defense. */
    .confirm-card {
      display: block;
      background: var(--panel-bg); color: var(--fg);
      border: 2px solid var(--warn-edge); border-radius: 8px;
      padding: 16px 20px; max-width: 640px; margin: 12px 0;
    }
    /* The row table is wider than the panel on most screens. It
       scrolls horizontally in its own container, and the action
       column stays pinned to the right edge so Edit is always
       visible (beta.13 smoke F2 - it rendered past the clipped
       right edge and looked absent). The pinned cells need a solid
       background or scrolled content bleeds through them. */
    /* Density: the page's default 6px/10px cell padding made the
       table wider than the panel; tighter cells remove the horizontal
       scrollbar on typical widths (the scroll container stays as the
       fallback for narrow windows). */
    .table-scroll { overflow-x: auto; }
    /* Fixed layout: column widths come from the header row, so an
       opened editor row cannot reflow them (Bruno's beta.14 feedback:
       the table visibly changed width on Edit). */
    .table-scroll table { table-layout: fixed; }
    th.dp { width: 22%; }
    th.name { width: auto; }
    th.kind-col { width: 64px; }
    /* Header info affordance for the Kind column: a small circled ?
       whose native title tooltip the browser draws outside the page
       layout (never clipped, no layout shift). */
    .th-help { white-space: nowrap; }
    .info-q {
      display: inline-block; width: 15px; height: 15px; line-height: 15px;
      border-radius: 999px; text-align: center;
      font-size: 0.72rem; font-weight: 600;
      background: var(--code-bg); color: var(--fg-sub);
      cursor: help; margin-left: 4px; vertical-align: 1px;
    }
    /* Visually hidden, still exposed to assistive technology. */
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    th.units { width: 14%; }
    .table-scroll th, .table-scroll td { padding: 5px 7px; }
    .table-scroll td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .table-scroll td.editor-form { overflow: visible; white-space: normal; }
    .unit-converted {
      color: var(--info-fg); background: var(--info-bg);
      padding: 0 5px; border-radius: 4px;
    }
    th.state, td.state { width: 22px; padding-right: 2px; }
    .state-icon { width: 14px; height: 14px; vertical-align: -2px; }
    .state-icon.on  { color: var(--on-fg); }
    .state-icon.off { color: var(--fg-empty); }
    td.kind { white-space: nowrap; }
    .kind-icon { width: 15px; height: 15px; vertical-align: -3px; color: var(--fg-sub); }
    .kind-badge {
      display: inline-block; padding: 0 5px; border-radius: 4px;
      font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em;
      background: var(--code-bg); color: var(--fg-sub);
    }
    th.actions, td.actions {
      position: sticky; right: 0;
      background: var(--page-bg);
      border-left: 1px solid var(--rule);
      text-align: right;
      width: 84px;
    }
    th.actions { background: var(--panel-bg); }
    td.actions button { padding: 3px 0; width: 62px; text-align: center; }
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
      <!-- Positive rollback-mirror indicator (review #45 round 4):
           the manual current-state rollback documented in the README
           is authorized ONLY by 'verified' here — 'absent' produces
           no warning banner anywhere, so silence is not a signal. -->
      @if (state()!.configMode === 'v2') {
        @if (state()!.mirrorState === 'recognized') {
          <div class="banner info">Rollback mirror: verified. The documented current-state manual rollback (deleting the three v2 markers) is available for this configuration.</div>
        } @else {
          <div class="banner">Rollback mirror: {{ state()!.mirrorState }}. Do NOT use the marker-deletion rollback. Freeze on the current 1.7.x, restore the snapshot, or save here again to regenerate the mirror.</div>
        }
      }

      <!-- Always rendered while the editor is usable: appearing only
           on the first draft shifted the whole page down mid-edit
           (beta.13 smoke F3). -->
      @if (state()!.rows.length > 0) {
        <div class="draft-bar">
          @if (draftCount() > 0) {
            <span class="grow"><strong>{{ draftCount() }}</strong> draft {{ draftCount() === 1 ? 'change' : 'changes' }}, not saved yet.</span>
          } @else {
            <span class="grow">No draft changes yet.</span>
          }
          <button type="button" (click)="preview()" [disabled]="draftCount() === 0 || previewPending() || editFormInvalid() || saving() || confirmOpen() || reloadRequired()">Preview changes</button>
          <button type="button" (click)="discardAll()" [disabled]="draftCount() === 0 || saving() || confirmOpen() || reloadRequired()">Discard drafts</button>
        </div>
      }

      <!-- Family display units (GA task #70's editor layer): one
           selector per display family from the server's canonical
           metadata, drafting a GLOBAL template per dataPoint (so
           stations not seen yet inherit it) and stripping station
           exceptions. AWN's one Rainfall choice spans rain rate and
           accumulation together. Rows stay individually editable
           afterward; a family whose rows disagree shows Mixed. -->
      @if (unitFamilies().length > 0) {
        <div class="unit-families">
          <span class="unit-families-title">Units</span>
          @for (f of unitFamilies(); track f.key) {
            <label>{{ f.label }}
              <select #familySel (change)="applyFamilyChoice(f.key, familySel.value)" [disabled]="saving() || confirmOpen() || reloadRequired()">
                <!-- Always in the DOM so the select's width never
                     changes when Mixed resolves (a width change
                     re-wraps the panel row - Bruno's beta.15 RC
                     feedback); hidden keeps it out of the dropdown. -->
                <option value="" disabled [hidden]="f.current !== ''" [selected]="f.current === ''">Mixed</option>
                @for (c of f.choices; track c.id) {
                  <option [value]="c.id" [selected]="c.id === f.current">{{ c.label }}</option>
                }
              </select>
            </label>
          }
        </div>
        <p class="sub unit-families-note">Sets the display unit for a whole category, on every station, including stations added later. Single rows can still be changed in their row editor.</p>
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
                This preview wrote nothing; saving will ask for confirmation first.
              </div>
            } @else {
              <div class="banner info">All changes apply in place; no accessory registers, deregisters, or re-registers. This preview wrote nothing.</div>
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
                  Saving will ask for confirmation of the {{ pr.structuralChangeCount }} registration {{ pr.structuralChangeCount === 1 ? 'change' : 'changes' }} above.
                } @else {
                  Saving applies these changes without registering or deregistering any accessory.
                }
              </span>
              <button type="button" (click)="saveClicked(pr)" [disabled]="saving() || confirmOpen() || reloadRequired()">Save changes</button>
            </div>
          }
        } @else {
          <div class="banner safe-mode">Preview refused ({{ pr.error.code }}): {{ pr.error.message }}</div>
        }
      }
      <div #saveOutcome>
      @if (saving()) {
        <p class="empty">Saving…</p>
      }
      @if (saveResult(); as sr) {
        @if (sr.ok) {
          <div class="banner info">
            Saved.
            @if (sr.snapshot === 'written') {
              Your original legacy settings were preserved first in
              <code>legacy-config-snapshot.json</code> (plugin data directory).
            } @else if (sr.snapshot === 'exists') {
              The existing legacy snapshot was verified before writing.
            } @else if (sr.snapshot === 'journaled') {
              Your pre-conversion settings were recorded in the
              <code>legacy-conversion-journal</code> folder; the
              original legacy snapshot is untouched.
            }
            Homebridge applies structural changes on the next full restart.
          </div>
        } @else {
          <div class="banner safe-mode">Save failed ({{ sr.code }}): {{ sr.message }}</div>
        }
      }
      @if (postSaveDrift()) {
        <div class="banner safe-mode">The configuration on disk does not exactly match what was saved. Review the plugin configuration before editing further.</div>
      }
      @if (settingsRestoreFailed()) {
        <div class="banner">
          The settings form above could not be restored after the save. The save result shown here stands; reload the plugin settings page to restore the form.
          <button type="button" (click)="reloadPage()">Reload now</button>
        </div>
      }
      </div>
      @if (reloadRequired()) {
        <div class="banner">
          <span>Editing is locked until this page is reloaded: the saved state is uncertain, so drafts and previews here may no longer match the configuration on disk. Reload, inspect the configuration, and only then retry.</span>
          <button type="button" (click)="reloadPage()">Reload now</button>
        </div>
      }
      <!-- Rendered IN FLOW, not as a fixed overlay: inside HB UI X's
           content-height iframe, position:fixed centers on the FULL
           iframe box, which put the panel far outside the visible
           window (beta.14 smoke #4 - the user saw only the grey
           backdrop). The panel appears where the user just clicked
           Save and scrolls itself into view; every other control
           disables while it is open. -->
      @if (confirmOpen() && previewResult()?.ok) {
          <div class="confirm-card" #confirmPanel>
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
              <button type="button" (click)="confirmSave()" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Confirm save' }}</button>
              <button type="button" (click)="confirmOpen.set(false)">Cancel</button>
            </div>
          </div>
      }

      @if (groups().length === 0) {
        <p class="empty">No stations or sensor rows to show yet.</p>
      }
      @for (group of groups(); track group.mac) {
        <h3>
          {{ group.title }}
          <span class="station-meta"><code [title]="'station learned from: ' + group.source">{{ group.mac }}</code></span>
        </h3>
        <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th class="state"></th>
              <th class="dp">Data point</th><th class="name">Name</th>
              <th class="kind-col">
                <span class="th-help">Kind
                  <!-- A small circled ? with a native title tooltip
                       (Bruno's beta.15 RC feedback replaced the
                       toggled help card). The browser renders title
                       outside the layout, so it can never clip; the
                       persistent aria-describedby keeps the full help
                       on the element for screen readers (PR #51
                       review round 2). -->
                  <span class="info-q" tabindex="0" role="img" aria-label="About the Kind column"
                        [attr.aria-describedby]="kindHelpId(group.mac, 'desc')"
                        [title]="KIND_HELP">?</span>
                  <span class="sr-only" [id]="kindHelpId(group.mac, 'desc')">{{ KIND_HELP }}</span>
                </span>
              </th>
              <th class="units">Units</th>
              <th class="actions"></th>
            </tr>
          </thead>
          <tbody>
            @for (row of group.rows; track row.dataPoint) {
              <tr>
                <td class="state" [title]="stateTitle(row)">
                  @if (row.kind !== 'unrecognized') {
                    @if (row.enabled) {
                      <svg class="state-icon on" viewBox="0 0 16 16" role="img" aria-label="enabled"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" stroke="var(--page-bg)" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
                    } @else {
                      <svg class="state-icon off" viewBox="0 0 16 16" role="img" aria-label="disabled"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                    }
                  }
                </td>
                <td>
                  @if (isDirty(row)) { <span class="dirty-dot" title="draft edits"></span> }
                  <code [title]="row.batteryField ? 'battery: ' + row.batteryField : ''">{{ row.dataPoint }}</code>
                  @if (row.origin === 'global' || row.origin === 'station') {
                    <span class="layer-dot {{ row.origin }}" [title]="row.origin + ' layer'"></span>
                  }
                </td>
                <td>{{ row.name ?? '' }}</td>
                <td class="kind" [title]="kindTitle(row)">
                  @switch (row.kind) {
                    @case ('temperature') {
                      <svg class="kind-icon" viewBox="0 0 16 16" role="img" [attr.aria-label]="kindTitle(row)"><path d="M6.8 2.5a1.7 1.7 0 013.4 0v6a3.4 3.4 0 11-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8.5" cy="11.4" r="1.5" fill="currentColor"/></svg>
                    }
                    @case ('humidity') {
                      <svg class="kind-icon" viewBox="0 0 16 16" role="img" [attr.aria-label]="kindTitle(row)"><path d="M8 2.2S3.8 7 3.8 10a4.2 4.2 0 108.4 0C12.2 7 8 2.2 8 2.2z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
                    }
                    @case ('light') {
                      <svg class="kind-icon" viewBox="0 0 16 16" role="img" [attr.aria-label]="kindTitle(row)"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                    }
                    @case ('motion') {
                      <svg class="kind-icon" viewBox="0 0 16 16" role="img" [attr.aria-label]="kindTitle(row)"><path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>
                    }
                    @case ('unrecognized') {
                      <span class="kind-badge muted">?</span>
                    }
                    @default {
                      <span class="kind-badge">{{ kindBadge(row.kind) }}</span>
                    }
                  }
                </td>
                <td>
                  @if (isConverted(row)) {
                    <span class="unit-converted" [title]="'converted from ' + unitLabel(row.sourceUnit)">{{ unitLabel(row.displayUnit) }}</span>
                  } @else {
                    {{ unitCell(row) }}
                  }
                </td>
                <td class="actions">
                  <!-- The editor's own footer owns closing (OK /
                       Cancel), so the column shows nothing while the
                       row is open. -->
                  @if (row.kind !== 'unrecognized' && !isExpanded(row)) {
                    <button type="button" (click)="toggleEdit(row)" [disabled]="saving() || confirmOpen() || reloadRequired()">Edit</button>
                  }
                </td>
              </tr>
              @if (isExpanded(row)) {
                <tr>
                  <td colspan="6" class="editor-form" (mousedown)="formPointerDown($event)">
                    <form [formGroup]="editForm!">
                      <label><input type="checkbox" formControlName="enabled" /> Enabled</label>
                      <label>Name <input type="text" formControlName="name" /></label>
                      @if (editForm!.get('name')?.invalid) {
                        <span class="field-error">Name is required. Restore a value or choose Cancel.</span>
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
                          <span class="field-error">Threshold is required for this row. Restore a value or choose Cancel.</span>
                        }
                        <label>Trigger
                          <select formControlName="triggerDirection">
                            <option value="above">above</option>
                            <option value="below">below</option>
                          </select>
                        </label>
                      }
                      <!-- Read-only row facts that left the table
                           (Bruno's beta.14 column trim). -->
                      <span class="muted row-facts">
                        {{ kindTitle(row) }}@if (row.batteryField) {, battery <code>{{ row.batteryField }}</code>}, {{ row.origin }} layer
                      </span>
                      <!-- Dialog-shaped footer (Bruno's row-editor
                           feedback): OK keeps this row's drafts and
                           collapses; Cancel discards them and
                           collapses; Use defaults drafts removal of
                           the row's authored settings (previewable
                           and savable like any edit). -->
                      <div class="editor-footer">
                        @if (row.origin === 'global' || row.origin === 'station') {
                          <button type="button" (click)="useDefaults(row)" [disabled]="saving() || confirmOpen() || reloadRequired()">Use defaults</button>
                        }
                        <span class="grow"></span>
                        <button type="button" (click)="toggleEdit(row)" [disabled]="saving() || confirmOpen() || reloadRequired()">OK</button>
                        <button type="button" (click)="cancelRow(row)" [disabled]="saving() || confirmOpen() || reloadRequired()">Cancel</button>
                      </div>
                    </form>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
        </div>
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
  /**
   * Terminal until reload (review #45 round 2): a
   * persistence-indeterminate outcome means the on-disk configuration
   * MAY have changed under this page — every editor action locks and
   * the user is directed to reload before doing anything else.
   */
  protected readonly reloadRequired = signal(false);
  protected readonly confirmOpen = signal(false);
  /**
   * Post-save receipt failure: the reloaded on-disk block does not
   * match the digest of what /compose-save composed — the saved
   * configuration drifted between this page and disk.
   */
  protected readonly postSaveDrift = signal(false);
  /**
   * The save outcome stands, but restoring the settings form (or its
   * Save button) failed afterward — the page is degraded and only a
   * reload fixes it (review #47 round 5, P2). Never silent.
   */
  protected readonly settingsRestoreFailed = signal(false);
  protected readonly saveResult = signal<
    // The pending-* values belong to the validate phase and never
    // reach here (a successful save reports the COMMIT outcome), but
    // the wire type includes them.
    | { ok: true; snapshot: 'written' | 'exists' | 'journaled' | 'not-applicable' | 'pending-write' | 'pending-journal' }
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

  /**
   * See the host mousedown binding: focus the pressed form control
   * (or a pressed label's control) with preventScroll so the
   * browser's own click-focus never scrolls the outer settings page.
   */
  protected preFocus(ev: Event): void {
    const target = ev.target as HTMLElement;
    const label = target instanceof HTMLLabelElement ? target : target.closest?.('label');
    const control = (label instanceof HTMLLabelElement ? label.control : null) ?? target;
    if (control instanceof HTMLSelectElement || control instanceof HTMLInputElement
      || control instanceof HTMLTextAreaElement) {
      control.focus({ preventScroll: true });
    }
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

  /**
   * The display families the Units panel renders: the server's
   * canonical family metadata (AWN units-page order), filtered to
   * families with at least one editable row on the page. `current`
   * is the CHOICE id every eligible row currently reflects (drafts
   * included), or '' when rows disagree (rendered as Mixed).
   */
  protected readonly unitFamilies = computed<Array<{ key: string; label: string; choices: DisplayFamilyChoiceDto[]; current: string }>>(() => {
    this.draftVersion();
    const vocab = this.vocab();
    const state = this.state();
    if (!vocab || !state) {
      return [];
    }
    const out: Array<{ key: string; label: string; choices: DisplayFamilyChoiceDto[]; current: string }> = [];
    for (const family of vocab.families ?? []) {
      // Rows drafted out of existence neither render in the family's
      // state nor hold it on Mixed (round 5).
      const eligible = state.rows.filter(r => this.rowInFamily(r, family) && this.rowSurvivesDrafts(r));
      if (eligible.length === 0) {
        continue;
      }
      const match = family.choices.find(c =>
        eligible.every(r => this.effectiveDisplayUnit(r) === c.units[r.measurement!]));
      out.push({ key: family.key, label: family.label, choices: family.choices, current: match?.id ?? '' });
    }
    return out;
  });

  private rowInFamily(row: EditorRowDto, family: DisplayFamilyDto): boolean {
    return row.kind !== 'unrecognized' && row.measurement !== undefined
      && family.measurements.includes(row.measurement);
  }

  /**
   * Does this row survive the CURRENT drafts (round 5)? The one
   * predicate behind both the family action and the family selector's
   * displayed state, so a row drafted out of existence can neither
   * take a unit patch nor hold a selector on Mixed.
   *
   * Survival uses `origin` — the resolver's ACCEPTED layers — rather
   * than re-reading raw authored kind/measurement (raw fragments
   * deliberately include rejected entries): a custom row with
   * origin 'station' has an accepted station fragment, which for a
   * custom dataPoint always carries its own full identity (the save
   * boundary refuses partial custom exceptions).
   */
  private rowSurvivesDrafts(row: EditorRowDto): boolean {
    if (row.identityScope === 'custom-station') {
      return !this.store.keyRemovedFor(row.stationMac, row.dataPoint);
    }
    if (row.identityScope === 'custom-global' && this.store.keyRemovedFor(undefined, row.dataPoint)) {
      // The global identity is going away: only an independently
      // accepted station exception survives, while its own key stands.
      return row.origin === 'station' && !this.store.keyRemovedFor(row.stationMac, row.dataPoint);
    }
    // Known rows always survive an override removal (they fall back
    // to the built-in defaults); a custom-global row survives while
    // its global key remains.
    return true;
  }

  /**
   * The display unit a row would resolve to with pending drafts
   * applied — field-level layering for this ONE field (station patch
   * over surviving station-authored value over global patch over the
   * server-resolved unit), so the Units panel reflects drafts the
   * family action itself creates. Preview and save remain
   * server-authoritative; this never feeds a proposal.
   */
  private effectiveDisplayUnit(row: EditorRowDto): string | undefined {
    const own = this.store.draftedValue(row, 'displayUnit');
    if (typeof own === 'string') {
      return own;
    }
    if (row.origin !== 'global') {
      const stationAuthored = this.store.authoredValueFor(row.stationMac, row.dataPoint, 'displayUnit');
      const stationGone = this.store.fieldRemovedFor(row.stationMac, row.dataPoint, 'displayUnit')
        || this.store.keyRemovedFor(row.stationMac, row.dataPoint);
      if (typeof stationAuthored === 'string' && !stationGone) {
        return row.displayUnit; // the station exception stands; the server already resolved it
      }
      const globalPatch = this.store.draftedValueFor(undefined, row.dataPoint, 'displayUnit');
      if (typeof globalPatch === 'string') {
        return globalPatch;
      }
      if (typeof stationAuthored === 'string' && stationGone) {
        // The exception is being stripped with no global draft: the
        // authored global template (or the default) takes over.
        const globalAuthored = this.store.authoredValueFor(undefined, row.dataPoint, 'displayUnit');
        return typeof globalAuthored === 'string' ? globalAuthored : row.displayUnit;
      }
    }
    return row.displayUnit;
  }

  /**
   * Apply one family choice (review F1: global, set-once semantics):
   * per dataPoint of the family, author a GLOBAL displayUnit template
   * (so stations not yet seen inherit it) and strip the displayUnit
   * field from station exceptions. A global fragment is skipped only
   * when nothing is authored anywhere and every row already resolves
   * to the choice (authoring it would be a pure no-op config change).
   * Pending row-level unit drafts are superseded, and an open
   * family-member row editor is closed first (its form would re-draft
   * a stale station-level unit on its next sync).
   */
  protected applyFamilyChoice(familyKey: string, choiceId: string): void {
    const vocab = this.vocab();
    const state = this.state();
    const family = vocab?.families.find(f => f.key === familyKey);
    const choice = family?.choices.find(c => c.id === choiceId);
    if (!vocab || !state || !family || !choice) {
      return;
    }

    const familyRows = state.rows.filter(r => this.rowInFamily(r, family));
    if (familyRows.some(r => this.isExpanded(r))) {
      this.expandedKey.set(null);
      this.editForm = null;
      this.editFormInvalid.set(false);
    }

    // Identity scope splits the action (review round 2 F1): a
    // station-only custom identity cannot take a global template — a
    // bare global fragment for a custom dataPoint is refused as
    // custom-missing-kind, and copying the identity would create the
    // accessory on every station. Those rows get station-scoped unit
    // patches instead (grouping by dataPoint is also wrong for them:
    // custom identities for one dataPoint can differ per station).
    const stationScoped = familyRows.filter(r => r.identityScope === 'custom-station');
    for (const row of stationScoped) {
      const unit = choice.units[row.measurement!];
      if (unit === undefined) {
        continue;
      }
      // Round 3 F2: the row's identity lives in its station fragment;
      // with that key drafted for whole-key removal (Use defaults), a
      // unit patch would resurrect the row as a minimal replacement
      // WITHOUT its identity (custom-missing-kind). Skip it — the row
      // is on its way out.
      if (!this.rowSurvivesDrafts(row)) {
        continue;
      }
      if (unit === row.displayUnit) {
        this.store.clearField(row, 'displayUnit');
      } else {
        this.store.setField(row, 'displayUnit', unit);
      }
    }

    const byDataPoint = new Map<string, EditorRowDto[]>();
    for (const row of familyRows) {
      if (row.identityScope === 'custom-station') {
        continue;
      }
      const list = byDataPoint.get(row.dataPoint) ?? [];
      list.push(row);
      byDataPoint.set(row.dataPoint, list);
    }

    for (const [dataPoint, rows] of byDataPoint) {
      // known and custom-global rows share one measurement per
      // dataPoint (the default map or the matched global identity
      // fixes it; a station identity with a DIFFERENT measurement is
      // classified custom-station and never reaches this group).
      const unit = choice.units[rows[0].measurement!];
      if (unit === undefined) {
        continue;
      }
      // Rounds 3-4 F2: a custom dataPoint whose global identity
      // fragment is drafted for removal must not get a global unit
      // patch — the minimal replacement would lack the identity
      // (custom-missing-kind). But the family choice still covers
      // every row that SURVIVES the removal (round 4): a station
      // fragment for a custom dataPoint always carries its own full
      // identity (the save boundary refuses partial custom
      // exceptions), so such rows keep producing accessories and take
      // station-scoped unit patches; purely global-origin rows
      // disappear with the template and are skipped. Known dataPoints
      // need no identity, so their replacement fragment stays legal
      // and the normal path below handles them.
      if (rows[0].identityScope === 'custom-global' && this.store.keyRemovedFor(undefined, dataPoint)) {
        for (const row of rows) {
          if (!this.rowSurvivesDrafts(row)) {
            continue;
          }
          // Always an explicit patch: the row's resolved displayUnit
          // may come from the global fragment being removed, so an
          // equal-looking value can still need re-authoring on the
          // surviving station fragment (prune drops it if that
          // fragment already says so).
          this.store.setFieldFor(row.stationMac, dataPoint, 'displayUnit', unit);
        }
        continue;
      }
      // The family choice supersedes pending row-level unit drafts.
      for (const row of rows) {
        this.store.clearField(row, 'displayUnit');
      }
      // Strip station displayUnit exceptions — but ONLY for stations
      // whose row actually inherits this global unit (round 3 F1): a
      // station identity override with a different measurement keeps
      // its own displayUnit untouched.
      const inheritingMacs = new Set(rows.map(r => r.stationMac.toUpperCase()));
      const exceptions = this.store.stationsAuthoringField(dataPoint, 'displayUnit')
        .filter(mac => inheritingMacs.has(mac.toUpperCase()));
      for (const mac of exceptions) {
        this.store.removeFieldFor(mac, dataPoint, 'displayUnit');
      }
      const globalAuthored = this.store.authoredValueFor(undefined, dataPoint, 'displayUnit');
      const alreadyDefault = globalAuthored === undefined && exceptions.length === 0
        && rows.every(r => r.displayUnit === unit);
      if (alreadyDefault) {
        this.store.clearFieldFor(undefined, dataPoint, 'displayUnit');
      } else {
        this.store.setFieldFor(undefined, dataPoint, 'displayUnit', unit);
      }
    }
    this.bump();
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
    // is Use defaults' job, and a default-sourced value cannot be
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

  protected useDefaults(row: EditorRowDto): void {
    this.store.removeOverride(row);
    // Close the form: its controls show pre-removal values, and a
    // later form event would resurrect the override as patches.
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    this.bump();
  }

  protected cancelRow(row: EditorRowDto): void {
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
      // The staleness token is the digest /editor-state issued for the
      // block this session loaded — NEVER a block copy from
      // homebridge.getPluginConfig(): HB UI X returns the schema
      // form's mutated in-memory config, which does not byte-match
      // disk (beta.13 smoke F1 — every preview refused stale-base).
      const cachedAccessoryUniqueIds = await this.hb.cachedAccessoryUniqueIds();
      const result = await this.hb.request<PreviewResultDto>('/preview-save', {
        baseDigest: this.state()?.baseDigest,
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
  /** The in-flow confirmation card, for scroll-into-view on open. */
  private readonly confirmPanel = viewChild<ElementRef<HTMLElement>>('confirmPanel');
  /** The save-outcome banner area, brought into view after a save. */
  private readonly saveOutcome = viewChild<ElementRef<HTMLElement>>('saveOutcome');

  protected saveClicked(pr: Extract<PreviewResultDto, { ok: true }>): void {
    if (pr.structuralChangeCount > 0) {
      this.confirmOpen.set(true);
      // Bring the just-rendered card into the visible window: the
      // scroll propagates through the same-origin iframe to HB UI X's
      // scroll container (beta.14 smoke #4).
      setTimeout(() => this.confirmPanel()?.nativeElement?.scrollIntoView?.({ block: 'center' }), 0);
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
    this.postSaveDrift.set(false);
    this.settingsRestoreFailed.set(false);
    // Immediate feedback where it will stay: the outcome area shows
    // "Saving…" now and the result later (beta.14 smoke: a save whose
    // only signs lived off-screen read as "did nothing").
    setTimeout(() => this.saveOutcome()?.nativeElement?.scrollIntoView?.({ block: 'center' }), 0);
    // Lock editing for the duration (review #45 P2-4): the open form
    // closes (no form events can draft mid-save) and Edit/Preview/
    // Discard disable via saving() — a slow save can never race a
    // newer draft into the post-save discard/reload.
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    try {
      const result = await composeAndPersist(this.hb.orchestratorDeps(), {
        proposal: this.store.proposal(),
        confirmDigest,
        baseDigest: this.state()?.baseDigest,
        blockIndex: this.state()?.blockIndex,
      });
      if (result.settingsRestoreFailed) {
        this.settingsRestoreFailed.set(true);
      }
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
        // Post-save receipt: the reloaded on-disk block must be
        // EXACTLY what /compose-save composed. A mismatch means
        // something between this page and disk altered the block in
        // flight (HB UI X's merge-style update, another session) —
        // surface it instead of letting the drift pass silently.
        if (this.state() !== null && this.state()!.baseDigest !== result.nextConfigDigest) {
          this.postSaveDrift.set(true);
        }
      } else {
        this.saveResult.set({ ok: false, code: result.error.code, message: result.error.message });
        if (result.error.code === 'persistence-indeterminate') {
          this.reloadRequired.set(true);
        }
      }
    } catch (e) {
      this.saveResult.set({
        ok: false, code: 'transport',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.saving.set(false);
      this.confirmOpen.set(false);
      // The outcome banners render near the top of the editor while
      // the user is usually scrolled at the table (beta.14 smoke:
      // "save does nothing" was a refusal banner far off-screen).
      // Bring the outcome into the visible window, whatever it says.
      setTimeout(() => this.saveOutcome()?.nativeElement?.scrollIntoView?.({ block: 'center' }), 0);
    }
  }

  protected reloadPage(): void {
    this.hb.reloadWindow();
  }

  /** What a structural change DOES to the accessory (review #43 P1-1). */
  protected structuralVerb(change: 'added' | 'removed' | 'modified'): string {
    return change === 'added' ? 'registers' : change === 'removed' ? 'deregisters' : 're-registers';
  }

  /**
   * Focus-scroll mitigation (beta.14 smoke): when a dropdown or input
   * in the row editor is clicked, Safari scrolls the newly focused
   * control toward the center of the scrollable ancestor — HB UI X's
   * settings modal — yanking the page up or down. Focusing the
   * control WITHOUT scrolling before the native focus-on-click runs
   * makes the browser's own focus pass a no-op.
   */
  protected formPointerDown(ev: Event): void {
    const t = ev.target as (HTMLElement & { focus(o?: { preventScroll?: boolean }): void }) | null;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) {
      t.focus({ preventScroll: true });
    }
  }

  /** Tooltip + accessible label for the leading state icon. */
  protected stateTitle(row: EditorRowDto): string {
    return row.kind === 'unrecognized' ? 'unrecognized field' : (row.enabled ? 'enabled' : 'disabled');
  }

  /** Kind column header help (issue #50), see kind-support.ts. */
  protected readonly KIND_HELP = KIND_HELP;

  /**
   * Stable per-station element ids for the Kind help ARIA wiring
   * (macs repeat per group but never within one, and colons are
   * stripped so the ids stay selector-friendly).
   */
  protected kindHelpId(mac: string, part: 'desc'): string {
    return `kind-help-${part}-${mac.replace(/[^A-Za-z0-9]/g, '')}`;
  }

  /** Tooltip + accessible label for the Kind icon or badge. */
  protected kindTitle(row: EditorRowDto): string {
    if (row.kind === 'unrecognized') {
      return 'unrecognized field';
    }
    // Kind and measurement often coincide (temperature, humidity);
    // repeating them read as noise, and bullet separators are out
    // (Bruno's beta.14 feedback).
    return row.kind === row.measurement ? row.kind : `${row.kind} (${row.measurement})`;
  }

  /** Compact badge text for initialism kinds with no natural glyph. */
  protected kindBadge(kind: string): string {
    const badges: Record<string, string> = {
      'co2': 'CO₂',
      'co': 'CO',
      'air-quality-pm25': 'PM2.5',
      'air-quality-pm10': 'PM10',
    };
    return badges[kind] ?? kind;
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

  protected unitLabel(u: string | undefined): string {
    return u === undefined ? '—' : (this.unitLabels().get(u) ?? u);
  }

  protected unitCell(row: EditorRowDto): string {
    if (!row.sourceUnit) {
      return '—';
    }
    return this.unitLabel(row.sourceUnit);
  }

  /** A row whose HomeKit display unit differs from the AWN source unit. */
  protected isConverted(row: EditorRowDto): boolean {
    return !!row.sourceUnit && !!row.displayUnit && row.displayUnit !== row.sourceUnit;
  }
}

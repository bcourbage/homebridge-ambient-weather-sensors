/**
 * Sensor-map editor, draft stage (GA task #69, PR B). Renders the
 * /editor-state read model grouped by station, lets the user DRAFT
 * row edits (enable/disable, rename, display unit, thresholds,
 * remove-override), and dry-runs drafts through the server's
 * /preview-save — the exact save pipeline with zero writes.
 *
 * PERSISTENCE (PR C / finding 5; confirmation model revised in the
 * beta.17 RC smoke): saving runs EXCLUSIVELY through composeAndPersist
 * — /compose-save validates against the on-disk config, verifies the
 * structural confirmation digest, writes the legacy snapshot FIRST,
 * and only then does the returned config reach updatePluginConfig/
 * savePluginConfig, verbatim. The PREVIEW is the confirmation: the
 * user sees every consequence (Skip available per row) and the Save
 * click composes with that preview's digest — no second modal. Every
 * refusal produces zero config writes.
 *
 * Styling deliberately leans on the fragment page's #awn scope: this
 * component renders inside <div id="awn">, so the page's table rules
 * and theme variables (light + dark) apply to it as-is. Component
 * styles below add only what the page doesn't define.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild, type ElementRef } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, type AbstractControl } from '@angular/forms';

import { DraftStore, type DraftableField } from './draft-store';
import { HomebridgeService } from './homebridge.service';
import { KIND_HELP, KIND_SUPPORT } from './kind-support';
import { composeAndPersist } from '../saveOrchestrator';
import type {
  AssignmentOptionDto,
  EditorAuthoredFragmentDto,
  EditorDiagnosticDto,
  EditorSettingsDto,
  DisplayFamilyChoiceDto,
  DisplayFamilyDto,
  EditorRowDto,
  EditorStateDto,
  ConfigOnlyChangeDto,
  PreviewChangeDto,
  PreviewResultDto,
  UnitOptionDto,
  VocabularyDto,
} from './dto/editor-state';

interface StationGroup {
  mac: string;
  title: string;
  source: string;
  rows: EditorRowDto[];
  /** Rows removed from view by the hide-no-data filter. */
  hiddenCount: number;
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
  host: {
    '(mousedown)': 'preFocus($event)',
    '(mouseover)': 'tipShow($event)',
    '(mouseout)': 'tipHide($event)',
    '(focusin)': 'tipShow($event)',
    '(focusout)': 'tipHide()',
  },
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
    /* Two-up grid of label/select rows under a Units title (Bruno's
       beta.15 RC feedback: the single wrapped line read poorly).
       Fixed label column keeps every select left-aligned; the grid
       collapses to one per row on narrow panels. */
    .unit-families { margin: 0 0 4px; }
    .unit-families-title { font-weight: 600; display: block; margin-bottom: 6px; }
    .unit-family-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 6px 28px; max-width: 620px;
    }
    .unit-family-grid label {
      display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 8px;
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
    .change-kind.chip-disabled { background: var(--code-bg);  color: var(--fg-sub); }
    .structural-chip {
      display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 999px;
      font-size: 0.72rem; font-weight: 600;
      background: var(--warn-bg); color: var(--warn-fg);
    }
    .change-row { padding: 4px 0; border-bottom: 1px solid var(--row-rule); font-size: 0.88rem; }
    .inline-note { margin: 4px 0 2px 12px; padding-left: 8px; border-left: 3px solid var(--info-fg); color: var(--fg-sub); font-size: 0.85rem; line-height: 1.45; }
    /* Notes must WRAP inside the scrollable table (its cells are
       nowrap-ellipsis by default) at a capped measure, or a long note
       widens the table and clips. */
    .table-scroll .note-tr td { padding-top: 0; white-space: normal; overflow: visible; }
    .note-tr .inline-note { max-width: 76ch; }
    .app-tip {
      position: fixed; z-index: 60; max-width: 340px;
      background: var(--panel-bg); color: var(--fg);
      border: 1px solid var(--rule); border-radius: 6px;
      padding: 6px 9px; font-size: 0.8rem; line-height: 1.4;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      pointer-events: none; white-space: normal;
    }
    /* While a re-preview runs, the previous result stays visible but
       dimmed instead of being torn down (flicker on Skip). */
    .preview-block.previewing { opacity: 0.55; }
    .exclude-change { margin-left: 10px; padding: 1px 8px; font-size: 0.78rem; }
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
    /* Hugs the "Kind" text (2px) so it reads as Kind's affordance,
       not a stray element between the Kind and Units headers
       (Bruno's beta.15 RC feedback). */
    .info-q {
      display: inline-block; width: 14px; height: 14px; line-height: 14px;
      border-radius: 999px; text-align: center;
      font-size: 0.7rem; font-weight: 600;
      background: var(--code-bg); color: var(--fg-sub);
      cursor: help; margin-left: 2px; vertical-align: 1px;
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
      /* The chip's own padding pushed its text right of the plain
         units; pull the box left so every unit's TEXT shares one
         left edge (the chip bleeds into the cell padding instead). */
      margin-left: -5px;
    }
    /* Sized for border-box: the host mirrors its stylesheets (global
       border-box included) into the iframe, so the cell width must
       cover the 14px icon PLUS the page's 10px cell paddings (the
       #awn td padding rule outranks any override here) or the icon
       clips on the right. */
    th.state, td.state { width: 34px; }
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
    /* Uniform width sized for the widest label ("Assign") PLUS the
       page's 12px button paddings (the #awn button rule outranks any
       padding here) under border-box, which the host's mirrored reset
       applies. 62px left a 36px content box and the label overflowed
       rightward, reading as off-center. */
    td.actions button { width: 72px; box-sizing: border-box; text-align: center; }
    .connection { border: 1px solid var(--rule); border-radius: 6px; margin: 10px 0; }
    .conn-summary {
      display: flex; align-items: baseline; gap: 8px; width: 100%;
      background: none; border: none; color: var(--fg);
      padding: 8px 12px; cursor: pointer; text-align: left; font-weight: 600;
    }
    .conn-caret { color: var(--fg-sub); font-size: 1.05em; line-height: 1; }
    .status-chip {
      font-size: 0.78em; font-weight: 600; border-radius: 10px; padding: 2px 9px;
      border: 1px solid var(--rule); color: var(--fg-sub); white-space: nowrap;
    }
    .status-chip.ok { border-color: var(--info-edge); background: var(--info-bg); color: var(--info-fg); }
    .status-chip.bad { border-color: var(--error-edge); background: var(--error-bg); color: var(--error-fg); }
    /* Hints are FULL-WIDTH grid rows under their field row (beta.17
       RC smoke: column-trapped hints wrapped into tall slivers), with
       pinned line metrics: the host mirrors its stylesheets into this
       iframe, so inherited typography varies by HB UI X version. */
    .conn-hint {
      grid-column: 1 / -1; color: var(--fg-sub);
      font-size: 0.8rem; font-weight: 400; line-height: 1.45;
      margin: -4px 0 2px; max-width: 76ch;
    }
    .conn-grid {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 16px; padding: 4px 12px 12px;
    }
    @media (max-width: 540px) {
      .conn-grid { grid-template-columns: 1fr; }
    }
    .conn-grid label { display: flex; flex-direction: column; gap: 4px; color: var(--fg-sub); font-size: 0.9em; }
    .conn-grid input, .conn-grid select, .conn-grid textarea {
      font: inherit; color: var(--fg); background: var(--panel-bg);
      border: 1px solid var(--rule); border-radius: 4px; padding: 4px 8px;
    }
    .notices-block { margin-top: 16px; }
    .notices-list { margin: 0; padding: 4px 12px 12px 28px; color: var(--fg-sub); }
    .rollback-line { padding: 4px 12px 12px; color: var(--fg-sub); font-size: 0.85rem; line-height: 1.45; max-width: 76ch; }
    .rollback-line p { margin: 0 0 6px; }
    .rollback-line ol { margin: 0 0 6px; padding-left: 22px; }
    .rollback-line a { color: var(--info-fg); }
    .nodata-chip {
      font-size: 0.72em; border-radius: 8px; padding: 1px 7px; margin-left: 6px;
      border: 1px solid var(--rule); color: var(--fg-empty); white-space: nowrap; vertical-align: 1px;
    }
    .station-action { font-size: 0.72em; font-weight: 400; padding: 2px 9px; margin-left: 10px; vertical-align: 2px; }
    .hidden-note { margin: 4px 0 0; color: var(--fg-empty); font-size: 0.85rem; font-style: italic; }
    .table-filter {
      display: flex; align-items: center; gap: 6px; margin: 10px 0 0;
      color: var(--fg-sub); font-size: 0.85rem; width: fit-content; cursor: pointer;
    }
  `,
  template: `
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
      @if (residualStateNotes().length > 0) {
        <!-- Only notes matching no row on the page: a note that
             concerns one row renders inline under that row in its
             station table instead (beta.17 RC smoke, same rule as
             preview notes). -->
        <h3>Notes</h3>
        @for (n of residualStateNotes(); track $index) {
          <div class="banner info">{{ n.message }}</div>
        }
      }
      @if (state()!.freshInstall) {
        <div class="banner info">
          No Ambient Weather configuration exists yet. Enter your API key and application key under
          Connection &amp; polling and save; your stations and sensors appear here after the plugin
          first connects. Keys come from your account page at ambientweather.net.
        </div>
      }
      <!-- Rollback-mirror indicator (review #45 round 4): the manual
           current-state rollback documented in the README is
           authorized ONLY by 'verified'. Warning states stay
           prominent here; the verified-positive line lives in the
           notices disclosure at the bottom (beta.17 RC smoke), where
           someone contemplating a rollback looks it up. -->
      @if (state()!.configMode === 'v2' && state()!.mirrorState !== 'recognized') {
        <div class="banner">Rollback mirror: {{ state()!.mirrorState }}. Do NOT use the marker-deletion rollback. Freeze on the current 1.7.x, restore the snapshot, or save here again to regenerate the mirror.</div>
      }

      <!-- Connection settings (beta.17, GA #56): the schema form is
           retired, so the plugin's live settings are edited here and
           save through the same guarded pipeline as the sensor map.
           Credential inputs are INTENTS: a blank field means
           unchanged; replacing types a new value; clearing requires
           the explicit checkbox. -->
      <div class="connection">
        <button type="button" class="conn-summary" (click)="connectionOpen.set(!connectionOpen())" [attr.aria-expanded]="connectionOpen()">
          <span class="conn-caret">{{ connectionOpen() ? '\u25bc' : '\u25b6' }}</span>
          Connection &amp; polling
          @for (chip of connectionChips(); track chip.label) {
            <span class="status-chip {{ chip.tone }}">{{ chip.label }}</span>
          }
        </button>
        @if (connectionOpen() && settingsForm) {
          <form [formGroup]="settingsForm" class="conn-grid">
            <label>Platform name
              <input type="text" formControlName="name" />
            </label>
            <label>Data source
              <select formControlName="dataSource">
                <option value="polling">Polling</option>
                <option value="realtime">Realtime</option>
              </select>
            </label>
            <span class="conn-hint">The platform name is shown in Homebridge logs and the Homebridge UI. Station names come from your AmbientWeather.net account and cannot be changed here.</span>
            <label>API key
              <input type="password" autocomplete="off" formControlName="apiKey"
                (focus)="selectPristineMask($event)"
                [attr.placeholder]="state()!.settings.apiKeySet ? null : 'not set'" />
            </label>
            <label>Application key
              <input type="password" autocomplete="off" formControlName="applicationKey"
                (focus)="selectPristineMask($event)"
                [attr.placeholder]="state()!.settings.applicationKeySet ? null : 'not set'" />
            </label>
            <span class="conn-hint">Stored keys show as dots. Type over one to replace it; delete the dots and leave the field empty to clear it.</span>
            <label>Station filter (one entry per line)
              <textarea rows="2" formControlName="stationFilter" placeholder="All stations"></textarea>
            </label>
            <label>Embed-name update interval (minutes)
              <input type="number" min="0" step="1" formControlName="embedInterval" placeholder="2" />
            </label>
            <span class="conn-hint">Station filter: only stations listed here (by name or MAC address) get accessories from this plugin instance; leave it empty for all stations. Mainly for multi-Home setups, one platform instance per Home.</span>
            <span class="conn-hint">Embed-name update interval: applies only when tile names embed live values, as the minimum time between tile-name rewrites. Larger values reduce HomeKit notification volume on paired phones.</span>
            @if (settingsError()) {
              <span class="field-error">{{ settingsError() }}</span>
            }
          </form>
        }
      </div>

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
          <div class="unit-family-grid">
            @for (f of unitFamilies(); track f.key) {
              <label>
                <span class="unit-family-name">{{ f.label }}</span>
                <select #familySel (change)="applyFamilyChoice(f.key, familySel.value)" [disabled]="saving() || reloadRequired()">
                  <!-- Always in the DOM so the select's width never
                       changes when Mixed resolves; hidden keeps it out
                       of the dropdown. -->
                  <option value="" disabled [hidden]="f.current !== ''" [selected]="f.current === ''">Mixed</option>
                  @for (c of f.choices; track c.id) {
                    <option [value]="c.id" [selected]="c.id === f.current">{{ c.label }}</option>
                  }
                </select>
              </label>
            }
          </div>
        </div>
        <p class="sub unit-families-note">Sets the display unit for a whole category, on every station, including stations added later. Single rows can still be changed in their row editor. Temperature has no unit choice here: Apple Home renders it in each device's own region format.</p>
      }

      @if (previewPending() && !previewResult()) {
        <p class="empty">Previewing…</p>
      }
      @if (groups().length === 0) {
        <p class="empty">No stations or sensor rows to show yet.</p>
      }
      @if (anyNeverReported()) {
        <label class="table-filter">
          <input type="checkbox" [checked]="hideNoData()" (change)="setHideNoData($any($event.target).checked)" />
          Hide sensors with no data
        </label>
      }
      @for (group of groups(); track group.mac) {
        <h3>
          {{ group.title }}
          <span class="station-meta"><code [attr.data-tip]="'station learned from: ' + group.source">{{ group.mac }}</code></span>
          @if (noDataEnabledRows(group).length > 0) {
            <button type="button" class="station-action"
                    [attr.data-tip]="noDataTip(group)"
                    [disabled]="saving() || reloadRequired()"
                    (click)="disableNoData(group)">Disable {{ noDataEnabledRows(group).length }} sensor{{ noDataEnabledRows(group).length === 1 ? '' : 's' }} with no data</button>
          }
        </h3>
        @if (group.rows.length > 0) {
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
                        [attr.data-tip]="KIND_HELP">?</span>
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
                <td class="state" [attr.data-tip]="stateTitle(row)">
                  @if (row.kind !== 'unrecognized') {
                    @if (row.enabled) {
                      <svg class="state-icon on" viewBox="0 0 16 16" role="img" aria-label="enabled"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" stroke="var(--page-bg)" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
                    } @else {
                      <svg class="state-icon off" viewBox="0 0 16 16" role="img" aria-label="disabled"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                    }
                  }
                </td>
                <td>
                  @if (isDirty(row)) { <span class="dirty-dot" data-tip="draft edits"></span> }
                  <code [attr.data-tip]="row.batteryField ? 'battery: ' + row.batteryField : null">{{ row.dataPoint }}</code>
                  @if (row.origin === 'global' || row.origin === 'station') {
                    <span class="layer-dot {{ row.origin }}" [attr.data-tip]="row.origin + ' layer'"></span>
                  }
                </td>
                <td>{{ row.name ?? '' }}
                  @if (neverReported(row)) {
                    <span class="nodata-chip" data-tip="This station has never reported this field, so it creates no HomeKit accessory even when enabled.">no data</span>
                  }
                </td>
                <td class="kind" [attr.data-tip]="kindTitle(row)">
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
                    <span class="unit-converted" [attr.data-tip]="convertedTip(row)">{{ unitLabel(row.displayUnit) }}</span>
                  } @else {
                    <span [attr.data-tip]="unitCellTitle(row) || null">{{ unitCell(row) }}</span>
                  }
                </td>
                <td class="actions">
                  <!-- The editor's own footer owns closing (OK /
                       Cancel), so the column shows nothing while the
                       row is open. Unrecognized rows offer Assign
                       (PR E): the same editor, opened in its
                       assignment shape. -->
                  @if (!isExpanded(row)) {
                    <button type="button" (click)="toggleEdit(row)" [disabled]="saving() || reloadRequired()">{{ row.kind === 'unrecognized' ? 'Assign' : 'Edit' }}</button>
                  }
                </td>
              </tr>
              @for (note of rowNotes(row); track $index) {
                <tr class="note-tr"><td></td><td colspan="5"><div class="inline-note">{{ note }}</div></td></tr>
              }
              @if (isExpanded(row)) {
                <tr>
                  <td colspan="6" class="editor-form" (mousedown)="formPointerDown($event)">
                    <form [formGroup]="editForm!">
                      @if (row.kind === 'unrecognized') {
                        <!-- Assignment controls (PR E). The identity
                             is atomic: applyEdit drafts nothing until
                             measurement and (for numeric measurements)
                             source unit are both chosen, so a partial
                             custom fragment never reaches the save
                             pipeline's custom-missing-* refusals. -->
                        <label>Measurement
                          <select formControlName="measurement">
                            <option value="">Choose…</option>
                            @for (a of assignmentOptions(); track a.measurement) {
                              <option [value]="a.measurement">{{ a.label }}</option>
                            }
                          </select>
                        </label>
                        @if (assignSourceOptions().length > 0) {
                          <label>Source unit
                            <select formControlName="sourceUnit">
                              <option value="">Choose…</option>
                              @for (u of assignSourceOptions(); track u.unit) {
                                <option [value]="u.unit">{{ u.label }}</option>
                              }
                            </select>
                          </label>
                        }
                        @if (assignedKindLabel()) {
                          <span class="muted">Creates a {{ assignedKindLabel() }} accessory.</span>
                        }
                        @if (assignError()) {
                          <span class="field-error">{{ assignError() }}</span>
                        }
                      }
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
                      @if (showsTriggerControls(row)) {
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
                      @if (row.kind === 'unrecognized') {
                        <span class="muted row-facts">
                          Unrecognized field. Assigning it creates a custom sensor for this station only.
                        </span>
                      } @else {
                        <span class="muted row-facts">
                          {{ kindSentence(row) }}
                          @if (row.batteryField) {
                            @if (row.hasBatterySubService) {
                              The battery level comes from the station's <code>{{ row.batteryField }}</code> field.
                            } @else {
                              References the station's <code>{{ row.batteryField }}</code> battery field; this row shows no battery level of its own.
                            }
                          }
                          {{ originSentence(row) }}
                        </span>
                      }
                      <!-- Dialog-shaped footer (Bruno's row-editor
                           feedback): OK keeps this row's drafts and
                           collapses; Cancel discards them and
                           collapses; Use defaults drafts removal of
                           the row's authored settings (previewable
                           and savable like any edit). -->
                      <div class="editor-footer">
                        @if (useDefaultsAvailable(row)) {
                          <button type="button" (click)="useDefaults(row)" [disabled]="saving() || reloadRequired()">Use defaults</button>
                        }
                        <span class="grow"></span>
                        <button type="button" (click)="toggleEdit(row)" [disabled]="saving() || reloadRequired()">OK</button>
                        <button type="button" (click)="cancelRow(row)" [disabled]="saving() || reloadRequired()">Cancel</button>
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
        @if (group.hiddenCount > 0) {
          <p class="hidden-note">{{ group.hiddenCount }} sensor{{ group.hiddenCount === 1 ? '' : 's' }} with no data hidden.</p>
        }
      }

      <!-- The working footer (beta.17 RC smoke): the page reads top
           to bottom — settings, units, tables — and ends here where
           the work completes: draft count, preview, and save. Always
           rendered while the editor is usable (appearing on the first
           draft shifted the page mid-edit, beta.13 smoke F3). -->
      <!-- Rendered with rows (including read-only preview mode, where
           Save hides but Preview works) OR whenever the editor can
           save settings with zero rows: a fresh install, or credential
           recovery before any discovery (GA review P1-2/P1-3). -->
      @if (state()!.rows.length > 0 || state()!.editorAvailable) {
        <div class="draft-bar">
          @if (draftCount() > 0) {
            <span class="grow"><strong>{{ draftCount() }}</strong> draft {{ draftCount() === 1 ? 'change' : 'changes' }}, not saved yet.</span>
          } @else {
            <span class="grow">No draft changes yet.</span>
          }
          <button type="button" (click)="preview()" [disabled]="draftCount() === 0 || previewPending() || editFormInvalid() || saving() || reloadRequired()">Preview changes</button>
          <button type="button" (click)="discardAll()" [disabled]="draftCount() === 0 || saving() || reloadRequired()">Discard drafts</button>
        </div>
      }

      @if (previewResult(); as pr) {
        <div class="preview-block" [class.previewing]="previewPending()">
        @if (pr.ok) {
          <h3>Preview</h3>
          @if ((pr.settingsChanged ?? []).length > 0) {
            <div class="banner info">{{ settingsChangedLabel(pr.settingsChanged ?? []) }}</div>
          }
          @if (pr.changes.length === 0 && pr.configOnly.length === 0 && (pr.settingsChanged ?? []).length === 0) {
            <!-- A no-op draft (e.g. a removal of something never
                 authored) previews to nothing; say so instead of a
                 bare heading over the Save bar (delta review). -->
            <div class="banner info">These drafts match the saved configuration; saving would change nothing.</div>
          }
          @if (pr.changes.length > 0) {
            @for (c of pr.changes; track c.stationMac + '|' + c.dataPoint + '|' + c.change) {
              <div class="change-row">
                <span class="change-kind {{ c.change }}">{{ c.change }}</span>
                @if (c.displayName) {
                  <span class="rename-note">tile name "{{ c.displayName.before }}" becomes "{{ c.displayName.after }}"</span>
                }
                @if (c.structural) {
                  <span class="structural-chip">{{ structuralVerb(c.change) }}</span>
                }
                <code>{{ c.dataPoint }}</code>
                <span class="station-meta">{{ c.stationMac }}</span>
                @if (c.change === 'modified') {
                  <span class="muted"> {{ changeSummary(c.before!, c.after!) }}</span>
                  <!-- Opt one row OUT of a broader change (Bruno's
                       beta.15 RC request): pins this row's changed
                       fields to their current values as a
                       station-scoped draft, then re-previews. Not
                       rendered when nothing is representably
                       pinnable (an indirect battery-ownership
                       re-registration, for example). -->
                  @if (skippableFields(c).length > 0) {
                    <button type="button" class="exclude-change" data-tip="This row keeps its current settings; everything else still changes."
                            [disabled]="previewPending() || saving() || reloadRequired()"
                            (click)="excludeChange(c)">Skip</button>
                  }
                }
                @for (note of c.notes ?? []; track $index) {
                  <div class="inline-note">{{ note }}</div>
                }
              </div>
            }
          }
          @if (pr.configOnly.length > 0) {
            <!-- Saved-configuration changes with no accessory effect
                 right now, listed so the draft count and the preview
                 visibly add up (Bruno's beta.15 RC feedback). -->
            @for (c of pr.configOnly; track c.stationMac + '|' + c.dataPoint + '|' + c.change) {
              <div class="change-row">
                <span class="change-kind {{ c.change }}">{{ c.change }}</span>
                <span class="change-kind chip-disabled" data-tip="This row is disabled, so no accessory changes now. The saved settings still change and take effect when the row is enabled.">disabled</span>
                <code>{{ c.dataPoint }}</code>
                <span class="station-meta">{{ c.stationMac }}</span>
                @if (c.change === 'modified') {
                  <span class="muted"> {{ changeSummary(c.before!, c.after!) }}</span>
                }
                @if (skippableFields(c).length > 0) {
                  <button type="button" class="exclude-change" data-tip="This row keeps its current settings; everything else still changes."
                          [disabled]="previewPending() || saving() || reloadRequired()"
                          (click)="excludeChange(c)">Skip</button>
                }
                @for (note of c.notes ?? []; track $index) {
                  <div class="inline-note">{{ note }}</div>
                }
              </div>
            }
          }
          @if (pr.changes.length > 0) {
            @if (pr.structuralChangeCount > 0) {
              <div class="banner">
                {{ pr.structuralChangeCount }} accessor{{ pr.structuralChangeCount === 1 ? 'y' : 'ies' }} would register, deregister, or re-register on save
                (a re-registered accessory may need its HomeKit room assignment redone; a deregistered one leaves HomeKit).
                @if (removedNeverReported(pr) > 0) {
                  {{ removedNeverReported(pr) }} of the removed rows {{ removedNeverReported(pr) === 1 ? 'is a sensor' : 'are sensors' }} the station has never reported: no accessory exists for {{ removedNeverReported(pr) === 1 ? 'it' : 'them' }} today, so nothing visible changes there.
                }
                This preview wrote nothing.
              </div>
            } @else {
              <div class="banner info">All changes apply in place; no accessory registers, deregisters, or re-registers. This preview wrote nothing.</div>
            }
          }
          @for (w of pr.warnings; track $index) {
            <div class="banner">{{ w.message }}</div>
          }
          @if (pr.notes.length > 0) {
            <!-- Notes matching no previewed change (row-scoped notes
                 render inline on their change rows instead,
                 beta.17 RC smoke). -->
            <h3>Worth checking before saving</h3>
            @for (n of pr.notes; track $index) {
              <div class="banner info">{{ n.message }}</div>
            }
          }
          @if (state()!.editorAvailable && pr.changes.length >= 0) {
            <div class="draft-bar">
              <span class="grow">
                @if (pr.structuralChangeCount > 0) {
                  Saving applies the {{ pr.structuralChangeCount }} registration {{ pr.structuralChangeCount === 1 ? 'change' : 'changes' }} above.
                } @else {
                  Saving applies these changes without registering or deregistering any accessory.
                }
              </span>
              <button type="button" (click)="saveClicked(pr)" [disabled]="saving() || reloadRequired()">Save changes</button>
            </div>
          }
        } @else {
          <div class="banner safe-mode">Preview refused ({{ pr.error.code }}): {{ pr.error.message }}</div>
        }
        </div>
      }
      <!-- The app's own tooltip (beta.15 RC feedback): native title
           tooltips are unusable inside HB UI X's settings modal - the
           modal's own title attribute competes and replaces them, they
           appear late, and their box cannot be styled. Any element
           with data-tip shows this instead, instantly, on hover or
           keyboard focus. position:fixed shares the viewport
           coordinate space with getBoundingClientRect, so anchoring
           is exact and no scroll container can clip it. aria-hidden:
           assistive tech already gets these texts from aria
           attributes on the anchors. -->
      @if (tip(); as t) {
        <div class="app-tip" aria-hidden="true" [style.left.px]="t.x" [style.top.px]="t.y">{{ t.text }}</div>
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
            Changes apply when the plugin restarts. Use Homebridge's
            Restart Child Bridge action for this plugin, or restart
            Homebridge. This page cannot trigger the restart itself.
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
          The page could not re-assert its save controls after the save. The save result shown here stands; reload the plugin settings page.
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

      <!-- Structural-change history, demoted from a permanent panel to
           a collapsed disclosure (beta.17, GA #56). -->
      @if (notices().length > 0 || mirrorVerified()) {
        <div class="connection notices-block">
          <button type="button" class="conn-summary" (click)="noticesOpen.set(!noticesOpen())" [attr.aria-expanded]="noticesOpen()">
            <span class="conn-caret">{{ noticesOpen() ? '\u25bc' : '\u25b6' }}</span>
            {{ notices().length > 0 ? 'Recent structural changes (' + notices().length + ')' : 'Rollback status' }}
          </button>
          @if (noticesOpen()) {
            @if (notices().length > 0) {
              <ul class="notices-list">
                @for (n of notices(); track n.id) {
                  <li><code>{{ n.dataPoint }}</code> re-registered {{ n.occurredAt.slice(0, 10) }} (structure changed)</li>
                }
              </ul>
            }
            @if (mirrorVerified()) {
              <div class="rollback-line">
                <p>Rollback mirror: verified. To go back to plugin v1.7.3 and keep the settings currently saved here:</p>
                <ol>
                  <li>In the Homebridge UI, open the JSON config editor and find this plugin's block.</li>
                  <li>Delete three entries: <code>sensorMap</code>, <code>configVersion</code>, and <code>_legacyMirror</code>.</li>
                  <li>Set <code>"_sensorMapV2": false</code> in the block (add the key if it is absent; replace its value if it is present).</li>
                  <li>If the <code>SENSOR_MAP_V2</code> environment variable is set for Homebridge, remove it or set it to <code>0</code>: a value of <code>1</code> overrides the config entry.</li>
                  <li>Install plugin version 1.7.3 and restart Homebridge.</li>
                </ol>
                <p>Do this only while this line says verified. To return to the settings you had before v2.0.0 instead, see the Rollback section of the <a href="https://github.com/bcourbage/homebridge-ambient-weather-sensors#rollback" target="_blank" rel="noopener">README</a>.</p>
              </div>
            }
          }
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

  // ---- Connection settings (beta.17, GA #56) ----
  protected readonly connectionOpen = signal(false);

  /** Fresh install: open Connection by default — it is the whole page. */
  private readonly openConnectionWhenFresh = effect(() => {
    if (this.state()?.freshInstall) {
      this.connectionOpen.set(true);
    }
  });
  protected readonly noticesOpen = signal(false);
  protected readonly notices = signal<Array<{ id: string; dataPoint: string; occurredAt: string }>>([]);
  protected settingsForm: ReturnType<FormBuilder['group']> | null = null;
  private settingsBaseline: EditorSettingsDto | null = null;
  /** Bumped on every Connection-form event so computed() re-evaluates. */
  private readonly settingsVersion = signal(0);
  /**
   * Post-save receipt failure: the reloaded on-disk block does not
   * match the digest of what /compose-save composed — the saved
   * configuration drifted between this page and disk.
   */
  protected readonly postSaveDrift = signal(false);
  /**
   * The save outcome stands, but re-asserting the page's save-control
   * state (the permanently disabled native Save) failed afterward —
   * the page is degraded and only a reload fixes it (review #47
   * round 5, P2). Never silent.
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
  /** The measurement the open assignment form last held, to detect switches that must reset the unit/trigger controls. */
  private lastAssignMeasurement = '';
  /** The source unit the open assignment form last held; a switch resets the threshold, which is stored in this unit. */
  private lastAssignSourceUnit = '';

  protected readonly draftCount = computed(() => {
    this.draftVersion();
    this.settingsVersion();
    return this.store.draftCount + this.settingsDirtyKeys().length;
  });

  /** Settings keys the form changed vs the loaded baseline (credential intents included). */
  protected settingsDirtyKeys(): string[] {
    const f = this.settingsForm;
    const b = this.settingsBaseline;
    if (!f || !b) {
      return [];
    }
    const v = f.value as Record<string, unknown>;
    const keys: string[] = [];
    if (typeof v.name === 'string' && v.name.trim() !== '' && v.name.trim() !== b.name) {
      keys.push('name');
    }
    if (v.dataSource === 'polling' || v.dataSource === 'realtime') {
      if (v.dataSource !== b.dataSource) {
        keys.push('dataSource');
      }
    }
    if (this.credentialIntent(v.apiKey, b.apiKeySet) !== null) {
      keys.push('apiKey');
    }
    if (this.credentialIntent(v.applicationKey, b.applicationKeySet) !== null) {
      keys.push('applicationKey');
    }
    const filter = this.parseStationFilter(v.stationFilter);
    if (JSON.stringify(filter) !== JSON.stringify(b.stationFilter)) {
      keys.push('stationFilter');
    }
    const interval = v.embedInterval;
    const baselineInterval = b.embedNameUpdateMinIntervalMinutes;
    if (interval === null || interval === '' || interval === undefined) {
      if (baselineInterval !== undefined) {
        keys.push('embedNameUpdateMinIntervalMinutes');
      }
    } else if (typeof interval === 'number' && interval !== baselineInterval) {
      keys.push('embedNameUpdateMinIntervalMinutes');
    }
    return keys;
  }

  private parseStationFilter(raw: unknown): string[] {
    return typeof raw === 'string'
      ? raw.split('\n').map(e => e.trim()).filter(e => e !== '')
      : [];
  }

  /**
   * The settings portion of a save/preview payload, or undefined for a
   * sensor-only save. Credential fields become INTENTS: text entered =
   * replace, checkbox = clear, both blank = the key is absent and the
   * stored secret is untouched.
   */
  protected settingsPatch(): Record<string, unknown> | undefined {
    const keys = this.settingsDirtyKeys();
    if (keys.length === 0 || !this.settingsForm) {
      return undefined;
    }
    const v = this.settingsForm.value as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (keys.includes('name')) {
      patch.name = (v.name as string).trim();
    }
    if (keys.includes('dataSource')) {
      patch.dataSource = v.dataSource;
    }
    if (keys.includes('apiKey')) {
      patch.apiKey = this.credentialIntent(v.apiKey, this.settingsBaseline!.apiKeySet)!;
    }
    if (keys.includes('applicationKey')) {
      patch.applicationKey = this.credentialIntent(v.applicationKey, this.settingsBaseline!.applicationKeySet)!;
    }
    if (keys.includes('stationFilter')) {
      patch.stationFilter = this.parseStationFilter(v.stationFilter);
    }
    if (keys.includes('embedNameUpdateMinIntervalMinutes')) {
      const interval = v.embedInterval;
      patch.embedNameUpdateMinIntervalMinutes =
        (interval === null || interval === '' || interval === undefined) ? null : interval;
    }
    return patch;
  }

  /**
   * The credential intent a field's current text expresses, or null
   * for unchanged: the untouched mask (stored key) or untouched empty
   * (no stored key) is unchanged; empty over a stored key clears;
   * anything else replaces.
   */
  private credentialIntent(raw: unknown, isSet: boolean): { set: string } | { clear: true } | null {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (isSet) {
      if (text === AwnRootComponent.CREDENTIAL_MASK) {
        return null;
      }
      if (text === '') {
        return { clear: true };
      }
      return { set: text };
    }
    return text === '' ? null : { set: text };
  }

  /** Status chips for the Connection summary row. */
  protected connectionChips(): Array<{ label: string; tone: 'ok' | 'bad' | 'plain' }> {
    const st = this.state()?.settings;
    if (!st) {
      return [];
    }
    const chips: Array<{ label: string; tone: 'ok' | 'bad' | 'plain' }> = [
      { label: st.dataSource === 'realtime' ? 'Realtime' : 'Polling', tone: 'plain' },
      st.apiKeySet
        ? { label: 'API key set', tone: 'ok' }
        : { label: 'API key missing', tone: 'bad' },
      st.applicationKeySet
        ? { label: 'Application key set', tone: 'ok' }
        : { label: 'Application key missing', tone: 'bad' },
    ];
    if (st.stationFilter.length > 0) {
      chips.push({
        label: st.stationFilter.length === 1
          ? 'Filtered to 1 station entry'
          : `Filtered to ${st.stationFilter.length} station entries`,
        tone: 'plain',
      });
    }
    return chips;
  }

  /** Inline validation message for the Connection form; non-null blocks Preview. */
  protected settingsError(): string | null {
    this.settingsVersion();
    const f = this.settingsForm;
    if (!f || !this.settingsBaseline) {
      return null;
    }
    const v = f.value as Record<string, unknown>;
    if (typeof v.name === 'string' && v.name.trim() === '' && this.settingsBaseline.name !== '') {
      return 'Name cannot be blank. Restore a value.';
    }
    const interval = v.embedInterval;
    if (interval !== null && interval !== '' && interval !== undefined
      && (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0)) {
      return 'The embed-name interval must be zero or a positive number of minutes.';
    }
    return null;
  }

  protected settingsLocked(): boolean {
    return !(this.state()?.editorAvailable ?? false) || this.saving() || this.reloadRequired();
  }

  protected settingsChangedLabel(keys: string[]): string {
    const labels: Record<string, string> = {
      name: 'name',
      dataSource: 'data source',
      apiKey: 'API key',
      applicationKey: 'application key',
      stationFilter: 'station filter',
      embedNameUpdateMinIntervalMinutes: 'embed-name interval',
    };
    return 'Settings saved with this change: ' + keys.map(k => labels[k] ?? k).join(', ') + '.';
  }

  /**
   * The mask a STORED credential renders as (never the real value).
   * Field semantics (beta.17 RC smoke): untouched mask = unchanged;
   * emptied = explicit clear; any other text = replacement.
   */
  protected static readonly CREDENTIAL_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

  /**
   * Focusing a credential field that still shows the pristine mask
   * selects it whole, so typing REPLACES the mask instead of
   * appending invisible bullets to it (delta review P2-2: an appended
   * key would save literal mask characters and fail AWN auth
   * silently). Blurring without typing keeps the mask = unchanged.
   */
  protected selectPristineMask(event: FocusEvent): void {
    const input = event.target as HTMLInputElement;
    if (input.value === AwnRootComponent.CREDENTIAL_MASK) {
      input.select();
    }
  }

  private buildSettingsForm(): void {
    const st = this.state()?.settings;
    if (!st) {
      return;
    }
    this.settingsBaseline = st;
    const MASK = AwnRootComponent.CREDENTIAL_MASK;
    this.settingsForm = this.fb.group({
      name: [st.name],
      dataSource: [st.dataSource],
      apiKey: [st.apiKeySet ? MASK : ''],
      applicationKey: [st.applicationKeySet ? MASK : ''],
      stationFilter: [st.stationFilter.join('\n')],
      embedInterval: [st.embedNameUpdateMinIntervalMinutes ?? null],
    });
    this.settingsForm.valueChanges.subscribe(() => {
      this.settingsVersion.update(x => x + 1);
      // A settings edit invalidates a shown preview like any draft.
      this.previewResult.set(null);
      this.saveResult.set(null);
      this.syncSettingsControlState();
    });
    this.settingsVersion.update(x => x + 1);
    this.syncSettingsControlState();
  }

  /**
   * Reactive forms override attribute-level disabling, so control
   * state is driven here: the whole form locks on read-only pages
   * and during saves.
   */
  protected syncSettingsControlState(): void {
    const f = this.settingsForm;
    if (!f) {
      return;
    }
    if (this.settingsLocked()) {
      if (f.enabled) {
        f.disable({ emitEvent: false });
      }
      return;
    }
    if (f.disabled) {
      f.enable({ emitEvent: false });
    }
  }

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
    // Load-bearing rows stay visible under the filter (review P2-3):
    // a row with pending drafts, an open editor, or an attached note
    // must never disappear while its state still drives the page.
    const hide = this.hideNoData();
    this.draftVersion();
    this.expandedKey();
    // Proposal-affecting means EITHER layer (review round-2 P2): a
    // family unit choice drafts under the global key while a
    // default-origin row's own edits draft station-scoped.
    const hidable = (r: EditorRowDto): boolean =>
      this.neverReported(r) && !this.isExpanded(r)
      && !this.store.hasDraftFor(undefined, r.dataPoint)
      && !this.store.hasDraftFor(r.stationMac, r.dataPoint)
      && this.rowNotes(r).length === 0;
    return [...byMac.entries()]
      .map(([mac, rows]) => {
        const station = stationByMac.get(mac);
        const visible = hide ? rows.filter(r => !hidable(r)) : rows;
        return {
          mac,
          title: station?.name || 'Station',
          source: station?.source ?? 'override',
          rows: visible,
          hiddenCount: rows.length - visible.length,
        };
      })
      .filter(g => g.rows.length > 0 || g.hiddenCount > 0);
  });

  /** Display filter: hide never-reported rows from the tables. A
   * per-viewer preference, restored across page loads and saves;
   * storage can be absent (private window, blocked site data), so
   * both sides fail soft. */
  protected readonly hideNoData = signal<boolean>((() => {
    try {
      return localStorage.getItem('awn.hideNoData') === '1';
    } catch {
      return false;
    }
  })());

  protected setHideNoData(checked: boolean): void {
    this.hideNoData.set(checked);
    try {
      localStorage.setItem('awn.hideNoData', checked ? '1' : '0');
    } catch { /* per-viewer convenience only */ }
  }

  /** Whether the filter checkbox has anything to act on. */
  protected readonly anyNeverReported = computed<boolean>(() =>
    (this.state()?.rows ?? []).some(r => this.neverReported(r)));

  constructor() {
    // Keep the Connection form's control state in sync with the page
    // locks (reactive forms ignore attribute-level disabling).
    effect(() => {
      this.saving();
      this.reloadRequired();
      this.state();
      this.syncSettingsControlState();
    });
    if (this.hb.available) {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    try {
      const cachedAccessoryUniqueIds = await this.hb.cachedAccessoryUniqueIds();
      const [state, vocab] = await Promise.all([
        // A failed cache read sends NO key (review round-2 P1): the
        // server takes a missing snapshot as unknown, never as empty.
        this.hb.request<EditorStateDto>('/editor-state',
          cachedAccessoryUniqueIds !== undefined ? { cachedAccessoryUniqueIds } : {}),
        this.hb.request<VocabularyDto>('/vocabulary'),
      ]);
      this.state.set(state);
      this.vocab.set(vocab);
      this.buildSettingsForm();
      void this.hb.request<{ notices?: Array<{ id: string; dataPoint: string; occurredAt: string }> }>('/notices')
        .then(n => this.notices.set(Array.isArray(n?.notices) ? n.notices : []))
        .catch(() => this.notices.set([]));
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

  /** The in-page tooltip's state: text plus a viewport anchor. */
  protected readonly tip = signal<{ text: string; x: number; y: number } | null>(null);

  protected tipShow(ev: Event): void {
    const anchor = (ev.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
    const text = anchor?.getAttribute('data-tip');
    if (!anchor || !text) {
      return;
    }
    const r = anchor.getBoundingClientRect();
    const maxWidth = 340;
    const x = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - maxWidth - 12));
    this.tip.set({ text, x, y: r.bottom + 6 });
  }

  protected tipHide(ev?: Event): void {
    if (ev) {
      const from = (ev.target as HTMLElement).closest?.('[data-tip]');
      const to = ((ev as MouseEvent).relatedTarget as HTMLElement | null)?.closest?.('[data-tip]');
      if (!from || from === to) {
        return; // not leaving an anchor, or moving within the same one
      }
    }
    this.tip.set(null);
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
    // For an unrecognized row being assigned, the measurement lives in
    // the open form rather than on the row.
    const m = row.measurement ?? (this.isExpanded(row) ? this.assignedMeasurement() : '');
    if (!m) {
      return [];
    }
    return this.vocab()?.measurements[m]?.extendedDisplay ?? [];
  }

  // ---- Unrecognized-row assignment (PR E) ------------------------

  /** The (kind, measurement) pairs the wrapper table can build — server-projected, never decided here. */
  protected assignmentOptions(): AssignmentOptionDto[] {
    return this.vocab()?.assignments ?? [];
  }

  protected assignmentFor(measurement: unknown): AssignmentOptionDto | undefined {
    return typeof measurement === 'string' && measurement !== ''
      ? this.assignmentOptions().find(a => a.measurement === measurement)
      : undefined;
  }

  /** The open form's measurement choice ('' before one is made). */
  protected assignedMeasurement(): string {
    const v = this.editForm?.get('measurement')?.value as unknown;
    return typeof v === 'string' ? v : '';
  }

  protected assignSourceOptions(): UnitOptionDto[] {
    const m = this.assignedMeasurement();
    return m ? (this.vocab()?.measurements[m]?.customSource ?? []) : [];
  }

  /** Label of the accessory kind the chosen measurement produces, for the form's fact line. */
  protected assignedKindLabel(): string | null {
    const opt = this.assignmentFor(this.assignedMeasurement());
    if (!opt) {
      return null;
    }
    return (KIND_SUPPORT as Record<string, { label: string }>)[opt.kind]?.label ?? opt.kind;
  }

  /** The message shown while the assignment is incomplete (the state that blocks Preview). */
  protected assignError(): string | null {
    if (!this.editForm) {
      return null;
    }
    const m = this.assignedMeasurement();
    if (m === '') {
      return 'Choose a measurement to assign this field, or Cancel.';
    }
    if (this.assignSourceOptions().length > 0) {
      const su = this.editForm.get('sourceUnit')?.value as unknown;
      if (typeof su !== 'string' || su === '') {
        return 'Choose the unit the station reports this field in, or Cancel.';
      }
    }
    return null;
  }

  /**
   * Mirrors resolveRow's measurement-aware trigger default: pressure
   * and distance alarm LOW (storm incoming, strike nearby); everything
   * else alarms high. The form preselects it and applyEdit treats it
   * as the original, so an untouched default is never authored.
   */
  protected assignmentDefaultDirection(measurement: unknown): 'above' | 'below' {
    return measurement === 'pressure' || measurement === 'distance' ? 'below' : 'above';
  }

  /** The row's kind for form gating: the drafted assignment's kind while an unrecognized row's editor is open. */
  protected effectiveKind(row: EditorRowDto): string {
    if (row.kind !== 'unrecognized') {
      return row.kind;
    }
    if (!this.isExpanded(row)) {
      return 'unrecognized';
    }
    return this.assignmentFor(this.assignedMeasurement())?.kind ?? 'unrecognized';
  }

  /**
   * Whether a measurement's rows can cross a threshold, per the
   * server's projection of the validator's non-triggering strip
   * (PR #57 review F3). Unknown measurements default to true — the
   * server list covers every motion measurement, and the gate below
   * also requires kind motion.
   */
  protected triggeringFor(measurement: string | undefined): boolean {
    if (!measurement) {
      return true;
    }
    return this.assignmentOptions().find(a => a.measurement === measurement)?.triggering ?? true;
  }

  /**
   * The one gate for threshold and trigger controls, row editors and
   * assignments alike: motion kind AND a triggering measurement.
   * Direction and timestamp rows are kind motion but hardcode
   * threshold Infinity; the validator warn-strips trigger fields on
   * them, so the editor never offers controls the save would nullify.
   */
  protected showsTriggerControls(row: EditorRowDto): boolean {
    if (this.effectiveKind(row) !== 'motion') {
      return false;
    }
    const measurement = row.kind === 'unrecognized' ? this.assignedMeasurement() : row.measurement;
    return this.triggeringFor(measurement);
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

  /**
   * Current-state notes that concern THIS row (matched by station +
   * data point), rendered inline under it in the station table
   * (beta.17 RC smoke: same rule as preview notes). Deduplicated:
   * identical messages for the same row collapse to one.
   */
  protected rowNotes(row: EditorRowDto): string[] {
    const out: string[] = [];
    for (const n of this.state()?.notes ?? []) {
      if (n.stationMac !== undefined && n.dataPoint !== undefined
        && n.stationMac.toUpperCase() === row.stationMac.toUpperCase()
        && n.dataPoint === row.dataPoint
        && !out.includes(n.message)) {
        out.push(n.message);
      }
    }
    return out;
  }

  /** Current-state notes matching NO row on the page (top section). */
  protected residualStateNotes(): EditorDiagnosticDto[] {
    const state = this.state();
    if (!state) {
      return [];
    }
    return state.notes.filter(n =>
      n.stationMac === undefined || n.dataPoint === undefined
      || !state.rows.some(r =>
        r.stationMac.toUpperCase() === n.stationMac!.toUpperCase() && r.dataPoint === n.dataPoint));
  }

  /** The verified-positive rollback state (the notices disclosure line). */
  protected mirrorVerified(): boolean {
    const st = this.state();
    return !!st && st.configMode === 'v2' && st.mirrorState === 'recognized';
  }

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
    this.openRowEditor(row, (field: DraftableField): unknown =>
      this.store.draftedValue(row, field) ?? (row as unknown as Record<string, unknown>)[field]);
  }

  /**
   * Build (or rebuild) the row editor seeded by `current`. toggleEdit
   * seeds drafts-over-row; Use Defaults reseeds the OPEN editor with
   * the default view so the form shows what the staged removals
   * produce (beta.17 RC smoke).
   */
  private openRowEditor(row: EditorRowDto, current: (field: DraftableField) => unknown): void {
    const isAssign = row.kind === 'unrecognized';
    const draftedMeasurement = typeof current('measurement') === 'string' ? current('measurement') as string : '';
    // Blank-control policy (review #43 round 2): a blanked required
    // value is an INVALID form state — inline error, Preview blocked —
    // never a silent no-draft. `name` is always required; `threshold`
    // is required exactly when the row currently displays one (a
    // threshold-less row may stay blank; removing an authored value
    // is Use defaults' job, and a default-sourced value cannot be
    // removed by an override at all). An unrecognized row's form
    // additionally carries measurement + sourceUnit, and the group
    // validator holds the form invalid until the identity is complete
    // (measurement chosen, plus a source unit when the measurement is
    // numeric) — the same policy, applied to the assignment.
    this.lastAssignMeasurement = draftedMeasurement;
    this.lastAssignSourceUnit = typeof current('sourceUnit') === 'string' ? current('sourceUnit') as string : '';
    this.editForm = this.fb.group({
      ...(isAssign ? {
        measurement: [draftedMeasurement],
        sourceUnit: [typeof current('sourceUnit') === 'string' ? current('sourceUnit') : ''],
      } : {}),
      // The unrecognized row's `enabled: false` is a sentinel (nothing
      // registers), not a setting — only a DRAFT can say otherwise,
      // and a fresh assignment defaults ON.
      enabled: [isAssign ? (this.store.draftedValue(row, 'enabled') ?? true) === true : current('enabled') === true],
      name: [
        typeof current('name') === 'string' ? current('name') : (isAssign ? row.dataPoint : ''),
        Validators.required,
      ],
      displayUnit: [typeof current('displayUnit') === 'string' ? current('displayUnit') : ''],
      threshold: [
        typeof current('threshold') === 'number' ? current('threshold') : null,
        typeof current('threshold') === 'number' ? Validators.required : [],
      ],
      triggerDirection: [
        current('triggerDirection') === 'below' ? 'below'
          : current('triggerDirection') === 'above' ? 'above'
            : this.assignmentDefaultDirection(draftedMeasurement),
      ],
    }, isAssign ? {
      validators: [(g: AbstractControl): { assignIncomplete: true } | null => {
        const m = g.get('measurement')?.value as unknown;
        if (typeof m !== 'string' || m === '') {
          return { assignIncomplete: true };
        }
        const needsSource = (this.vocab()?.measurements[m]?.customSource ?? []).length > 0;
        const su = g.get('sourceUnit')?.value as unknown;
        return needsSource && (typeof su !== 'string' || su === '') ? { assignIncomplete: true } : null;
      }],
    } : {});
    this.editFormInvalid.set(this.editForm.invalid);
    this.editForm.valueChanges.subscribe((v: Record<string, unknown>) => {
      if (isAssign && v.measurement !== this.lastAssignMeasurement) {
        // A measurement switch invalidates every measurement-scoped
        // choice: the previous units would be illegal for the new
        // measurement, and the trigger default is measurement-aware
        // (pressure/distance alarm LOW, mirroring resolveRow).
        this.lastAssignMeasurement = typeof v.measurement === 'string' ? v.measurement : '';
        const reset = {
          sourceUnit: '',
          displayUnit: '',
          threshold: null,
          triggerDirection: this.assignmentDefaultDirection(v.measurement),
        };
        this.editForm?.patchValue(reset, { emitEvent: false });
        v = { ...v, ...reset };
        this.lastAssignSourceUnit = '';
      } else if (isAssign && v.sourceUnit !== this.lastAssignSourceUnit) {
        // A source-unit switch REINTERPRETS a threshold: thresholds are
        // stored in the row's sourceUnit, so 10 with mph and 10 with
        // km/hr are different physical triggers (PR #57 review F2).
        // Reset rather than convert; the user re-enters the number in
        // the unit now shown.
        this.lastAssignSourceUnit = typeof v.sourceUnit === 'string' ? v.sourceUnit : '';
        if (typeof v.threshold === 'number') {
          this.editForm?.patchValue({ threshold: null }, { emitEvent: false });
          v = { ...v, threshold: null };
        }
      }
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
    const sync = (field: DraftableField,
      formValue: unknown, original: unknown, valid: boolean): void => {
      if (!valid || formValue === original) {
        this.store.clearField(row, field);
      } else {
        this.store.setField(row, field, formValue);
      }
    };
    if (row.kind === 'unrecognized') {
      const opt = this.assignmentFor(v.measurement);
      const needsSource = opt ? (this.vocab()?.measurements[opt.measurement]?.customSource ?? []).length > 0 : false;
      const sourceOk = !needsSource || (typeof v.sourceUnit === 'string' && v.sourceUnit !== '');
      if (!opt || !sourceOk) {
        // The identity is ATOMIC: an incomplete assignment drafts
        // nothing at all, so a partial custom fragment (which the
        // pipeline would refuse as custom-missing-*) can never be
        // composed, whatever order the controls were touched in.
        this.store.resetRow(row);
        this.bump();
        return;
      }
      this.store.setField(row, 'kind', opt.kind);
      this.store.setField(row, 'measurement', opt.measurement);
      if (needsSource) {
        this.store.setField(row, 'sourceUnit', v.sourceUnit);
      } else {
        // Timestamp rows must OMIT sourceUnit ('ms' is the contract).
        this.store.clearField(row, 'sourceUnit');
      }
      // enabled is authored explicitly in BOTH states: the unrecognized
      // row's enabled:false is a sentinel, and the resolved default for
      // an assigned row is true — syncing against the sentinel would
      // author the opposite of the user's unchecked intent.
      this.store.setField(row, 'enabled', v.enabled === true);
      sync('name', v.name, undefined, typeof v.name === 'string' && v.name !== '');
      sync('displayUnit', v.displayUnit, undefined,
        typeof v.displayUnit === 'string' && v.displayUnit !== '');
      if (opt.kind === 'motion' && this.triggeringFor(opt.measurement)) {
        sync('threshold', v.threshold, undefined, typeof v.threshold === 'number');
        sync('triggerDirection', v.triggerDirection, this.assignmentDefaultDirection(opt.measurement),
          v.triggerDirection === 'above' || v.triggerDirection === 'below');
      } else {
        this.store.clearField(row, 'threshold');
        this.store.clearField(row, 'triggerDirection');
      }
      this.bump();
      return;
    }
    // Under a staged Use Defaults removal the row's saved values are
    // no longer the baseline: a form value equal to the SAVED value
    // must still be re-authored explicitly, or the equal-looking
    // control would silently yield the removal's outcome instead of
    // what the form displays. Canonicalization prunes any re-authored
    // value that equals the default at save.
    const scopeMac = row.origin === 'global' ? undefined : row.stationMac;
    const keyRemoved = this.store.keyRemovedFor(scopeMac, row.dataPoint);
    const syncR = (field: DraftableField, formValue: unknown, original: unknown, valid: boolean): void => {
      if (valid && (keyRemoved || this.store.fieldRemovedFor(scopeMac, row.dataPoint, field))) {
        this.store.setField(row, field, formValue);
        return;
      }
      sync(field, formValue, original, valid);
    };
    syncR('enabled', v.enabled === true, row.enabled, true);
    syncR('name', v.name, row.name, typeof v.name === 'string' && v.name !== '');
    syncR('displayUnit', v.displayUnit, row.displayUnit,
      typeof v.displayUnit === 'string' && v.displayUnit !== '');
    if (row.kind === 'motion' && this.triggeringFor(row.measurement)) {
      syncR('threshold', v.threshold, row.threshold, typeof v.threshold === 'number');
      syncR('triggerDirection', v.triggerDirection, row.triggerDirection,
        v.triggerDirection === 'above' || v.triggerDirection === 'below');
    }
    this.bump();
  }

  /**
   * Authored fragments for one layer key of a row, drafts excluded.
   */
  private authoredFragmentsAt(stationMac: string | undefined, dataPoint: string): EditorAuthoredFragmentDto[] {
    return (this.state()?.authored ?? []).filter(f =>
      f.dataPoint === dataPoint
      && (stationMac === undefined
        ? f.layer === 'global'
        : f.layer === 'station' && f.stationMacKey === stationMac.toUpperCase()));
  }

  /** A recognized row this station is POSITIVELY known to have never
   * reported (review P1): the server sets everReported false only when
   * discovery HAS observed the station and neither an observation nor
   * a cached accessory exists for the field. Unknown history (fresh
   * upgrade, no discovery yet) renders no no-data affordances. */
  protected neverReported(row: EditorRowDto): boolean {
    return row.kind !== 'unrecognized' && row.everReported === false;
  }

  /** The enabled never-reported rows the station action would disable
   * (rows already draft-disabled drop out). From the UNFILTERED state
   * rows: the hide-no-data display filter must not hide the action. */
  protected noDataEnabledRows(group: StationGroup): EditorRowDto[] {
    return (this.state()?.rows ?? []).filter(row =>
      row.stationMac === group.mac && this.neverReported(row) && row.enabled
      && this.store.draftedValueFor(row.stationMac, row.dataPoint, 'enabled') !== false);
  }

  /**
   * Draft station-scoped disables for every enabled sensor this
   * station has never reported (Bruno's beta.17 RC smoke: an explicit
   * way to turn off everything the station does not deliver). Drafts
   * only; preview and save decide.
   */
  /** Removed changes whose row the station never reported: previewed
   * as structural removals by the consequence model, but no runtime
   * accessory exists (recorded debt; the banner qualifies the claim). */
  protected removedNeverReported(pr: Extract<PreviewResultDto, { ok: true }>): number {
    const state = this.state();
    if (!state) {
      return 0;
    }
    return pr.changes.filter(c => c.change === 'removed'
      && state.rows.some(r => r.stationMac.toUpperCase() === c.stationMac.toUpperCase()
        && r.dataPoint === c.dataPoint && this.neverReported(r))).length;
  }

  protected noDataTip(group: StationGroup): string {
    return this.noDataEnabledRows(group).length === 1
      ? 'This sensor has no data: the station has never reported it, so it creates no HomeKit '
        + 'accessory even while enabled. Disabling keeps it off if the station ever starts '
        + 'reporting it. Nothing saves until you preview and save.'
      : 'These sensors have no data: the station has never reported them, so they create no '
        + 'HomeKit accessories even while enabled. Disabling keeps them off if the station ever '
        + 'starts reporting them. Nothing saves until you preview and save.';
  }

  protected disableNoData(group: StationGroup): void {
    for (const row of this.noDataEnabledRows(group)) {
      // A station exception on a CUSTOM row must re-declare the
      // identity or the save boundary refuses it as an invalid
      // partial fragment (review P2-2; same rule as preview Skip).
      if (row.identityScope !== undefined && row.identityScope !== 'known') {
        const r = row as unknown as Record<string, unknown>;
        for (const idField of ['kind', 'measurement', 'sourceUnit'] as const) {
          if (r[idField] !== undefined) {
            this.store.setFieldFor(row.stationMac, row.dataPoint, idField, r[idField]);
          }
        }
      }
      this.store.setFieldFor(row.stationMac, row.dataPoint, 'enabled', false);
    }
    // An open editor could sit on an affected row showing a stale
    // Enabled control: close it (same policy as a family choice).
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    this.bump();
  }

  /** Whether a display family manages this row's display unit at the page level. */
  private familyManagesRow(row: EditorRowDto): boolean {
    return (this.vocab()?.families ?? []).some(f => this.rowInFamily(row, f));
  }

  /**
   * The fields Use Defaults would remove — station-scoped fragments
   * always; global fragments too, EXCEPT a family-managed displayUnit
   * template, which belongs to the Units panel (beta.17 RC smoke:
   * Use Defaults returns the row to what the PAGE-LEVEL settings
   * dictate, never silently changing a whole category's unit).
   * Empty means the button has nothing row-scoped to remove.
   */
  protected useDefaultsScope(row: EditorRowDto): { station: boolean; globalAll: boolean; globalFields: string[] } {
    const station = this.authoredFragmentsAt(row.stationMac, row.dataPoint).length > 0;
    const globals = this.authoredFragmentsAt(undefined, row.dataPoint);
    if (globals.length === 0) {
      return { station, globalAll: false, globalFields: [] };
    }
    const globalFieldSet = new Set<string>();
    for (const f of globals) {
      for (const k of Object.keys(f.fields)) {
        globalFieldSet.add(k);
      }
    }
    // A family-covered row NEVER takes the whole-fragment branch
    // (delta review P2-1): removeOverrideAt clears the key's pending
    // patches, and the Units panel's pending family choice is exactly
    // such a patch — field-wise stripping leaves it intact whether the
    // template is authored or still a draft. The keep-template path
    // does not apply to a fragment that authors its own identity (a
    // custom sensor): stripping around displayUnit would leave an
    // invalid kind-less fragment, so Use Defaults deletes the custom
    // sensor, as before.
    if (this.familyManagesRow(row) && !globalFieldSet.has('kind')) {
      globalFieldSet.delete('displayUnit');
      return { station, globalAll: false, globalFields: [...globalFieldSet] };
    }
    return { station, globalAll: true, globalFields: [] };
  }

  protected useDefaultsAvailable(row: EditorRowDto): boolean {
    const scope = this.useDefaultsScope(row);
    return scope.station || scope.globalAll || scope.globalFields.length > 0;
  }

  protected useDefaults(row: EditorRowDto): void {
    const scope = this.useDefaultsScope(row);
    if (scope.station) {
      this.store.removeOverrideAt(row.stationMac, row.dataPoint);
    }
    if (scope.globalAll) {
      this.store.removeOverrideAt(undefined, row.dataPoint);
    } else {
      for (const field of scope.globalFields) {
        this.store.removeFieldAt(undefined, row.dataPoint, field);
      }
    }
    if (row.defaults === undefined || row.kind === 'unrecognized') {
      // A custom or unrecognized row's default is nonexistence: close
      // the form; the staged removal deletes the row.
      this.expandedKey.set(null);
      this.editForm = null;
      this.editFormInvalid.set(false);
      this.bump();
      return;
    }
    // Reseed the OPEN editor with the values the staged removals
    // produce (Bruno's beta.17 RC smoke: Use defaults SHOWS the
    // defaults, page-level unit settings included), keeping the
    // normal sync wiring live for further edits.
    this.openRowEditor(row, (field: DraftableField): unknown => this.defaultViewValue(row, field));
    this.bump();
  }

  /**
   * The value a field returns to under Use Defaults: the pure default,
   * except displayUnit on a family-managed row, which the page-level
   * template dictates (pending Units-panel draft first, then the
   * authored template).
   */
  private defaultViewValue(row: EditorRowDto, field: DraftableField): unknown {
    const d = row.defaults;
    if (d === undefined) {
      return undefined;
    }
    if (field === 'displayUnit' && this.familyManagesRow(row)) {
      const pending = this.store.draftedValueFor(undefined, row.dataPoint, 'displayUnit');
      const authored = this.store.authoredValueFor(undefined, row.dataPoint, 'displayUnit');
      return pending ?? authored ?? d.displayUnit;
    }
    return (d as unknown as Record<string, unknown>)[field];
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
    this.buildSettingsForm();
    this.expandedKey.set(null);
    this.editForm = null;
    this.editFormInvalid.set(false);
    this.bump();
  }

  /**
   * The fields Skip can pin for a change: row fields the editor can
   * author, whose before value exists and differs. Empty means the
   * change is NOT representable as a station exception — for example
   * a row modified only through battery-ownership adjudication
   * (hasBatterySubService / structural signature) — and Skip is not
   * rendered for it (review round 6 F3).
   */
  protected skippableFields(c: { before?: EditorRowDto; after?: EditorRowDto }): DraftableField[] {
    const before = c.before;
    const after = c.after;
    if (!before || !after) {
      return [];
    }
    const candidates: DraftableField[] = ['enabled', 'name', 'displayUnit', 'threshold', 'triggerEnabled', 'triggerDirection'];
    const b = before as unknown as Record<string, unknown>;
    const a = after as unknown as Record<string, unknown>;
    return candidates.filter(field => b[field] !== a[field] && b[field] !== undefined);
  }

  /**
   * Opt one previewed row OUT of a broader change (beta.15 RC
   * request): every representable field the proposal would change on
   * this row is pinned to its CURRENT value as a station-scoped
   * draft — a normal exception, previewable and savable like any
   * edit — and the preview re-runs. A custom row's exception carries
   * the row's full identity alongside the pins: a bare station
   * fragment for a custom dataPoint is refused as custom-missing-kind
   * (review round 6 F3); for fragments that already author the
   * identity, the copies prune away as no-ops.
   */
  protected async excludeChange(c: PreviewChangeDto | ConfigOnlyChangeDto): Promise<void> {
    const before = c.before;
    const fields = this.skippableFields(c);
    if (!before || fields.length === 0) {
      return;
    }
    const b = before as unknown as Record<string, unknown>;
    if (before.identityScope !== undefined && before.identityScope !== 'known') {
      for (const idField of ['kind', 'measurement', 'sourceUnit'] as const) {
        if (b[idField] !== undefined) {
          this.store.setFieldFor(before.stationMac, c.dataPoint, idField, b[idField]);
        }
      }
    }
    for (const field of fields) {
      this.store.setFieldFor(before.stationMac, c.dataPoint, field, b[field]);
    }
    this.bump();
    await this.preview();
  }

  protected async preview(): Promise<void> {
    if (this.editFormInvalid() || this.settingsError() !== null) {
      return; // an invalid (blanked) control blocks previewing
    }
    // Bind the request to the draft version it previews (review #43
    // P2-4): inputs stay editable while the request runs, and a
    // response for an OLDER draft must never install its results (or
    // its digest) over the newer state.
    const draftVersionAtStart = this.draftVersion();
    const settingsVersionAtStart = this.settingsVersion();
    this.previewPending.set(true);
    // The PREVIOUS result stays visible (dimmed) while the request
    // runs - clearing it here rebuilt the whole list on every Skip
    // and read as flicker (Bruno's beta.15 RC feedback). A response
    // for an older draft version clears it instead of installing.
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
        settings: this.settingsPatch(),
        ...(cachedAccessoryUniqueIds !== undefined ? { cachedAccessoryUniqueIds } : {}),
      });
      if (this.draftVersion() === draftVersionAtStart && this.settingsVersion() === settingsVersionAtStart) {
        this.previewResult.set(result);
      } else {
        // Row drafts OR connection settings moved on (round 4 P2) —
        // never show a stale preview or re-arm Save under one.
        this.previewResult.set(null);
      }
    } catch (e) {
      // The SAME two-version predicate as the success path (round 5):
      // an obsolete transport error must not surface after a
      // mid-flight row or Connection edit.
      if (this.draftVersion() === draftVersionAtStart && this.settingsVersion() === settingsVersionAtStart) {
        this.previewResult.set({
          ok: false,
          error: { code: 'transport', message: e instanceof Error ? e.message : String(e) },
        });
      } else {
        this.previewResult.set(null);
      }
    } finally {
      this.previewPending.set(false);
    }
  }

  /**
   * Save entry point (PR C / finding 5): the preview IS the
   * confirmation — the user saw every consequence, could Skip rows,
   * and clicked Save (beta.17 RC smoke: a second confirm card after
   * that added nothing). The save runs EXCLUSIVELY through
   * composeAndPersist with the digest of the preview the user is
   * looking at; the server re-derives and verifies it before anything
   * is written, so a stale preview still refuses.
   */
  /** The save-outcome banner area, brought into view after a save. */
  private readonly saveOutcome = viewChild<ElementRef<HTMLElement>>('saveOutcome');

  protected saveClicked(pr: Extract<PreviewResultDto, { ok: true }>): void {
    void this.doSave(pr.digest);
  }

  private async doSave(confirmDigest: string): Promise<void> {
    if (this.saving()) {
      return; // one save transaction at a time (review P2-8)
    }
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
        settings: this.settingsPatch(),
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
  /** Plain-language accessory sentence for the row-editor facts line. */
  protected kindSentence(row: EditorRowDto): string {
    if (row.kind === 'unrecognized') {
      return 'Creates no Apple Home accessory until it is assigned.';
    }
    const entry = KIND_SUPPORT[row.kind as keyof typeof KIND_SUPPORT];
    const label = entry?.label ?? row.kind;
    if (entry !== undefined && !entry.supported) {
      return `Creates no Apple Home accessory yet: the ${label} kind is reserved for future support.`;
    }
    const reading = row.measurement !== undefined && row.measurement !== row.kind
      ? ` from the ${row.measurement.replace(/-/g, ' ')} reading`
      : '';
    return `Creates a ${label} accessory in Apple Home${reading}.`;
  }

  /** Plain-language settings-scope sentence for the facts line. A
   * row's origin names the WINNING layer, not the only one (review
   * P2-6): a station-origin row can still inherit all-stations
   * settings, so the wording claims precedence, never exclusivity. */
  protected originSentence(row: EditorRowDto): string {
    return row.origin === 'global'
      ? 'This row has settings saved for all stations.'
      : row.origin === 'station'
        ? 'This row has settings saved for this station; they win over any saved for all stations.'
        : 'This row uses the plugin defaults; nothing is saved for it.';
  }

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

  /**
   * Tooltip for the converted (blue) units cell. Illuminance-class
   * conversions are FIXED by HomeKit (CurrentAmbientLightLevel is
   * always lux), so the tooltip must not imply a unit choice exists
   * (Bruno's beta.15 RC feedback on solar radiation).
   */
  protected convertedTip(row: EditorRowDto): string {
    const base = `Converted from ${this.unitLabel(row.sourceUnit)}.`;
    const nativeDisplay = row.measurement !== undefined
      && (this.vocab()?.measurements[row.measurement]?.extendedDisplay ?? []).length === 0;
    return nativeDisplay
      ? `${base} Apple Home always displays this kind in ${this.unitLabel(row.displayUnit)}; there is no unit choice.`
      : base;
  }

  /**
   * Tooltip for the plain (unconverted) units cell. For natively
   * displayed kinds the shown unit is what the STATION reports; the
   * display format belongs to each Apple device (Bruno's beta.15 RC
   * question: "why does temperature show a unit").
   */
  protected unitCellTitle(row: EditorRowDto): string {
    if (!row.sourceUnit || !row.measurement) {
      return '';
    }
    const nativeDisplay = (this.vocab()?.measurements[row.measurement]?.extendedDisplay ?? []).length === 0;
    return nativeDisplay
      ? 'The unit the station reports. Apple Home chooses the display format on each device.'
      : 'The default display: the unit the station reports. A blue value means the row converts to a different display unit.';
  }

  /** A row whose HomeKit display unit differs from the AWN source unit. */
  protected isConverted(row: EditorRowDto): boolean {
    return !!row.sourceUnit && !!row.displayUnit && row.displayUnit !== row.sourceUnit;
  }
}

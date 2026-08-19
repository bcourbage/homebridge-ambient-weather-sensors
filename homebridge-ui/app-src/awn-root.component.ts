/**
 * Read-only sensor-map viewer (GA task #69, PR A) — the editor
 * foundation. Renders the sanitized /editor-state read model grouped
 * by station, with unit labels from /vocabulary (#70). No writes of
 * any kind: editing arrives in PR B (draft state + preview protocol)
 * and persistence only in PR C through composeAndPersist.
 *
 * Styling deliberately leans on the fragment page's #awn scope: this
 * component renders inside <div id="awn">, so the page's table rules
 * and theme variables (light + dark) apply to it as-is. Component
 * styles below add only what the page doesn't define.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { HomebridgeService } from './homebridge.service';
import type { EditorRowDto, EditorStateDto, VocabularyDto } from './dto/editor-state';

interface StationGroup {
  mac: string;
  title: string;
  source: string;
  rows: EditorRowDto[];
}

@Component({
  selector: 'awn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
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
  `,
  template: `
    <h2>Sensor map <span class="station-meta">read-only preview</span></h2>
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
      <!-- Diagnostics tracked by index: messages are not unique
           (multiple rows can produce identical text), and index is the
           stable identity for a server-refreshed list. -->
      @for (w of state()!.warnings; track $index) {
        <div class="banner">{{ w.message }}</div>
      }
      @for (e of state()!.errors; track $index) {
        <div class="banner safe-mode">{{ e.message }}</div>
      }
      <!-- Ownership/plugin-health notes (orphan battery fields,
           collision ordering) are a distinct channel from warnings:
           informational, but users must see them to understand why an
           accessory lacks its Battery service. -->
      @if (state()!.notes.length > 0) {
        <h2>Notes</h2>
        @for (n of state()!.notes; track $index) {
          <div class="banner info">{{ n.message }}</div>
        }
      }
      @if (groups().length === 0) {
        <p class="empty">No stations or sensor rows to show yet.</p>
      }
      @for (group of groups(); track group.mac) {
        <h2>
          {{ group.title }}
          <span class="station-meta"><code>{{ group.mac }}</code> · {{ group.source }}</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Data point</th><th>Name</th><th>Kind</th><th>Units</th>
              <th>Enabled</th><th>Layer</th><th>Battery</th>
            </tr>
          </thead>
          <tbody>
            @for (row of group.rows; track row.dataPoint) {
              <tr>
                <td><code>{{ row.dataPoint }}</code></td>
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
              </tr>
            }
          </tbody>
        </table>
      }
    }
  `,
})
export class AwnRootComponent {
  private readonly hb = inject(HomebridgeService);

  protected readonly available = this.hb.available;
  protected readonly state = signal<EditorStateDto | undefined>(undefined);
  protected readonly vocab = signal<VocabularyDto | undefined>(undefined);
  protected readonly loadError = signal<string | undefined>(undefined);

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
      // Cached-accessory uniqueIds are a client-only §8.7 inventory
      // source (review #32 F1): a typical 1.7.x install has cached
      // accessories but no discovery.json yet, and without them the
      // migration preview would render empty.
      const cachedAccessoryUniqueIds = await this.hb.cachedAccessoryUniqueIds();
      const [state, vocab] = await Promise.all([
        this.hb.request<EditorStateDto>('/editor-state', { cachedAccessoryUniqueIds }),
        this.hb.request<VocabularyDto>('/vocabulary'),
      ]);
      this.state.set(state);
      this.vocab.set(vocab);
    } catch (e) {
      this.loadError.set(e instanceof Error ? e.message : String(e));
    }
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

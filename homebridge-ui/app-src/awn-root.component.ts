/**
 * Root component — PR A carries the read-only editor foundation. The
 * grouped row table arrives in the read-only spike step; this initial
 * revision proves the packaging pipeline (fragment mount, committed
 * hashed assets, theme inheritance) end to end.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

@Component({
  selector: 'awn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ready()) {
      <section class="awn-editor-shell">
        <h2>Sensor-map editor (preview)</h2>
        <p class="text-muted">
          Read-only foundation — the editor ships in a later beta. The
          observation panels above remain the live view.
        </p>
      </section>
    }
  `,
})
export class AwnRootComponent {
  protected readonly ready = signal(true);
}

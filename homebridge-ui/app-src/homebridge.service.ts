/**
 * Adapter between the Angular app and the `homebridge` global that
 * HB UI X's plugin-ui-utils client injects into this iframe. The rest
 * of the app never touches `window.homebridge` directly — components
 * depend on this service, which keeps them testable and confines the
 * "is the bridge actually there?" question to one place.
 *
 * Theme: HB UI X toggles a `dark-mode` class on <body> when the parent
 * theme changes (and injects its own stylesheet). The `darkMode`
 * signal mirrors that class via a MutationObserver, so components can
 * react without their own DOM plumbing. The injected sheet plus the
 * fragment's #awn CSS variables handle most styling; the signal exists
 * for the cases CSS can't express.
 */
import { DOCUMENT, Injectable, inject, signal } from '@angular/core';

/**
 * The subset of plugin-ui-utils' client API the editor uses. Declared
 * here (not imported from @homebridge/plugin-ui-utils) so the browser
 * bundle has no dependency on the server-oriented package layout.
 */
export interface HomebridgeIpc {
  request(path: string, body?: unknown): Promise<unknown>;
  getPluginConfig(): Promise<unknown[]>;
}

@Injectable({ providedIn: 'root' })
export class HomebridgeService {
  private readonly document = inject(DOCUMENT);
  private readonly ipc: HomebridgeIpc | undefined = (
    this.document.defaultView as (Window & { homebridge?: HomebridgeIpc }) | null
  )?.homebridge;

  /**
   * False when the page is opened outside HB UI X (direct file open,
   * tests) — the app renders a plain notice instead of crashing.
   */
  readonly available: boolean = this.ipc !== undefined;

  /** Mirrors HB UI X's `dark-mode` body class. */
  readonly darkMode = signal(this.document.body.classList.contains('dark-mode'));

  constructor() {
    // Root-provided service: lives for the iframe's lifetime, so the
    // observer is intentionally never disconnected.
    new MutationObserver(() => {
      this.darkMode.set(this.document.body.classList.contains('dark-mode'));
    }).observe(this.document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /**
   * Typed request to a server-bridge endpoint. T is asserted, not
   * validated — the bridge is the same package at the same version,
   * and the read-only UI degrades to empty panels on shape surprises.
   */
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!this.ipc) {
      throw new Error('homebridge bridge is not available outside HB UI X');
    }
    return (await this.ipc.request(path, body)) as T;
  }
}

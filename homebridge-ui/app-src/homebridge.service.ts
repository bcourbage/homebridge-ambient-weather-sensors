/**
 * Adapter between the Angular app and the `homebridge` global that
 * HB UI X's plugin-ui-utils client injects into this iframe. The rest
 * of the app never touches `window.homebridge` directly — components
 * depend on this service, which keeps them testable and confines the
 * "is the bridge actually there?" question to one place.
 *
 * Theme: at iframe INIT, HB UI X posts its theme body classes
 * (`config-ui-x-<theme>`, `dark-mode` when dark) and mirrors its
 * stylesheets into this iframe — but it never posts again on a LIVE
 * theme change, and plugin-ui-utils' body-class handler is add-only
 * (classList.add, no removal). Result without intervention: switching
 * the parent theme leaves this page rendered in the OLD theme until
 * it is reopened (observed on v2.0.0-beta.8).
 *
 * The custom UI iframe is same-origin with HB UI X, so this service
 * fixes that locally: it observes the PARENT document's body classes
 * and mirrors the theme-bearing ones (`dark-mode`, `config-ui-x-*`)
 * onto our body — adding AND removing. The mirrored stylesheets are
 * theme-agnostic (palettes are class-scoped), so class sync alone
 * switches the palette. Cross-origin embedding (if HB UI X ever
 * changes serving) degrades gracefully to the init-time snapshot.
 *
 * The `darkMode` signal mirrors OUR body class via a second observer,
 * so components can react without their own DOM plumbing.
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
    // observers are intentionally never disconnected.
    new MutationObserver(() => {
      this.darkMode.set(this.document.body.classList.contains('dark-mode'));
    }).observe(this.document.body, { attributes: true, attributeFilter: ['class'] });
    this.mirrorParentTheme();
  }

  private static isThemeClass(c: string): boolean {
    return c === 'dark-mode' || c.startsWith('config-ui-x-');
  }

  private mirrorParentTheme(): void {
    let parentBody: HTMLElement | null;
    try {
      const win = this.document.defaultView;
      parentBody = win && win.parent !== win ? win.parent.document.body : null;
    } catch {
      return; // cross-origin parent: keep the init-time snapshot
    }
    if (!parentBody) {
      return;
    }
    const sync = (): void => {
      const theirs = parentBody!.classList;
      const ours = this.document.body.classList;
      for (const c of [...ours]) {
        if (HomebridgeService.isThemeClass(c) && !theirs.contains(c)) {
          ours.remove(c);
        }
      }
      for (const c of [...theirs]) {
        if (HomebridgeService.isThemeClass(c) && !ours.contains(c)) {
          ours.add(c);
        }
      }
    };
    new MutationObserver(sync).observe(parentBody, { attributes: true, attributeFilter: ['class'] });
    sync();
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

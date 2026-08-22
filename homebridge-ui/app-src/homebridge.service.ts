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
import { DOCUMENT, Injectable, InjectionToken, inject, signal } from '@angular/core';

/**
 * The subset of plugin-ui-utils' client API the editor uses. Declared
 * here (not imported from @homebridge/plugin-ui-utils) so the browser
 * bundle has no dependency on the server-oriented package layout.
 */
export interface HomebridgeIpc {
  request(path: string, body?: unknown): Promise<unknown>;
  getPluginConfig(): Promise<unknown[]>;
  /** §8.7 inventory source 3 — cached HomeKit accessories. */
  getCachedAccessories?(): Promise<unknown[]>;
  /**
   * Persistence half of the save boundary (PR C). Optional in the
   * interface so read-only fakes physically cannot persist; the save
   * path requires both and fails closed when either is absent.
   */
  updatePluginConfig?(config: unknown[]): Promise<unknown>;
  savePluginConfig?(): Promise<unknown>;
  /**
   * Settings-form freeze surface (review #47 round 3, P1): the save
   * orchestrator disables HB UI X's Save button and hides the schema
   * form for the duration of a save so no form edit can race the
   * persistence. Optional — older bridges without them still get the
   * orchestrator's re-read backstop.
   */
  disableSaveButton?(): void;
  enableSaveButton?(): void;
  hideSchemaForm?(): void;
  showSchemaForm?(): void;
}

/**
 * Injection seam for the bridge global: production resolves
 * `window.homebridge`; tests provide a fake.
 */
export const HOMEBRIDGE_IPC = new InjectionToken<HomebridgeIpc | undefined>('HOMEBRIDGE_IPC', {
  providedIn: 'root',
  factory: () => (
    inject(DOCUMENT).defaultView as (Window & { homebridge?: HomebridgeIpc }) | null
  )?.homebridge,
});

/** Is this class one of HB UI X's theme-bearing body classes? */
export function isThemeClass(c: string): boolean {
  return c === 'dark-mode' || c.startsWith('config-ui-x-');
}

/**
 * One-shot reconciliation: make `ours`' theme classes equal `theirs`'
 * — adding AND removing (the removal half is exactly what
 * plugin-ui-utils' add-only handler lacks). Non-theme classes on
 * either side are left alone.
 */
export function syncThemeClasses(theirs: DOMTokenList, ours: DOMTokenList): void {
  for (const c of Array.from(ours)) {
    if (isThemeClass(c) && !theirs.contains(c)) {
      ours.remove(c);
    }
  }
  for (const c of Array.from(theirs)) {
    if (isThemeClass(c) && !ours.contains(c)) {
      ours.add(c);
    }
  }
}

/**
 * Continuous mirror: observe `parentBody`'s class attribute and keep
 * `ownBody`'s theme classes in sync (initial sync included). Returns
 * the observer so callers with a bounded lifetime can disconnect.
 */
export function observeParentTheme(parentBody: HTMLElement, ownBody: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => syncThemeClasses(parentBody.classList, ownBody.classList));
  observer.observe(parentBody, { attributes: true, attributeFilter: ['class'] });
  syncThemeClasses(parentBody.classList, ownBody.classList);
  return observer;
}

@Injectable({ providedIn: 'root' })
export class HomebridgeService {
  private readonly document = inject(DOCUMENT);
  private readonly ipc = inject(HOMEBRIDGE_IPC);

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
    observeParentTheme(parentBody, this.document.body);
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

  /**
   * The plugin's config block as HB UI X's client API sees it — the
   * `base` for /preview-save's staleness check. First block only:
   * duplicate-block configs are already flagged by /editor-state and
   * refused at the boundary.
   */
  /** Reload the iframe (seam so tests can observe without navigating). */
  reloadWindow(): void {
    this.document.defaultView?.location.reload();
  }

  /**
   * Dependency bundle for composeAndPersist — the ONE save route
   * (PR C / finding 5). Throws when the bridge lacks the persistence
   * API rather than degrading: a save must never silently no-op.
   */
  orchestratorDeps(): {
    request(path: string, payload?: unknown): Promise<unknown>;
    getPluginConfig(): Promise<Array<Record<string, unknown>>>;
    updatePluginConfig(config: Array<Record<string, unknown>>): Promise<unknown>;
    savePluginConfig(): Promise<unknown>;
    freezeSettingsForm(): void;
    unfreezeSettingsForm(): void;
    getCachedAccessories?(): Promise<unknown[]>;
  } {
    const ipc = this.ipc;
    if (!ipc || !ipc.updatePluginConfig || !ipc.savePluginConfig) {
      throw new Error('This Homebridge UI does not expose the config persistence API; saving is unavailable.');
    }
    // The Save-button freeze is part of the save's correctness (a
    // missing control would let a mid-save form edit PERSIST), so a
    // bridge without both controls cannot save — fail closed exactly
    // like the missing persistence API above (review #47 round 4,
    // P1). The form itself is NOT hidden: HB UI X binds the schema
    // form two-way into pluginConfig[0], and destroying the form
    // writes undefined through that binding, zeroing the session's
    // config (measured on production — every later read saw zero
    // blocks). Mid-save form EDITS are handled by the orchestrator's
    // re-read refusal instead.
    if (!ipc.disableSaveButton || !ipc.enableSaveButton) {
      throw new Error('This Homebridge UI does not expose the Save button controls; saving is unavailable.');
    }
    return {
      request: (path, payload) => ipc.request(path, payload),
      getPluginConfig: () => ipc.getPluginConfig() as Promise<Array<Record<string, unknown>>>,
      updatePluginConfig: (config) => ipc.updatePluginConfig!(config),
      savePluginConfig: () => ipc.savePluginConfig!(),
      freezeSettingsForm: () => {
        ipc.disableSaveButton!();
      },
      unfreezeSettingsForm: () => {
        ipc.enableSaveButton!();
      },
      ...(ipc.getCachedAccessories
        ? { getCachedAccessories: () => ipc.getCachedAccessories!() }
        : {}),
    };
  }

  /**
   * Cached-accessory uniqueIds for §8.7 inventory (review #32 F1) —
   * the SAME extraction the save orchestrator uses, so /editor-state
   * and /compose-save see identical station inventories. Returns []
   * when the API is unavailable or errors: inventory degrades to the
   * server-side sources rather than failing the page.
   */
  async cachedAccessoryUniqueIds(): Promise<string[]> {
    if (!this.ipc?.getCachedAccessories) {
      return [];
    }
    try {
      // Short leash: HB UI X's cached-accessories handler swallows its
      // own errors WITHOUT responding, so an un-bounded await here
      // would hang the preview forever. Three seconds of silence
      // degrades to "no client contribution".
      const cached = await new Promise<unknown[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 3_000);
        this.ipc!.getCachedAccessories!().then(
          v => { clearTimeout(timer); resolve(v); },
          e => { clearTimeout(timer); reject(e); },
        );
      });
      return (Array.isArray(cached) ? cached : [])
        .map(a => (a as { context?: { device?: { uniqueId?: unknown } } })?.context?.device?.uniqueId)
        .filter((u): u is string => typeof u === 'string');
    } catch {
      return [];
    }
  }
}

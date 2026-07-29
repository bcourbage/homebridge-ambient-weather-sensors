/**
 * Homebridge Config UI X custom-UI Node bridge — thin wire-up between
 * HomebridgePluginUiServer's IPC surface and the pure handler logic
 * in ./handlers.ts.
 *
 * v2.0.0-beta.* scope: READ-ONLY. See task #58 + docs/future/sensor-map.md §5.
 *
 * Endpoints exposed:
 *
 *   /status      → { configMode, safeModeBanner?, v2Flag, version, readOnly: true }
 *   /discovery   → contents of discovery.json (empty on absent)
 *   /notices     → contents of notices.json (empty on absent)
 *   /ui-state    → contents of ui-state.json (empty on absent)
 *
 * No write endpoints during beta. When v2.1.0 adds writes, they arrive
 * here as new endpoint registrations; the existing read endpoints stay
 * unchanged.
 *
 * The bridge runs in a Homebridge-managed subprocess. It doesn't share
 * a running AWN client with the platform — the platform writes the
 * persistence stores; this bridge reads them.
 */

import * as path from 'path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import {
  handleGetDiscovery,
  handleGetNotices,
  handleGetStatus,
  handleGetUiState,
  type HandlerDeps,
} from './handlers.js';
import type { Logger } from '../dist/sensorMap/persistence/atomicWrite.js';

/**
 * Version stamp displayed in the UI header. Update on every release
 * (or wire to package.json at build time in a later stage — the
 * static string keeps the bridge from taking a runtime dependency
 * on package.json's on-disk path). A unit test
 * (tests/unit/homebridge-ui/versionSync.test.ts) fails the build if
 * this drifts from package.json's version.
 */
const PLUGIN_VERSION: string = '2.0.0-beta.9';

// stderr is captured in the Homebridge UI's log tab, so this is
// where our bridge logs land. The plugin's `this.log.*` isn't
// available here — the bridge runs in a subprocess separate from
// the platform.
/* eslint-disable no-console */
const bridgeLog: Logger = {
  info: (m) => console.error(`[hb-ui] INFO ${m}`),
  warn: (m) => console.error(`[hb-ui] WARN ${m}`),
  debug: (m) => console.error(`[hb-ui] DEBUG ${m}`),
};
/* eslint-enable no-console */

class UiServer extends HomebridgePluginUiServer {
  private readonly deps: HandlerDeps;

  constructor() {
    super();
    // homebridgeStoragePath is nullable on HB UI X's types (undefined
    // during a test harness spawn or on some legacy setups). Fall back
    // to CWD's plugin-data path so read-only endpoints still respond
    // with an empty store rather than crash the bridge.
    const storage = this.homebridgeStoragePath ?? process.cwd();
    this.deps = {
      persistDir: path.join(storage, 'plugin-data', 'ambient-weather'),
      log: bridgeLog,
      version: PLUGIN_VERSION,
    };

    this.onRequest('/status', (payload) => this.wrap(() => handleGetStatus(this.deps, payload)));
    this.onRequest('/discovery', () => this.wrap(() => handleGetDiscovery(this.deps)));
    this.onRequest('/notices', () => this.wrap(() => handleGetNotices(this.deps)));
    this.onRequest('/ui-state', () => this.wrap(() => handleGetUiState(this.deps)));

    this.ready();
  }

  /**
   * Convert internal Errors into RequestError so the client channel
   * surfaces the message cleanly (RequestError is the shape HB UI X
   * expects for handler-thrown failures).
   */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error;
      throw new RequestError(err.message, err);
    }
  }
}

// Bootstrap. Skipped by test imports because Homebridge always spawns
// the bridge as an IPC subprocess; `process.send` is our proxy for
// that condition.
/* istanbul ignore next */
if (process.send) {
  new UiServer();
}

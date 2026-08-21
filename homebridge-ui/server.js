/**
 * Homebridge Config UI X custom-UI Node bridge — thin wire-up between
 * HomebridgePluginUiServer's IPC surface and the pure handler logic
 * in ./handlers.ts.
 *
 * v2.0.0-beta.* scope: the OBSERVATION endpoints are read-only; the
 * sensor-map editor has not shipped. /compose-save is the guarded
 * write BOUNDARY for the upcoming editor (#69): it never writes
 * config.json itself (Homebridge provides no server-side config-write
 * API) — it validates, snapshots first, and returns the composed
 * config for the CLIENT to persist. See sensor-map.md §5.
 *
 * Endpoints exposed:
 *
 *   /status       → { configMode, safeModeBanner?, v2Flag, version, readOnly,
 *                     sensorMapEditorAvailable, composeSaveAvailable,
 *                     previewSaveAvailable }
 *   /discovery    → contents of discovery.json (empty on absent)
 *   /notices      → contents of notices.json (empty on absent)
 *   /ui-state     → contents of ui-state.json (empty on absent)
 *   /editor-state → sanitized editor read model (authored + effective)
 *   /vocabulary   → per-measurement unit options with display labels
 *   /preview-save → save dry run: exact pipeline, zero writes, digest
 *
 * Ordinary legacy schema settings remain writable through HB UI X's
 * standard form and do NOT flow through /compose-save — the boundary
 * governs sensorMap/configVersion writes only.
 *
 * The bridge runs in a Homebridge-managed subprocess. It doesn't share
 * a running AWN client with the platform — the platform writes the
 * persistence stores; this bridge reads them.
 */
import * as path from 'path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { handleComposeSave, handleGetDiscovery, handleGetEditorState, handleGetNotices, handleGetStatus, handleGetUiState, handleGetVocabulary, handlePreviewSave, } from './handlers.js';
/**
 * Version stamp displayed in the UI header. Update on every release
 * (or wire to package.json at build time in a later stage — the
 * static string keeps the bridge from taking a runtime dependency
 * on package.json's on-disk path). A unit test
 * (tests/unit/homebridge-ui/versionSync.test.ts) fails the build if
 * this drifts from package.json's version.
 */
const PLUGIN_VERSION = '2.0.0-beta.12';
// stderr is captured in the Homebridge UI's log tab, so this is
// where our bridge logs land. The plugin's `this.log.*` isn't
// available here — the bridge runs in a subprocess separate from
// the platform.
/* eslint-disable no-console */
const bridgeLog = {
    info: (m) => console.error(`[hb-ui] INFO ${m}`),
    warn: (m) => console.error(`[hb-ui] WARN ${m}`),
    debug: (m) => console.error(`[hb-ui] DEBUG ${m}`),
};
/* eslint-enable no-console */
class UiServer extends HomebridgePluginUiServer {
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
            // Authoritative config.json path for the compose-save boundary
            // (#67): mode detection + snapshot payloads come from disk.
            configPath: this.homebridgeConfigPath ?? undefined,
        };
        this.onRequest('/status', (payload) => this.wrap(() => handleGetStatus(this.deps, payload)));
        this.onRequest('/discovery', () => this.wrap(() => handleGetDiscovery(this.deps)));
        this.onRequest('/notices', () => this.wrap(() => handleGetNotices(this.deps)));
        this.onRequest('/ui-state', () => this.wrap(() => handleGetUiState(this.deps)));
        // The GUARDED write boundary (GA task #67 / finding 5): validates
        // the proposal, writes/verifies the immutable legacy snapshot
        // FIRST, and only then returns the composed next config for the
        // client to persist via HB UI X's API. The row editor (#69) is its
        // first caller; refusals are structured { ok: false, error }.
        this.onRequest('/compose-save', (payload) => this.wrap(() => handleComposeSave(this.deps, payload)));
        // Sanitized read model + unit vocabulary for the row editor (#69).
        // Both are READ-ONLY; the editor stays display-only until PR C
        // activates the save path through /compose-save.
        this.onRequest('/editor-state', (payload) => this.wrap(() => handleGetEditorState(this.deps, payload)));
        this.onRequest('/vocabulary', () => this.wrap(async () => handleGetVocabulary()));
        // Server-authoritative save DRY RUN (#69 PR B): the exact save
        // pipeline with zero writes — validation, canonical form, the
        // structural diff, and the stateless confirmation digest the
        // future save path (PR C) must present for structural changes.
        this.onRequest('/preview-save', (payload) => this.wrap(() => handlePreviewSave(this.deps, payload)));
        this.ready();
    }
    /**
     * Convert internal Errors into RequestError so the client channel
     * surfaces the message cleanly (RequestError is the shape HB UI X
     * expects for handler-thrown failures).
     */
    async wrap(fn) {
        try {
            return await fn();
        }
        catch (e) {
            const err = e;
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

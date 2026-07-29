/**
 * Pure handler logic for the UI bridge — separated from the
 * HomebridgePluginUiServer bootstrap so tests can call each handler
 * directly without a live IPC channel to a Homebridge parent process.
 *
 * Every handler:
 *   - Takes a `HandlerDeps` bundle (persistDir + logger + version).
 *   - Returns a JSON-safe payload.
 *   - Throws Error on load failure — the server bootstrap converts
 *     to RequestError for the client channel.
 *
 * See homebridge-ui/server.ts for the HB UI X bootstrap.
 */
import * as path from 'path';
import { detectConfigMode } from '../dist/sensorMap/configMode.js';
import { shadowModeEnabled } from '../dist/sensorMap/shadowMode.js';
import { loadDiscoveryStore, } from '../dist/sensorMap/persistence/discoveryStore.js';
import { loadNoticeStore, } from '../dist/sensorMap/persistence/noticesStore.js';
import { loadUiStateStore, } from '../dist/sensorMap/persistence/uiStateStore.js';
export async function handleGetStatus(deps, payload) {
    const config = extractConfig(payload);
    const modeResult = detectConfigMode(config);
    const flagSource = detectV2FlagSource(config, deps.env ?? process.env);
    return {
        version: deps.version,
        v2Flag: {
            enabled: flagSource !== 'none',
            source: flagSource,
        },
        configMode: modeResult.mode,
        configWarnings: modeResult.warnings,
        safeModeBanner: modeResult.safeModeBanner,
        readOnly: true,
    };
}
export async function handleGetDiscovery(deps) {
    return loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log);
}
export async function handleGetNotices(deps) {
    return loadNoticeStore(path.join(deps.persistDir, 'notices.json'), deps.log);
}
export async function handleGetUiState(deps) {
    return loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log);
}
// ---- Internals ----------------------------------------------------
function extractConfig(payload) {
    if (typeof payload === 'object' && payload !== null && 'config' in payload) {
        const cfg = payload.config;
        if (typeof cfg === 'object' && cfg !== null) {
            return cfg;
        }
    }
    return {};
}
function detectV2FlagSource(config, env) {
    if (env.SENSOR_MAP_V2 === '1' || env.SENSOR_MAP_V2 === 'true') {
        return 'env';
    }
    if (shadowModeEnabled({ env: {}, config: config ?? {} })) {
        return 'config';
    }
    return 'none';
}

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

import { detectConfigMode, type ConfigInputShape } from '../dist/sensorMap/configMode.js';
import { shadowModeEnabled } from '../dist/sensorMap/shadowMode.js';
import {
  loadDiscoveryStore,
} from '../dist/sensorMap/persistence/discoveryStore.js';
import {
  loadNoticeStore,
} from '../dist/sensorMap/persistence/noticesStore.js';
import {
  loadUiStateStore,
} from '../dist/sensorMap/persistence/uiStateStore.js';
import type { Logger } from '../dist/sensorMap/persistence/atomicWrite.js';
import type {
  DiscoveryStore,
  NoticeStore,
  UiStateStore,
} from '../dist/sensorMap/types.js';

export interface HandlerDeps {
  persistDir: string;
  log: Logger;
  version: string;
  env?: NodeJS.ProcessEnv;
}

export interface StatusPayload {
  version: string;
  shadowFlag: {
    enabled: boolean;
    source: 'env' | 'config' | 'none';
  };
  configMode: 'legacy' | 'v2' | 'safe-mode';
  configWarnings: string[];
  safeModeBanner?: string;
  readOnly: true;
}

export async function handleGetStatus(deps: HandlerDeps, payload: unknown): Promise<StatusPayload> {
  const config = extractConfig(payload);
  const modeResult = detectConfigMode(config);
  const flagSource = detectShadowFlagSource(config, deps.env ?? process.env);
  return {
    version: deps.version,
    shadowFlag: {
      enabled: flagSource !== 'none',
      source: flagSource,
    },
    configMode: modeResult.mode,
    configWarnings: modeResult.warnings,
    safeModeBanner: modeResult.safeModeBanner,
    readOnly: true,
  };
}

export async function handleGetDiscovery(deps: HandlerDeps): Promise<DiscoveryStore> {
  return loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log);
}

export async function handleGetNotices(deps: HandlerDeps): Promise<NoticeStore> {
  return loadNoticeStore(path.join(deps.persistDir, 'notices.json'), deps.log);
}

export async function handleGetUiState(deps: HandlerDeps): Promise<UiStateStore> {
  return loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log);
}

// ---- Internals ----------------------------------------------------

function extractConfig(payload: unknown): ConfigInputShape {
  if (typeof payload === 'object' && payload !== null && 'config' in payload) {
    const cfg = (payload as { config: unknown }).config;
    if (typeof cfg === 'object' && cfg !== null) {
      return cfg as ConfigInputShape;
    }
  }
  return {};
}

function detectShadowFlagSource(
  config: ConfigInputShape | undefined,
  env: NodeJS.ProcessEnv,
): 'env' | 'config' | 'none' {
  if (env.SENSOR_MAP_V2 === '1' || env.SENSOR_MAP_V2 === 'true') {
    return 'env';
  }
  if (shadowModeEnabled({ env: {}, config: (config as Record<string, unknown>) ?? {} })) {
    return 'config';
  }
  return 'none';
}

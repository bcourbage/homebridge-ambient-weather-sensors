/**
 * Client-side save orchestration for the compose-save boundary (GA
 * task #67 / finding 5). This module is the ONE way the editor (#69,
 * its first caller) persists a sensor map:
 *
 *   /compose-save  →  await response  →  updatePluginConfig(...)  →  savePluginConfig()
 *
 * Homebridge provides no server-side config-write API — persistence is
 * client-side by platform design — so the ordering guarantee lives in
 * this sequence: the composed config that could mutate config.json is
 * not handed to HB UI X until the server has durably written (or
 * verified) the immutable legacy snapshot. Any compose refusal or
 * failure produces ZERO update/save calls.
 *
 * Framework-free and dependency-injected so the integration suite can
 * drive it against the REAL handler with an event-logging fake of the
 * HB UI X client API. Only type imports reference server code (erased
 * at compile time; safe in the browser).
 */

import type { ComposeSaveResult } from './handlers.js';

export interface OrchestratorDeps {
  /** homebridge.request — routed to the plugin's UI server. */
  request(path: string, payload?: unknown): Promise<unknown>;
  /** homebridge.getPluginConfig */
  getPluginConfig(): Promise<Array<Record<string, unknown>>>;
  /** homebridge.updatePluginConfig */
  updatePluginConfig(config: Array<Record<string, unknown>>): Promise<unknown>;
  /** homebridge.savePluginConfig */
  savePluginConfig(): Promise<unknown>;
  /** homebridge.getCachedAccessories (optional; §8.7 inventory source 3). */
  getCachedAccessories?(): Promise<unknown[]>;
}

export interface ComposeAndPersistArgs {
  /**
   * Proposed sensor-map override state. Omit for a pure legacy → v2
   * migration (the server seeds the proposal from the compat
   * translation of the on-disk config).
   */
  proposal?: unknown[];
  /** Optional fresh AWN station list, when one is genuinely available. */
  liveStations?: Array<{ macAddress: string; name?: string }>;
  /**
   * The config block being edited. Omit when exactly one
   * AmbientWeatherSensors block exists (the common case) — multi-block
   * (multi-Home) setups must pass the block their editor loaded.
   */
  base?: Record<string, unknown>;
  /**
   * The /preview-save confirmation digest (PR C / finding 5). The
   * server REQUIRES it for saves with structural consequences and
   * refuses stale or mismatched values — pass the digest of the
   * preview the user actually confirmed.
   */
  confirmDigest?: string;
}

export async function composeAndPersist(
  deps: OrchestratorDeps,
  args: ComposeAndPersistArgs,
): Promise<ComposeSaveResult> {
  const cfgArray = await deps.getPluginConfig();
  const blocks = cfgArray.filter(b => b && b.platform === 'AmbientWeatherSensors');

  let base = args.base;
  if (base === undefined) {
    if (blocks.length !== 1) {
      return {
        ok: false,
        error: {
          code: 'ambiguous-platform-block',
          message: `${blocks.length} AmbientWeatherSensors blocks in the plugin config; pass the block being edited.`,
        },
      };
    }
    base = blocks[0];
  }

  let cachedAccessoryUniqueIds: string[] | undefined;
  if (deps.getCachedAccessories) {
    try {
      const cached = await deps.getCachedAccessories();
      cachedAccessoryUniqueIds = cached
        .map(a => (a as { context?: { device?: { uniqueId?: unknown } } })?.context?.device?.uniqueId)
        .filter((u): u is string => typeof u === 'string');
    } catch {
      cachedAccessoryUniqueIds = undefined; // inventory source is best-effort
    }
  }

  // Locate the edited block in the FRESH config array by deep equality
  // (review #67 P1-3): a separately deserialized base is never
  // reference-equal, and indexOf would silently APPEND the composed
  // block as a duplicate. The server enforces the same exactly-one
  // deep-match contract against disk.
  const matchIndexes = cfgArray
    .map((b, i) => (deepJson(b) === deepJson(base) ? i : -1))
    .filter(i => i >= 0);
  if (matchIndexes.length !== 1) {
    return {
      ok: false,
      error: {
        code: matchIndexes.length === 0 ? 'stale-base' : 'ambiguous-platform-block',
        message: matchIndexes.length === 0
          ? 'The block being edited no longer matches the current plugin config; reload and retry.'
          : `${matchIndexes.length} identical blocks match the base; cannot determine which to replace.`,
      },
    };
  }
  const index = matchIndexes[0];

  const result = await deps.request('/compose-save', {
    base,
    proposal: args.proposal,
    cachedAccessoryUniqueIds,
    liveStations: args.liveStations,
    confirmDigest: args.confirmDigest,
  }) as ComposeSaveResult;

  if (!result || result.ok !== true) {
    // Refusal or malformed response: NO update, NO save.
    return result ?? { ok: false, error: { code: 'invalid-proposal', message: 'Empty response from /compose-save.' } };
  }

  const nextArray = cfgArray.map((b, i) => (i === index ? result.nextConfig : b));
  await deps.updatePluginConfig(nextArray);
  await deps.savePluginConfig();
  return result;
}

/** Deterministic deep JSON (sorted keys) for block matching. */
function deepJson(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(deepJson).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${deepJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

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
 * not handed to HB UI X until the server has made the pre-conversion
 * legacy record durable — the immutable snapshot on a first
 * conversion; an appended conversion-journal baseline on a
 * reconversion. Any compose refusal or failure produces ZERO
 * update/save calls.
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
  /**
   * Freeze the OTHER config writer for the duration of a save
   * (review #47 round 3, P1): the settings form and HB UI X's Save
   * button stay live while /compose-save runs, so a form edit made
   * after the formBlock sample was taken would be silently erased by
   * the clear-then-set persistence. Called BEFORE the first
   * getPluginConfig() read; unfreezeSettingsForm runs in `finally`.
   * In the real page this disables HB UI X's Save button ONLY — the
   * schema form must never be hidden mid-save: HB UI X binds the form
   * two-way into pluginConfig[0], and destroying the form writes
   * undefined through that binding, zeroing the session's config
   * (measured on production). Form EDITS during the save are caught
   * by the pre-persistence re-read, which refuses rather than
   * persisting over them.
   */
  freezeSettingsForm(): void | Promise<unknown>;
  unfreezeSettingsForm(): void | Promise<unknown>;
  /** homebridge.getCachedAccessories (optional; §8.7 inventory source 3). */
  getCachedAccessories?(): Promise<unknown[]>;
  /**
   * Await ceilings in milliseconds (test seam; production uses the
   * defaults). HB UI X's request plumbing has NO timeout of its own —
   * a lost response freezes the caller forever (measured on
   * production: a save that never settled left the editor locked
   * with zero feedback).
   */
  timeouts?: { request: number; persist: number };
}

const DEFAULT_TIMEOUTS = { request: 15_000, persist: 12_000 };

/** Reject after `ms` so a lost response becomes a visible outcome. */
function withTimeout<T>(work: Promise<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `no response from ${label} within ${Math.round(ms / 1000)} seconds`)), ms);
    Promise.resolve(work).then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
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
   * The config block being edited. Only valid for callers holding a
   * FAITHFUL copy of the on-disk block (tests, scripts). A browser
   * client must pass `baseDigest` + `blockIndex` from /editor-state
   * instead: getPluginConfig() returns HB UI X's schema-form-mutated
   * in-memory copy, which never byte-matches disk. Omit both when
   * exactly one AmbientWeatherSensors block exists and no session
   * token is available.
   */
  base?: Record<string, unknown>;
  /**
   * PREFERRED session token (beta.13 smoke F1): the `baseDigest` the
   * editor's /editor-state load returned. The server verifies it
   * against the current on-disk block; pass `blockIndex` with it.
   */
  baseDigest?: string;
  /**
   * Position of the edited block among the plugin's platform blocks
   * (from /editor-state) — where the composed block is written back
   * within the getPluginConfig() array. Required with `baseDigest`.
   */
  blockIndex?: number;
  /**
   * The /preview-save confirmation digest (PR C / finding 5). The
   * server REQUIRES it for saves with structural consequences and
   * refuses stale or mismatched values — pass the digest of the
   * preview the user actually confirmed.
   */
  confirmDigest?: string;
}

/**
 * The orchestrator's result: the authoritative save outcome, plus a
 * flag when the settings-form RESTORE failed afterward (review #47
 * round 5, P2) — the outcome stands, but the page's form may be
 * hidden or its Save button dead, and the component must tell the
 * user to reload rather than leave a silently degraded page.
 */
export type PersistOutcome = ComposeSaveResult & { settingsRestoreFailed?: true };

export async function composeAndPersist(
  deps: OrchestratorDeps,
  args: ComposeAndPersistArgs,
): Promise<PersistOutcome> {
  // The settings form and HB UI X's Save button are a SECOND writer of
  // the same config; frozen for the whole operation so no form edit
  // can land between the formBlock sample and the clear-then-set
  // persistence (review #47 round 3, P1). Failure-safe (round 4): a
  // freeze that throws may have PARTIALLY applied, so the restore is
  // attempted before refusing; and an unfreeze failure never masks
  // the authoritative save outcome — by the time cleanup runs, the
  // save either persisted or refused, and THAT is what the caller
  // must learn (with the restore failure flagged alongside it).
  try {
    await deps.freezeSettingsForm();
  } catch (e) {
    const restored = await unfreezeQuietly(deps);
    return {
      ok: false,
      error: {
        code: 'unsaved-settings-changes',
        message: `The settings form could not be frozen for the save: ${e instanceof Error ? e.message : String(e)}. `
          + 'Reload the plugin settings and retry; nothing was written.',
      },
      ...(restored ? {} : { settingsRestoreFailed: true as const }),
    };
  }
  let outcome: PersistOutcome;
  try {
    outcome = await composeAndPersistFrozen(deps, args);
  } catch (e) {
    const restored = await unfreezeQuietly(deps);
    if (restored) {
      throw e;
    }
    return {
      ok: false,
      error: {
        code: 'invalid-proposal',
        message: `The save failed (${e instanceof Error ? e.message : String(e)}) and the settings form could `
          + 'not be restored. Reload the plugin settings page.',
      },
      settingsRestoreFailed: true,
    };
  }
  const restored = await unfreezeQuietly(deps);
  return restored ? outcome : { ...outcome, settingsRestoreFailed: true };
}

/**
 * Restore the settings form without ever throwing: the save outcome
 * is authoritative, and a cleanup failure must not replace it (a
 * completed save reported as a transport error is worse than a
 * momentarily locked form). Returns whether the restore succeeded so
 * the caller can FLAG the degraded page instead of hiding it.
 */
async function unfreezeQuietly(deps: OrchestratorDeps): Promise<boolean> {
  try {
    await deps.unfreezeSettingsForm();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read HB UI X's in-memory config as an immutable, canonical-shape
 * snapshot. Two production behaviors are handled here (both measured
 * on HB UI X 5.28):
 *
 *   - getPluginConfig() returns HB UI X's LIVE array — the same object
 *     graph on every call — so a naive mid-save re-check would compare
 *     that array against itself and always pass. The deep clone makes
 *     each read independent.
 *   - The settings modal's schema form binds TWO-WAY into
 *     pluginConfig[0] and replaces the block with the form VALUE,
 *     which carries only schema properties — `platform` is not one, so
 *     every session block arrives WITHOUT its platform key and the
 *     identity filter below would see zero AmbientWeatherSensors
 *     blocks (the beta.14 "No AmbientWeatherSensors configuration is
 *     loaded" failure). HB UI X itself re-injects the key on every
 *     write (updateConfigBlocks and the backend both force
 *     `block[pluginType] = pluginAlias`), so restoring it here is the
 *     same normalization the platform applies — added only when the
 *     key is absent, never overwriting an explicit value.
 */
async function readSessionBlocks(
  deps: OrchestratorDeps,
  timeouts: { request: number; persist: number },
): Promise<Array<Record<string, unknown>>> {
  const cfgArray = JSON.parse(JSON.stringify(
    await withTimeout(deps.getPluginConfig(), timeouts.request, 'the Homebridge UI (getPluginConfig)'),
  )) as Array<Record<string, unknown>>;
  for (const block of cfgArray) {
    if (block && typeof block === 'object' && !('platform' in block)) {
      block.platform = 'AmbientWeatherSensors';
    }
  }
  return cfgArray;
}

async function composeAndPersistFrozen(
  deps: OrchestratorDeps,
  args: ComposeAndPersistArgs,
): Promise<ComposeSaveResult> {
  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;
  const cfgArray = await readSessionBlocks(deps, timeouts);
  const blocks = cfgArray.filter(b => b && b.platform === 'AmbientWeatherSensors');

  const digestSession = args.baseDigest !== undefined;
  if (digestSession) {
    if (typeof args.baseDigest !== 'string' || args.baseDigest.length === 0) {
      return {
        ok: false,
        error: {
          code: 'stale-base',
          message: 'The editor session token is missing or malformed; reload and retry.',
        },
      };
    }
    // Exactly-one-block invariant (review #47 P1-2): the token
    // identifies a block by CONTENT while this array is replaced by
    // POSITION — with more than one block those can disagree, and a
    // wrong position would overwrite another Home's configuration.
    // The server refuses multi-block configs too; this is the
    // client-side half, checked before any request is made.
    if (blocks.length === 0) {
      return {
        ok: false,
        error: {
          code: 'stale-base',
          message: 'No AmbientWeatherSensors configuration is loaded in this Homebridge UI session. Reload the '
            + 'plugin settings page and retry; nothing was written.',
        },
      };
    }
    if (blocks.length > 1) {
      return {
        ok: false,
        error: {
          code: 'ambiguous-platform-block',
          message: `${blocks.length} AmbientWeatherSensors platform blocks exist (a multi-Home setup; see MultiHome.md). `
            + 'The sensor-map editor supports exactly one block, so it is read-only here. Edit sensorMap in the '
            + 'JSON config editor instead.',
        },
      };
    }
  }

  let base = args.base;
  if (!digestSession && base === undefined) {
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
      // Best-effort inventory source with a SHORT leash: HB UI X's
      // cached-accessories handler swallows its own errors WITHOUT
      // responding (measured in 5.28: catch -> toastr, no
      // requestResponse), which hung the whole save on the production
      // box. Inventory has server-side sources; three seconds of
      // silence here degrades to "no client contribution", never a
      // frozen save.
      const cached = await withTimeout(deps.getCachedAccessories(), 3_000, 'the Homebridge UI (getCachedAccessories)');
      cachedAccessoryUniqueIds = cached
        .map(a => (a as { context?: { device?: { uniqueId?: unknown } } })?.context?.device?.uniqueId)
        .filter((u): u is string => typeof u === 'string');
    } catch {
      cachedAccessoryUniqueIds = undefined; // inventory source is best-effort
    }
  }

  // Locate where the composed block will be WRITTEN BACK in the
  // getPluginConfig() array. In a digest session the position is
  // DERIVED here — the single plugin block's index — never taken from
  // the client-supplied blockIndex (review #47 P1-2: a forged or
  // drifted index would compose one block and replace another); the
  // supplied value is only cross-checked and refused on disagreement.
  // The array's CONTENT is form-mutated and untrustworthy — the
  // server does the real staleness check against disk via the digest.
  // In the legacy base flow the block is located by deep equality
  // (review #67 P1-3): a separately deserialized base is never
  // reference-equal, and indexOf would silently APPEND the composed
  // block as a duplicate.
  let index: number;
  if (digestSession) {
    index = cfgArray.findIndex(b => b && b.platform === 'AmbientWeatherSensors');
    if (args.blockIndex !== undefined && args.blockIndex !== index) {
      return {
        ok: false,
        error: {
          code: 'stale-base',
          message: 'The editor session token no longer matches the plugin config layout; reload and retry.',
        },
      };
    }
  } else {
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
    index = matchIndexes[0];
  }

  const payload = {
    base: digestSession ? undefined : base,
    baseDigest: digestSession ? args.baseDigest : undefined,
    // The in-memory block, so the server can refuse when the settings
    // form holds UNSAVED user changes this save would discard
    // (review #47 P1-1).
    formBlock: digestSession ? cfgArray[index] : undefined,
    proposal: args.proposal,
    cachedAccessoryUniqueIds,
    liveStations: args.liveStations,
    confirmDigest: args.confirmDigest,
  };

  // ---- Phase 1 (VALIDATE): every gate and the full composition, with
  //      NOTHING durably recorded. A refusal here — or at the re-check
  //      below — therefore consumes neither the immutable snapshot nor
  //      a journal entry (review #47 round 4).
  const validated = await withTimeout(
    deps.request('/compose-save', payload), timeouts.request, 'the plugin service (/compose-save)') as ComposeSaveResult;
  if (!validated || validated.ok !== true) {
    return validated ?? { ok: false, error: { code: 'invalid-proposal', message: 'Empty response from /compose-save.' } };
  }

  // ---- Re-check, behind the client-cooperative freeze: re-read the
  //      in-memory config and refuse if ANYTHING changed while the
  //      validation ran — an edit that raced the save would otherwise
  //      be erased by the clear-then-set below.
  const recheck = await readSessionBlocks(deps, timeouts);
  if (deepJson(recheck) !== deepJson(cfgArray)) {
    return {
      ok: false,
      error: {
        code: 'unsaved-settings-changes',
        message: 'The plugin settings changed while the save was running. Review the settings form and retry; '
          + 'nothing was written.',
      },
    };
  }

  // ---- Phase 2 (COMMIT): the same pipeline re-run from disk, with
  //      the snapshot/journal written durably immediately before the
  //      persistable config is returned. The validation token makes
  //      the protocol SERVER-ENFORCED (review #47 round 5): the
  //      commit recomputes it from current state and refuses BEFORE
  //      writing on any drift since validation — no post-hoc client
  //      comparison after the record was already consumed.
  const result = await withTimeout(deps.request('/commit-save', {
    ...payload,
    validationToken: validated.validationToken,
  }), timeouts.request, 'the plugin service (/commit-save)') as ComposeSaveResult;
  if (!result || result.ok !== true) {
    return result ?? { ok: false, error: { code: 'invalid-proposal', message: 'Empty response from /commit-save.' } };
  }

  // HB UI X applies updatePluginConfig by MERGING each submitted block
  // into its in-memory copy (Object.assign), so a key the composed
  // config REMOVED — a legacy field the mirror omits, or a schema
  // default the settings form materialized — would silently survive
  // into the persisted file, and a resurrected mirrored field makes
  // the freshly written mirror hash STALE on arrival. Explicit
  // `undefined` tombstones for the removed keys make the merge produce
  // EXACTLY the composed block (postMessage structured clone preserves
  // undefined; HB UI X's JSON persistence then drops the keys). An
  // earlier design cleared the array first (update([]) then the real
  // one) — measured hazard on production: a save dying between the
  // two calls left HB UI X's session holding ZERO blocks, poisoning
  // every later save. A transport that drops undefined would merely
  // leave stale keys, which the post-save receipt surfaces as drift —
  // fail-visible, never fail-empty.
  const previous = cfgArray[index] ?? {};
  const replacedBlock: Record<string, unknown> = { ...result.nextConfig };
  for (const key of Object.keys(previous)) {
    if (!(key in result.nextConfig)) {
      replacedBlock[key] = undefined;
    }
  }
  const nextArray = cfgArray.map((b, i) => (i === index ? replacedBlock : b));
  // Post-compose persistence failures are INDETERMINATE (review #45
  // P1-2): HB UI X may have taken effect and then rejected, or lost
  // the response. Never tell the user "nothing was written" here —
  // report the failed stage and direct them to reload and inspect
  // before retrying. (The legacy snapshot is already durable either
  // way; a retry re-verifies it.)
  try {
    await withTimeout(deps.updatePluginConfig(nextArray), timeouts.persist, 'the Homebridge UI (updatePluginConfig)');
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'persistence-indeterminate',
        stage: 'updatePluginConfig',
        message: `updatePluginConfig failed after the save was composed: ${(e as Error).message}. The staged `
          + 'configuration state is uncertain — reload the plugin settings and inspect the configuration before '
          + 'retrying. The legacy snapshot (when applicable) was already written and is verified on retry.',
      },
    };
  }
  try {
    await withTimeout(deps.savePluginConfig(), timeouts.persist, 'the Homebridge UI (savePluginConfig)');
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'persistence-indeterminate',
        stage: 'savePluginConfig',
        message: `savePluginConfig failed after the configuration was staged: ${(e as Error).message}. The save `
          + 'MAY have been applied — reload the plugin settings and inspect the configuration before retrying.',
      },
    };
  }
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

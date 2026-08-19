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

import { promises as fs } from 'fs';
import * as path from 'path';

import { buildEffectiveSensorMap } from '../dist/sensorMap/buildEffectiveMap.js';
import { canonicalizeSensorMap } from '../dist/sensorMap/canonicalizeSensorMap.js';
import { compatToOverrides, type LegacyConfig } from '../dist/sensorMap/compat.js';
import { detectConfigMode, type ConfigInputShape } from '../dist/sensorMap/configMode.js';
import {
  composeV2ConfigSave,
  verifyLegacySnapshot,
  writeLegacySnapshot,
} from '../dist/sensorMap/legacyMirror.js';
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
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../dist/sensorMap/types.js';

export interface HandlerDeps {
  persistDir: string;
  log: Logger;
  version: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Absolute path of Homebridge's config.json — the AUTHORITATIVE
   * source for compose-save (review #67 P1-1): mode detection, the
   * snapshot payload, and the base configuration being replaced are
   * all taken from disk, never from the client's copy. Provided by
   * HomebridgePluginUiServer.homebridgeConfigPath.
   */
  configPath?: string;
}

export interface StatusPayload {
  version: string;
  v2Flag: {
    enabled: boolean;
    source: 'env' | 'config' | 'none';
  };
  configMode: 'legacy' | 'v2' | 'safe-mode';
  configWarnings: string[];
  safeModeBanner?: string;
  /**
   * The v2 OBSERVATION PANELS remain read-only (unchanged meaning).
   * Editor/write availability is expressed by the two explicit fields
   * below rather than by repurposing this boolean.
   */
  readOnly: true;
  /** The sensor-map row editor has not shipped yet (#69). */
  sensorMapEditorAvailable: false;
  /**
   * The guarded compose-save boundary is installed: any sensorMap
   * write MUST flow through /compose-save (snapshot-first). Ordinary
   * legacy schema settings remain writable through the standard form
   * and do not flow through it.
   */
  composeSaveAvailable: true;
}

export async function handleGetStatus(deps: HandlerDeps, payload: unknown): Promise<StatusPayload> {
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
    sensorMapEditorAvailable: false,
    composeSaveAvailable: true,
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

function detectV2FlagSource(
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

// ---- Compose-save boundary (GA task #67 / finding 5) ---------------

/**
 * Category toggles a legacy config uses to enable sensors — the
 * "legacy config enables sensors" predicate for the empty-inventory
 * refusal (review #67 P1-5).
 */
const LEGACY_CATEGORY_TOGGLES = [
  'temperatureSensors', 'humiditySensors', 'solarRadiationSensors',
  'co2Sensors', 'airQualitySensors', 'extendedSensors',
  'windSensors', 'rainSensors', 'pressureSensors', 'uvSensors',
  'lightningSensors',
] as const;

export type ComposeSaveError =
  | { code: 'config-unreadable'; message: string }
  | { code: 'no-platform-block'; message: string }
  | { code: 'stale-base'; message: string }
  | { code: 'ambiguous-platform-block'; message: string }
  | { code: 'safe-mode'; message: string }
  | { code: 'invalid-proposal'; message: string }
  | { code: 'invalid-rows'; message: string; rows: unknown[] }
  | { code: 'no-station-inventory'; message: string }
  | { code: 'canonical-divergence'; message: string; rows: unknown[] }
  | { code: 'legacy-snapshot-mismatch'; message: string }
  | { code: 'legacy-snapshot-corrupt'; message: string }
  | { code: 'snapshot-write-failed'; message: string };

export type ComposeSaveResult =
  | {
    ok: true;
    /** The composed platform block the CLIENT must persist verbatim. */
    nextConfig: Record<string, unknown>;
    /** Snapshot outcome: written now, already present (verified), or not a legacy conversion. */
    snapshot: 'written' | 'exists' | 'not-applicable';
    /** The canonical sensorMap embedded in nextConfig (informational). */
    canonicalSensorMap: SensorMapOverride[];
    /**
     * Warn-and-strip validation warnings from the proposal (stable
     * codes + override indices) — the editor's "needs attention"
     * channel must surface these even on a successful save.
     */
    warnings: unknown[];
    /** Ownership/plugin-health notes (attribution per `source`). */
    notes: unknown[];
  }
  | { ok: false; error: ComposeSaveError };

export interface ComposeSavePayload {
  /**
   * The client's copy of the plugin config block it is editing. Used
   * ONLY to locate + staleness-check the on-disk block — never as the
   * authoritative current configuration.
   */
  base?: unknown;
  /** Proposed sensor-map override state from the editor. */
  proposal?: unknown;
  /**
   * Station-inventory contributions the SERVER cannot see (§8.7):
   * cached-accessory uniqueIds (from homebridge.getCachedAccessories())
   * and, when one is genuinely available, a fresh AWN station list.
   */
  cachedAccessoryUniqueIds?: unknown;
  liveStations?: unknown;
}

/**
 * Compose a v2 save: validate the proposal, write/verify the immutable
 * legacy snapshot FIRST, and only then return the composed next config
 * for the client to persist through HB UI X's API. The composed config
 * physically cannot reach config.json before the snapshot is durable.
 *
 * Refusals return `{ ok: false, error }` (JSON-safe, editor-consumable)
 * and perform NO writes — with one deliberate exception: a successful
 * snapshot write followed by a later refusal is harmless (the snapshot
 * is the pre-conversion record either way and is verified on the next
 * attempt).
 */
export async function handleComposeSave(
  deps: HandlerDeps,
  payload: unknown,
): Promise<ComposeSaveResult> {
  const p = (payload ?? {}) as ComposeSavePayload;

  // ---- 1. Authoritative on-disk config (never the client's copy).
  if (!deps.configPath) {
    return { ok: false, error: { code: 'config-unreadable', message: 'No config.json path available to the UI server.' } };
  }
  let configRaw: string;
  try {
    configRaw = await fs.readFile(deps.configPath, 'utf8');
  } catch (e) {
    return { ok: false, error: { code: 'config-unreadable', message: `config.json unreadable: ${(e as Error).message}` } };
  }
  let configJson: unknown;
  try {
    configJson = JSON.parse(configRaw);
  } catch (e) {
    return { ok: false, error: { code: 'config-unreadable', message: `config.json is not valid JSON: ${(e as Error).message}` } };
  }
  const platforms = (configJson as { platforms?: unknown }).platforms;
  const blocks = (Array.isArray(platforms) ? platforms : [])
    .filter((b): b is Record<string, unknown> =>
      !!b && typeof b === 'object' && (b as { platform?: unknown }).platform === 'AmbientWeatherSensors');
  if (blocks.length === 0) {
    return { ok: false, error: { code: 'no-platform-block', message: 'No AmbientWeatherSensors platform block found in config.json.' } };
  }

  // ---- 2. Locate the block being edited by matching the client's
  //         base copy — which doubles as the stale-session check: if
  //         the on-disk block no longer equals what the client is
  //         editing, refuse rather than compose against a stale view.
  const baseJson = canonicalJsonLocal(p.base);
  const matches = blocks.filter(b => canonicalJsonLocal(b) === baseJson);
  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: 'stale-base',
        message: 'The configuration changed since this editor session loaded (or the submitted base does not match any '
          + 'AmbientWeatherSensors block). Reload the plugin config and retry.',
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: 'ambiguous-platform-block',
        message: `${matches.length} identical AmbientWeatherSensors blocks match the submitted base; cannot determine which to edit.`,
      },
    };
  }
  const block = matches[0];

  // ---- 3. Mode detection from the ON-DISK block (single authority).
  const modeResult = detectConfigMode(block as ConfigInputShape);
  if (modeResult.mode === 'safe-mode') {
    return { ok: false, error: { code: 'safe-mode', message: 'UI saves are refused in safe mode (§5). Fix or restore the configuration first.' } };
  }

  // ---- 4. Proposal shape. On a LEGACY config with NO proposal, the
  //         save is a pure migration: the proposal is seeded from the
  //         compat translation of the on-disk block (§5's "reads
  //         effective sensor map (compat-translated)") — composing a
  //         legacy config against an EMPTY proposal would instead
  //         serialize pure defaults and silently re-enable everything
  //         the legacy config had turned off.
  if (p.proposal !== undefined
    && (!Array.isArray(p.proposal) || p.proposal.some(e => !e || typeof e !== 'object' || Array.isArray(e)))) {
    return { ok: false, error: { code: 'invalid-proposal', message: 'proposal must be an array of override objects.' } };
  }
  if (p.proposal === undefined && modeResult.mode !== 'legacy') {
    return { ok: false, error: { code: 'invalid-proposal', message: 'proposal is required for a v2-mode save (only a legacy pure migration may omit it).' } };
  }

  // ---- 5. Station inventory (§8.7 preference order): live response,
  //         discovery registry, cached-accessory MACs, override MACs.
  //         Assembled twice when the proposal is compat-seeded, so the
  //         seeded overrides' station scopes contribute their MACs.
  const discovery = await loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log);
  const uiState = await loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log);
  const assemble = (proposalForMacs: ReadonlyArray<SensorMapOverride>): StationInventory =>
    assembleStationInventory({
      liveStations: p.liveStations,
      discovery,
      cachedAccessoryUniqueIds: p.cachedAccessoryUniqueIds,
      overrideSources: [
        Array.isArray(block.sensorMap) ? (block.sensorMap as SensorMapOverride[]) : [],
        proposalForMacs,
      ],
    });
  let proposal: SensorMapOverride[];
  let stations: StationInventory;
  if (p.proposal === undefined) {
    stations = assemble([]);
    proposal = compatToOverrides(block as LegacyConfig, stations);
    stations = assemble(proposal);
  } else {
    proposal = p.proposal as SensorMapOverride[];
    stations = assemble(proposal);
  }
  const legacyEnablesSensors = LEGACY_CATEGORY_TOGGLES.some(k => block[k] === true);
  const wouldConfigure = legacyEnablesSensors
    || proposal.length > 0
    || (Array.isArray(block.sensorMap) && block.sensorMap.length > 0);
  if (stations.length === 0 && wouldConfigure) {
    return {
      ok: false,
      error: {
        code: 'no-station-inventory',
        message: 'No station inventory is available from any source (live response, discovery registry, cached '
          + 'accessories, override stationMacs). Composing now would produce an empty or incorrect sensor map and '
          + 'mirror; run the plugin at least once (or pass cached accessories) before converting.',
      },
    };
  }

  // ---- 6. Normalize + validate the proposal through the SAME
  //         machinery the runtime uses (identity-first → duplicate
  //         merge with later-field-wins → body validation with
  //         provenance) — never per-fragment validation.
  const effectiveMap = buildEffectiveSensorMap({
    userOverrides: proposal,
    discovery,
    uiState,
    stations,
    configMode: 'v2',
  });
  if (effectiveMap.errors.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invalid-rows',
        message: `${effectiveMap.errors.length} proposed row(s) failed validation; nothing was written.`,
        rows: effectiveMap.errors as unknown[],
      },
    };
  }

  // ---- 7. The SERVER assembles canonical config (§11.3/§17.4) — the
  //         client is never responsible for canonical serialization.
  const canonical = canonicalizeSensorMap({ overrides: proposal, stations, discovery, uiState });

  // ---- 7b. HARD DIVERGENCE GATE (review #67 P1-1): canonical output
  //          MUST mean exactly what the proposal meant. Reloading the
  //          canonical array must reproduce every effective row AND
  //          structural signature. The known divergence class:
  //          battery-field claims adjudicated by EARLIEST-AUTHORED
  //          index, which entry sorting cannot preserve — a proposal
  //          whose meaning depends on authoring order is refused with
  //          guidance to make ownership explicit. The gate also traps
  //          any future serializer defect (it detects the P1-2
  //          per-station identity corruption mechanically).
  const reloaded = buildEffectiveSensorMap({
    userOverrides: canonical,
    discovery,
    uiState,
    stations,
    configMode: 'v2',
  });
  const divergent = diffEffectiveRows(effectiveMap as unknown as EffectiveRowsHolder, reloaded as unknown as EffectiveRowsHolder);
  if (divergent.length > 0) {
    return {
      ok: false,
      error: {
        code: 'canonical-divergence',
        message: 'Canonical serialization would change the meaning of this configuration for '
          + `${divergent.length} row(s) — most commonly because multiple rows claim the same battery `
          + 'field and ownership depends on authoring order, which canonical (sorted) output does not '
          + "preserve. Make ownership explicit (set batteryField: null on the non-owning row(s), or "
          + 'assign distinct battery fields) and retry. Nothing was written.',
        rows: divergent,
      },
    };
  }

  // ---- 8. Compose. detectConfigMode's verdict is passed explicitly
  //         (it is the single authority on "legacy").
  const composed = composeV2ConfigSave(block, canonical as unknown[], effectiveMap, modeResult.mode);

  // ---- 9. Snapshot-first, race-safe: attempt the exclusive-create
  //         write; on 'exists', verify the surviving content against
  //         the authoritative pre-conversion fields (review P1-6) —
  //         never overwrite, never silently bless a mismatch.
  let snapshot: 'written' | 'exists' | 'not-applicable' = 'not-applicable';
  if (composed.snapshot !== undefined) {
    let outcome: 'written' | 'exists';
    try {
      outcome = await writeLegacySnapshot(deps.persistDir, composed.snapshot, deps.log);
    } catch (e) {
      return { ok: false, error: { code: 'snapshot-write-failed', message: `Legacy snapshot write failed: ${(e as Error).message}. The save was aborted; config.json was not touched.` } };
    }
    if (outcome === 'exists') {
      const verdict = await verifyLegacySnapshot(deps.persistDir, composed.snapshot);
      if (verdict === 'mismatch') {
        return {
          ok: false,
          error: {
            code: 'legacy-snapshot-mismatch',
            message: 'A legacy snapshot from an earlier conversion attempt exists but does not match the current '
              + 'legacy configuration. Refusing to convert: the snapshot is immutable and will not be overwritten. '
              + 'Resolve manually (inspect legacy-config-snapshot.json in the plugin data directory).',
          },
        };
      }
      if (verdict === 'corrupt' || verdict === 'absent') {
        return {
          ok: false,
          error: {
            code: 'legacy-snapshot-corrupt',
            message: 'The existing legacy snapshot could not be read back for verification. Refusing to convert.',
          },
        };
      }
    }
    snapshot = outcome;
  }

  return {
    ok: true,
    nextConfig: composed.nextConfig,
    snapshot,
    canonicalSensorMap: canonical,
    warnings: effectiveMap.warnings as unknown[],
    notes: effectiveMap.notes as unknown[],
  };
}

/** §8.7 station-inventory union, in preference order (names from the freshest source). */
function assembleStationInventory(src: {
  liveStations: unknown;
  discovery: DiscoveryStore;
  cachedAccessoryUniqueIds: unknown;
  overrideSources: ReadonlyArray<ReadonlyArray<SensorMapOverride>>;
}): StationInventory {
  const byMac = new Map<string, string>(); // MAC → name ('' when unknown)
  const add = (mac: string, name: string): void => {
    const key = mac.toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(key)) {
      return;
    }
    const existing = byMac.get(key);
    if (existing === undefined || (existing === '' && name !== '')) {
      byMac.set(key, name);
    }
  };
  // 1. Live response (freshest names win by insertion order).
  if (Array.isArray(src.liveStations)) {
    for (const s of src.liveStations) {
      if (s && typeof s === 'object' && typeof (s as { macAddress?: unknown }).macAddress === 'string') {
        add((s as { macAddress: string }).macAddress, String((s as { name?: unknown }).name ?? ''));
      }
    }
  }
  // 2. Discovery registry.
  for (const e of src.discovery.entries) {
    add(e.stationMac, e.stationName ?? '');
  }
  // 3. Cached-accessory uniqueId prefixes (MAC-dataPoint).
  if (Array.isArray(src.cachedAccessoryUniqueIds)) {
    for (const uid of src.cachedAccessoryUniqueIds) {
      if (typeof uid === 'string' && uid.length >= 17) {
        add(uid.slice(0, 17), '');
      }
    }
  }
  // 4. stationMac values in current + proposed overrides.
  for (const list of src.overrideSources) {
    for (const o of list) {
      if (typeof o.stationMac === 'string') {
        add(o.stationMac, '');
      }
    }
  }
  return [...byMac.entries()].map(([macAddress, name]) => ({ macAddress, name }));
}

/**
 * Compare two effective maps' CONFIGURED rows (full row content,
 * structural signature included). Returns the diverging keys with both
 * sides' signatures for the error payload. (The discriminated-union
 * rows are treated as plain records here — comparison only.)
 */
interface EffectiveRowsHolder {
  rows: ReadonlyArray<Record<string, unknown> & { kind: string }>;
}
function diffEffectiveRows(
  before: EffectiveRowsHolder,
  after: EffectiveRowsHolder,
): Array<{ stationMac: unknown; dataPoint: unknown; before?: string; after?: string }> {
  const index = (m: EffectiveRowsHolder): Map<string, Record<string, unknown>> => {
    const out = new Map<string, Record<string, unknown>>();
    for (const row of m.rows) {
      if (row.kind !== 'unrecognized') {
        out.set(`${String(row.stationMac)}|${String(row.dataPoint)}`, row);
      }
    }
    return out;
  };
  const a = index(before);
  const b = index(after);
  const divergent: Array<{ stationMac: unknown; dataPoint: unknown; before?: string; after?: string }> = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const rowA = a.get(key);
    const rowB = b.get(key);
    if (!rowA || !rowB || canonicalJsonLocal(rowA) !== canonicalJsonLocal(rowB)) {
      const [stationMac, dataPoint] = key.split('|');
      divergent.push({
        stationMac,
        dataPoint,
        before: rowA ? String(rowA.structuralSignature ?? '(row absent)') : '(row absent)',
        after: rowB ? String(rowB.structuralSignature ?? '(row absent)') : '(row absent)',
      });
    }
  }
  return divergent;
}

/** Deterministic deep JSON for base-vs-on-disk comparison. */
function canonicalJsonLocal(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(canonicalJsonLocal).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJsonLocal(val)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

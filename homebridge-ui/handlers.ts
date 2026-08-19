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

import { buildEffectiveSensorMap, partitionOverrideLayers } from '../dist/sensorMap/buildEffectiveMap.js';
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
import { UNIT_VOCABULARY, unitOptionsFor } from '../dist/sensorMap/unitVocabulary.js';
import type { Logger } from '../dist/sensorMap/persistence/atomicWrite.js';
import type {
  DiscoveryStore,
  EffectiveSensorRow,
  InternalInvariantNote,
  Measurement,
  NoticeStore,
  RowValidationError,
  RowValidationWarning,
  SensorMapOverride,
  StationInventory,
  UiStateStore,
} from '../dist/sensorMap/types.js';
import type {
  EditorAuthoredFragmentDto,
  EditorDiagnosticDto,
  EditorRowDto,
  EditorStateDto,
  EditorStationDto,
  VocabularyDto,
} from './app-src/dto/editor-state.js';

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
  | { code: 'invalid-rows'; message: string; rows: RowValidationError[] }
  | { code: 'no-station-inventory'; message: string }
  | { code: 'canonical-divergence'; message: string; rows: DivergentRow[] }
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
    warnings: RowValidationWarning[];
    /** Ownership/plugin-health notes (attribution per `source`). */
    notes: InternalInvariantNote[];
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
        rows: effectiveMap.errors,
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
  //          Equivalence is proven over the inventory PLUS a synthetic
  //          never-seen station (review round 2): comparing only the
  //          current inventory cannot detect a global TEMPLATE being
  //          narrowed to per-station entries — the divergence would
  //          only manifest when a new station appears.
  const gateStations = [
    ...stations,
    { macAddress: syntheticProbeMac(stations.map(st => st.macAddress)), name: '(template-equivalence probe)' },
  ];
  const gateBefore = buildEffectiveSensorMap({
    userOverrides: proposal,
    discovery,
    uiState,
    stations: gateStations,
    configMode: 'v2',
  });
  const reloaded = buildEffectiveSensorMap({
    userOverrides: canonical,
    discovery,
    uiState,
    stations: gateStations,
    configMode: 'v2',
  });
  const divergent = diffEffectiveRows(gateBefore as unknown as EffectiveRowsHolder, reloaded as unknown as EffectiveRowsHolder);
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
    warnings: effectiveMap.warnings,
    notes: effectiveMap.notes,
  };
}

// ---- Editor read model (GA task #69, PR A — read-only) -------------

export interface EditorStatePayload {
  /**
   * Station-inventory contributions the SERVER cannot see (§8.7) —
   * the same two client-side sources /compose-save accepts.
   */
  cachedAccessoryUniqueIds?: unknown;
  liveStations?: unknown;
}

/**
 * Sanitized read model for the sensor-map editor. The AUTHORITATIVE
 * on-disk config.json is the source (same rule as /compose-save);
 * the response carries only what the editor renders — credentials,
 * paths, and internal machinery never leave the bridge.
 *
 * Read-only semantics: unreadable/absent config THROWS (the client
 * shows a load failure), while a readable-but-troubled configuration
 * (safe mode, multiple blocks, validation errors) returns a DTO that
 * SAYS so — those are states the editor must render, not transport
 * failures.
 */
export async function handleGetEditorState(
  deps: HandlerDeps,
  payload: unknown,
): Promise<EditorStateDto> {
  const p = (payload ?? {}) as EditorStatePayload;

  if (!deps.configPath) {
    throw new Error('No config.json path available to the UI server.');
  }
  let configJson: unknown;
  try {
    configJson = JSON.parse(await fs.readFile(deps.configPath, 'utf8'));
  } catch (e) {
    throw new Error(`config.json could not be read: ${(e as Error).message}`);
  }
  const platforms = (configJson as { platforms?: unknown }).platforms;
  const blocks = (Array.isArray(platforms) ? platforms : [])
    .filter((b): b is Record<string, unknown> =>
      !!b && typeof b === 'object' && (b as { platform?: unknown }).platform === 'AmbientWeatherSensors');
  if (blocks.length === 0) {
    throw new Error('No AmbientWeatherSensors platform block found in config.json.');
  }

  const warnings: EditorDiagnosticDto[] = [];
  if (blocks.length > 1) {
    warnings.push({
      severity: 'warning',
      code: 'duplicate-platform-blocks',
      message: `${blocks.length} AmbientWeatherSensors platform blocks found in config.json; showing the first. `
        + 'Saving is refused while duplicates exist — remove the extra block(s).',
    });
  }
  const block = blocks[0];

  const modeResult = detectConfigMode(block as ConfigInputShape);
  const v2FlagEnabled = detectV2FlagSource(block as ConfigInputShape, deps.env ?? process.env) !== 'none';
  // detectConfigMode already includes safeModeBanner in warnings —
  // no separate push, or safe mode would show the banner twice.
  for (const w of modeResult.warnings) {
    warnings.push({ severity: 'warning', code: 'config-mode', message: w });
  }
  if (modeResult.mode === 'safe-mode') {
    return {
      configMode: 'safe-mode',
      v2FlagEnabled,
      editorAvailable: false,
      version: deps.version,
      stations: [],
      authored: [],
      authoredSource: 'sensorMap',
      rows: [],
      warnings,
      errors: [],
      notes: [],
    };
  }

  // §8.7 inventory + overrides — the same assembly compose-save uses.
  // A LEGACY config is presented as its compat translation, so the
  // editor shows exactly what a pure migration would produce.
  const discovery = await loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log);
  const uiState = await loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log);
  const sources = new Map<string, EditorStationDto['source']>();
  const assemble = (overridesForMacs: ReadonlyArray<SensorMapOverride>): StationInventory =>
    assembleStationInventory({
      liveStations: p.liveStations,
      discovery,
      cachedAccessoryUniqueIds: p.cachedAccessoryUniqueIds,
      overrideSources: [
        Array.isArray(block.sensorMap) ? (block.sensorMap as SensorMapOverride[]) : [],
        overridesForMacs,
      ],
      sources,
    });
  let overrides: SensorMapOverride[];
  let stations: StationInventory;
  if (modeResult.mode === 'legacy') {
    stations = assemble([]);
    overrides = compatToOverrides(block as LegacyConfig, stations);
    stations = assemble(overrides);
  } else {
    overrides = Array.isArray(block.sensorMap) ? (block.sensorMap as SensorMapOverride[]) : [];
    stations = assemble(overrides);
  }

  const effectiveMap = buildEffectiveSensorMap({
    userOverrides: overrides,
    discovery,
    uiState,
    stations,
    configMode: 'v2',
  });
  const layers = partitionOverrideLayers(overrides);

  const rows = effectiveMap.rows
    .map(row => toEditorRowDto(row, layers))
    .sort((a, b) => a.stationMac === b.stationMac
      ? (a.dataPoint < b.dataPoint ? -1 : a.dataPoint > b.dataPoint ? 1 : 0)
      : (a.stationMac < b.stationMac ? -1 : 1));

  for (const w of effectiveMap.warnings) {
    warnings.push(toDiagnosticDto('warning', w));
  }

  return {
    configMode: modeResult.mode,
    v2FlagEnabled,
    editorAvailable: false, // flips true in PR C (finding 5 closure)
    version: deps.version,
    stations: stations.map(st => {
      const mac = st.macAddress.toUpperCase();
      const dto: EditorStationDto = { mac, source: sources.get(mac) ?? 'override' };
      if (st.name) {
        dto.name = st.name;
      }
      return dto;
    }),
    authored: overrides.map(toAuthoredFragmentDto),
    authoredSource: modeResult.mode === 'legacy' ? 'compat-seeded' : 'sensorMap',
    rows,
    warnings,
    errors: effectiveMap.errors.map(e => toDiagnosticDto('error', e)),
    notes: effectiveMap.notes.map(n => toDiagnosticDto('note', n)),
  };
}

/**
 * Unit vocabulary for the editor's pickers (#70): per-measurement
 * options per selection context, in vocabulary display order, with
 * human-facing labels. Pure projection of UNIT_VOCABULARY — the
 * server stays the sole validity authority (§3.7).
 */
export function handleGetVocabulary(): VocabularyDto {
  const measurements: VocabularyDto['measurements'] = {};
  for (const m of Object.keys(UNIT_VOCABULARY) as Measurement[]) {
    measurements[m] = {
      customSource: unitOptionsFor(m, 'custom-source').map(o => ({ unit: o.unit, label: o.label })),
      extendedDisplay: unitOptionsFor(m, 'extended-display').map(o => ({ unit: o.unit, label: o.label })),
    };
  }
  return { measurements };
}

type OverrideLayers = ReturnType<typeof partitionOverrideLayers>;

function toEditorRowDto(row: EffectiveSensorRow, layers: OverrideLayers): EditorRowDto {
  const dto: EditorRowDto = {
    stationMac: row.stationMac,
    dataPoint: row.dataPoint,
    kind: row.kind,
    enabled: row.enabled,
    batteryField: null,
    origin: row.kind === 'unrecognized'
      ? 'unrecognized'
      : layers.station.get(row.stationMac.toUpperCase())?.has(row.dataPoint)
        ? 'station'
        : layers.global.has(row.dataPoint)
          ? 'global'
          : 'default',
  };
  if (row.firstSeen !== undefined) {
    dto.firstSeen = row.firstSeen;
  }
  if (row.lastSeen !== undefined) {
    dto.lastSeen = row.lastSeen;
  }
  if (row.kind === 'unrecognized') {
    return dto;
  }
  dto.measurement = row.measurement;
  dto.name = row.name;
  // Mirror the resolver exactly (review #32 F2): null means "no
  // battery field on this row" — the authored view shows whether that
  // came from a default or an explicit suppression.
  dto.batteryField = row.batteryField;
  dto.hasBatterySubService = row.hasBatterySubService;
  dto.embedName = row.embedName;
  dto.triggerEnabled = row.triggerEnabled;
  dto.triggerDirection = row.triggerDirection;
  if (row.threshold !== undefined) {
    dto.threshold = row.threshold;
  }
  if (row.sourceUnit !== undefined) {
    dto.sourceUnit = row.sourceUnit;
  }
  if (row.displayUnit !== undefined) {
    dto.displayUnit = row.displayUnit;
  }
  return dto;
}

/**
 * The known override vocabulary (non-identity keys). A fragment key
 * outside this set is reported by NAME only in `unknownKeys` — its
 * value is withheld because an unknown key could hold anything.
 */
const AUTHORED_FRAGMENT_FIELDS = new Set([
  'batteryField', 'displayUnit', 'embedName', 'enabled', 'kind',
  'measurement', 'name', 'sourceUnit', 'threshold', 'triggerDirection',
  'triggerEnabled',
]);

/**
 * Sanitized-but-verbatim projection of one authored override fragment
 * (review #32 F2): field presence — including explicit null and
 * wrong-typed values — survives, so the editor can render and repair
 * exactly what the user wrote. Non-object entries project to an empty
 * fragment; the validation errors at the same index say why.
 */
function toAuthoredFragmentDto(entry: unknown, index: number): EditorAuthoredFragmentDto {
  const dto: EditorAuthoredFragmentDto = { index, layer: 'global', fields: {} };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return dto;
  }
  const frag = entry as Record<string, unknown>;
  if (typeof frag.stationMac === 'string') {
    dto.layer = 'station';
    dto.stationMac = frag.stationMac;
    dto.stationMacKey = frag.stationMac.toUpperCase();
  }
  if (typeof frag.dataPoint === 'string') {
    dto.dataPoint = frag.dataPoint;
  }
  const unknownKeys: string[] = [];
  for (const key of Object.keys(frag)) {
    if (key === 'dataPoint' || key === 'stationMac') {
      continue;
    }
    if (AUTHORED_FRAGMENT_FIELDS.has(key)) {
      dto.fields[key] = frag[key];
    } else {
      unknownKeys.push(key);
    }
  }
  if (unknownKeys.length > 0) {
    dto.unknownKeys = unknownKeys.sort();
  }
  return dto;
}

/**
 * Structured diagnostic projection (review #32 F3): the stable code,
 * field, overrideIndex, and note source cross the boundary intact —
 * the needs-attention UI associates problems with authored fragments
 * by index, never by parsing messages.
 */
function toDiagnosticDto(
  severity: EditorDiagnosticDto['severity'],
  d: {
    code: string; message: string; overrideIndex?: number;
    field?: string; dataPoint?: string; stationMac?: string; source?: string;
  },
): EditorDiagnosticDto {
  const dto: EditorDiagnosticDto = { severity, code: d.code, message: d.message };
  if (d.overrideIndex !== undefined) {
    dto.overrideIndex = d.overrideIndex;
  }
  if (d.field !== undefined) {
    dto.field = d.field;
  }
  if (d.dataPoint !== undefined) {
    dto.dataPoint = d.dataPoint;
  }
  if (d.stationMac !== undefined) {
    dto.stationMac = d.stationMac;
  }
  if (d.source !== undefined) {
    dto.source = d.source;
  }
  return dto;
}

/** §8.7 station-inventory union, in preference order (names from the freshest source). */
function assembleStationInventory(src: {
  liveStations: unknown;
  discovery: DiscoveryStore;
  cachedAccessoryUniqueIds: unknown;
  overrideSources: ReadonlyArray<ReadonlyArray<SensorMapOverride>>;
  /**
   * Optional collector: MAC → the FIRST §8.7 source that contributed
   * it (preference order == insertion order). Names may still be
   * upgraded by a later source; identity attribution is first-sight.
   * Used by /editor-state; compose-save call sites don't pass it.
   */
  sources?: Map<string, EditorStationDto['source']>;
}): StationInventory {
  const byMac = new Map<string, string>(); // MAC → name ('' when unknown)
  const add = (mac: string, name: string, source: EditorStationDto['source']): void => {
    const key = mac.toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(key)) {
      return;
    }
    const existing = byMac.get(key);
    if (existing === undefined) {
      src.sources?.set(key, source);
    }
    if (existing === undefined || (existing === '' && name !== '')) {
      byMac.set(key, name);
    }
  };
  // 1. Live response (freshest names win by insertion order).
  if (Array.isArray(src.liveStations)) {
    for (const s of src.liveStations) {
      if (s && typeof s === 'object' && typeof (s as { macAddress?: unknown }).macAddress === 'string') {
        add((s as { macAddress: string }).macAddress, String((s as { name?: unknown }).name ?? ''), 'live');
      }
    }
  }
  // 2. Discovery registry.
  for (const e of src.discovery.entries) {
    add(e.stationMac, e.stationName ?? '', 'discovery');
  }
  // 3. Cached-accessory uniqueId prefixes (MAC-dataPoint).
  if (Array.isArray(src.cachedAccessoryUniqueIds)) {
    for (const uid of src.cachedAccessoryUniqueIds) {
      if (typeof uid === 'string' && uid.length >= 17) {
        add(uid.slice(0, 17), '', 'cached-accessory');
      }
    }
  }
  // 4. stationMac values in current + proposed overrides.
  for (const list of src.overrideSources) {
    for (const o of list) {
      if (typeof o.stationMac === 'string') {
        add(o.stationMac, '', 'override');
      }
    }
  }
  return [...byMac.entries()].map(([macAddress, name]) => ({ macAddress, name }));
}

/**
 * Deterministically pick a valid, locally-administered MAC that is
 * GUARANTEED absent from the assembled inventory (review #67 round 3):
 * a fixed probe constant could collide with a real station or override,
 * dedupe into the existing row, and silently skip the future-station
 * template-equivalence check. Scans 02:00:00:00:XX:YY candidates in
 * order and returns the first unused one.
 */
export function syntheticProbeMac(existingMacs: ReadonlyArray<string>): string {
  const taken = new Set(existingMacs.map(m => m.toUpperCase()));
  for (let hi = 0; hi <= 0xff; hi++) {
    for (let lo = 0; lo <= 0xff; lo++) {
      const candidate = `02:00:00:00:${hex(hi)}:${hex(lo)}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }
  // 65 536 taken locally-administered probes is not a realistic
  // inventory; fail loudly rather than reuse a station.
  throw new Error('syntheticProbeMac: no unused probe MAC available.');
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Compare two effective maps' CONFIGURED rows (full row content,
 * structural signature included). Returns the diverging keys with both
 * sides' signatures for the error payload. (The discriminated-union
 * rows are treated as plain records here — comparison only.)
 */
export interface DivergentRow {
  stationMac: string;
  dataPoint: string;
  before: string;
  after: string;
}

interface EffectiveRowsHolder {
  rows: ReadonlyArray<Record<string, unknown> & { kind: string }>;
}
function diffEffectiveRows(
  before: EffectiveRowsHolder,
  after: EffectiveRowsHolder,
): DivergentRow[] {
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
  const divergent: DivergentRow[] = [];
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

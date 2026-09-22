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

import { createHash } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { buildEffectiveSensorMap, partitionOverrideLayers } from '../dist/sensorMap/buildEffectiveMap.js';
import { canonicalizeSensorMap } from '../dist/sensorMap/canonicalizeSensorMap.js';
import { compatToOverrides, dynamicDataPointsFrom, type LegacyConfig } from '../dist/sensorMap/compat.js';
import { detectConfigMode, type ConfigInputShape } from '../dist/sensorMap/configMode.js';
import {
  composeV2ConfigSave,
  journalConversionBaseline,
  verifyConversionJournalReadable,
  recognizeMirror,
  verifyLegacySnapshot,
  writeLegacySnapshot,
} from '../dist/sensorMap/legacyMirror.js';
import { sensorMapShapeError, type EffectiveMapConfig } from '../dist/sensorMap/platformEffectiveMap.js';
import { NON_TRIGGERING_MEASUREMENTS, STATION_MAC_REGEX } from '../dist/sensorMap/validation.js';
import { filterStationInventory, indeterminateFilterStations } from '../dist/sensorMap/stationMatch.js';
import { composeRowDisplayName } from '../dist/sensorMap/displayName.js';
import { v2ConstructionEnabled } from '../dist/sensorMap/v2Flag.js';
import {
  loadDiscoveryStore,
} from '../dist/sensorMap/persistence/discoveryStore.js';
import {
  loadNoticeStore,
} from '../dist/sensorMap/persistence/noticesStore.js';
import {
  loadUiStateStore,
} from '../dist/sensorMap/persistence/uiStateStore.js';
import { DISPLAY_FAMILIES, MEASUREMENT_LABELS, UNIT_VOCABULARY, unitOptionsFor } from '../dist/sensorMap/unitVocabulary.js';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT, WRAPPER_PAIR_SINCE } from '../dist/sensorMap/wrappers.js';
import { VENDOR_INVERTED_BATTERY_FIELDS, batteryDecoderPolicy } from '../dist/batteryFields.js';
import { defaultRowForConfigOverride, defaultRowFor } from '../dist/sensorMap/defaultMap.js';
import { CURRENT_CATALOG_VERSION, parseCatalogStamps, type CatalogStamps } from '../dist/sensorMap/catalogVersion.js';
import { PLUGIN_NAME } from '../dist/settings.js';
import type { Logger, ReadStoreOptions } from '../dist/sensorMap/persistence/atomicWrite.js';
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
  EditorRowDefaultsDto,
  EditorRowDto,
  EditorStateDto,
  EditorStationDto,
  BatteryPolarityChangeDto,
  ConfigOnlyChangeDto,
  CapabilityOptionDto,
  LegacyVocabularyDto,
  PreviewChangeDto,
  PreviewResultDto,
  VocabularyDto,
  VocabularyResponseDto,
} from './app-src/dto/editor-state.js';

export interface HandlerDeps {
  persistDir: string;
  /**
   * Homebridge storage path, when the host provides it. Lets the
   * unsaved-settings gate read the DYNAMIC schema (the one the form
   * actually rendered in v2-live mode); absent, the packaged schema
   * governs, as it does for HB UI X itself.
   */
  storagePath?: string;
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

/**
 * The UI bridge is a READ-ONLY consumer of the platform's persistence
 * stores (§8 single-writer): it must never quarantine-rename a corrupt
 * file — recovery mutation belongs to the writer (the platform), and
 * endpoints like /preview-save promise zero writes of any kind.
 */
const READ_ONLY_STORE: ReadStoreOptions = { quarantineCorrupt: false };

export interface StatusPayload {
  version: string;
  v2Flag: {
    enabled: boolean;
    source: 'env' | 'default' | 'opted-out';
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
  /**
   * The sensor-map row editor is LIVE (#69 PR C): the editor's save
   * path runs exclusively through composeAndPersist → /compose-save,
   * with structural saves gated on the /preview-save confirmation
   * digest. This is the finding-5 closure flag.
   */
  sensorMapEditorAvailable: true;
  /**
   * The guarded compose-save boundary is installed: any sensorMap
   * write MUST flow through /compose-save (snapshot-first). Ordinary
   * legacy schema settings remain writable through the standard form
   * and do not flow through it.
   */
  composeSaveAvailable: true;
  /**
   * The server-authoritative preview endpoint is installed (#69 PR B):
   * drafts can be dry-run through the REAL save pipeline with zero
   * writes, with or without the v2 flag. Saving is live (PR C) and
   * flag-gated: /compose-save refuses with 'v2-flag-off' when the
   * flag is off.
   */
  previewSaveAvailable: true;
}

export async function handleGetStatus(deps: HandlerDeps, payload: unknown): Promise<StatusPayload> {
  const config = extractConfig(payload);
  const modeResult = detectConfigMode(config);
  const flagSource = detectV2FlagSource(config, deps.env ?? process.env);
  return {
    version: deps.version,
    v2Flag: {
      enabled: flagSource !== 'opted-out',
      source: flagSource,
    },
    configMode: modeResult.mode,
    configWarnings: modeResult.warnings,
    safeModeBanner: modeResult.safeModeBanner,
    readOnly: true,
    sensorMapEditorAvailable: true,
    composeSaveAvailable: true,
    previewSaveAvailable: true,
  };
}

export async function handleGetDiscovery(deps: HandlerDeps): Promise<DiscoveryStore> {
  return loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log, undefined, READ_ONLY_STORE);
}

export async function handleGetNotices(deps: HandlerDeps): Promise<NoticeStore> {
  return loadNoticeStore(path.join(deps.persistDir, 'notices.json'), deps.log, undefined, READ_ONLY_STORE);
}

export async function handleGetUiState(deps: HandlerDeps): Promise<UiStateStore> {
  return loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log, undefined, READ_ONLY_STORE);
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

/**
 * Post-flip (GA #65): v2 construction is the DEFAULT. The source
 * distinguishes only the explicit opt-outs — 'default' and 'env' mean
 * enabled; 'opted-out' means an explicit config/env disable.
 */
function detectV2FlagSource(
  config: ConfigInputShape | undefined,
  env: NodeJS.ProcessEnv,
): 'env' | 'default' | 'opted-out' {
  if (env.SENSOR_MAP_V2 === '1' || env.SENSOR_MAP_V2 === 'true') {
    return 'env';
  }
  return v2ConstructionEnabled({ env, config: (config as Record<string, unknown>) ?? {} })
    ? 'default'
    : 'opted-out';
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

/** See ComposeSaveResult.snapshot for the phase semantics. */
export type SnapshotOutcome =
  | 'written' | 'exists' | 'journaled' | 'not-applicable'
  | 'pending-write' | 'pending-journal';

export type ComposeSaveError =
  | { code: 'config-unreadable'; message: string }
  | { code: 'catalog-stamps'; message: string }
  | { code: 'invalid-adoption'; message: string }
  | { code: 'no-platform-block'; message: string }
  | { code: 'stale-base'; message: string }
  | { code: 'ambiguous-platform-block'; message: string }
  | { code: 'safe-mode'; message: string }
  | { code: 'sensor-map-shape'; message: string }
  | { code: 'v2-flag-off'; message: string }
  | { code: 'persistence-indeterminate'; message: string; stage: 'updatePluginConfig' | 'savePluginConfig' }
  | { code: 'invalid-proposal'; message: string }
  | { code: 'invalid-rows'; message: string; rows: RowValidationError[] }
  | { code: 'no-station-inventory'; message: string }
  | { code: 'canonical-divergence'; message: string; rows: DivergentRow[] }
  | { code: 'confirmation-required'; message: string; structuralChangeCount: number }
  | { code: 'stale-confirmation'; message: string }
  | { code: 'legacy-snapshot-corrupt'; message: string }
  | { code: 'snapshot-write-failed'; message: string }
  | { code: 'conversion-journal-error'; message: string }
  | { code: 'unsaved-settings-changes'; message: string }
  | { code: 'commit-without-validation'; message: string }
  | { code: 'invalid-settings'; message: string }
  | { code: 'indeterminate-station-filter'; message: string };

export type ComposeSaveResult =
  | {
    ok: true;
    /** The composed platform block the CLIENT must persist verbatim. */
    nextConfig: Record<string, unknown>;
    /** Settings keys this save changes (names only; never values). */
    settingsChanged: string[];
    /**
     * Canonical digest of `nextConfig` — the post-save receipt: after
     * persisting and reloading /editor-state, the session's new
     * `baseDigest` must equal this value, or something between the
     * client and disk altered the block in flight (for example HB UI
     * X's merge-style config update resurrecting a deleted key).
     */
    nextConfigDigest: string;
    /**
     * Opaque token binding everything the validate phase verified —
     * the authoritative disk block, the canonicalized proposal, the
     * page's configuration-copy state, the inventory-bound
     * consequences, the composed output, and the prospective record
     * outcome. The COMMIT
     * requires it and recomputes it from current state before writing
     * anything (review #47 round 5): a commit without it, or with any
     * drift since validation, refuses with zero writes.
     */
    validationToken: string;
    /**
     * Pre-conversion-record outcome. Commit phase: 'written' (snapshot
     * created now), 'exists' (verified as the same original),
     * 'journaled' (a reconversion whose differing baseline was
     * appended to the conversion journal while the original snapshot
     * stayed untouched), or 'not-applicable' (not a legacy
     * conversion). Validate phase reports the PROSPECTIVE outcome
     * without writing: 'pending-write' / 'pending-journal' instead of
     * 'written' / 'journaled' (review #47 round 4 — an attempt
     * abandoned after validation consumes nothing).
     */
    snapshot: SnapshotOutcome;
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
   * authoritative current configuration. Only valid for callers that
   * hold a FAITHFUL copy of the on-disk block; a browser client must
   * send `baseDigest` instead (HB UI X's getPluginConfig() returns its
   * session's IN-MEMORY copy, which is not guaranteed to byte-match
   * disk).
   */
  base?: unknown;
  /**
   * Explicit catalog adoption (§18.3): advances `catalogAdopted` to
   * exactly the running plugin's catalog version, through this same
   * previewed pipeline. Absent on every ordinary save — no other
   * operation may move the stamp. Refused on legacy blocks (convert
   * first) and on the fresh-install path (born current).
   */
  adoptCatalogVersion?: unknown;
  /**
   * PREFERRED staleness token: the `baseDigest` issued by
   * /editor-state for the block this editor session loaded. The
   * server matches it against the canonical digest of each on-disk
   * block; no match means the configuration changed since the session
   * loaded. Takes precedence over `base` when both are present.
   */
  baseDigest?: unknown;
  /** Proposed sensor-map override state from the editor. */
  proposal?: unknown;
  /**
   * Live-settings patch from the consolidated page (beta.17, GA #56):
   * name, dataSource, stationFilter, embedNameUpdateMinIntervalMinutes,
   * and credential INTENTS ({ set } replaces, { clear: true } removes,
   * absent means unchanged — a blank field can never clear a secret by
   * accident). Applied to the on-disk block inside the guarded
   * transaction, before compose; covered by the validation token
   * through nextConfigDigest.
   */
  settings?: unknown;
  /**
   * Station-inventory contributions the SERVER cannot see (§8.7):
   * cached-accessory uniqueIds (from homebridge.getCachedAccessories())
   * and, when one is genuinely available, a fresh AWN station list.
   */
  cachedAccessoryUniqueIds?: unknown;
  liveStations?: unknown;
  /**
   * The confirmation digest from /preview-save (PR C / finding 5).
   * REQUIRED when the save has structural consequences (accessories
   * registering, deregistering, or re-registering): the server
   * recomputes computeSaveConsequences() from the CURRENT on-disk
   * config and inventory and refuses a missing or mismatched digest —
   * proving the user confirmed THESE consequences, not a stale
   * preview. Never returned by a refusal: the only way to obtain it
   * is /preview-save, which is what forces the confirmation UX.
   */
  confirmDigest?: unknown;
  /**
   * The page's in-memory copy of the block being edited (from
   * getPluginConfig()), sent by the SAVE flow so the server can detect
   * a DIVERGED session copy (review #47 P1-1): persistence replaces
   * the in-memory config with the disk-derived composed block, so a
   * divergence would be silently discarded. The server compares this
   * against the on-disk block, tolerating only the measured automatic
   * materialization a pre-beta.17 schema-form session left behind
   * (empty arrays for absent keys); any other difference refuses with
   * `unsaved-settings-changes`.
   */
  formBlock?: unknown;
  /**
   * REQUIRED by /commit-save: the `validationToken` the validate
   * phase returned. The commit recomputes the token from current
   * state and refuses on absence or any mismatch, so the durable
   * snapshot/journal write cannot happen without a fresh, matching
   * validation (review #47 round 5). Ignored by /compose-save.
   */
  validationToken?: unknown;
}

/**
 * Compose a v2 save: validate the proposal, verify the structural
 * confirmation digest, make the pre-conversion legacy record durable
 * FIRST (the immutable snapshot on a first conversion; an appended
 * conversion-journal baseline on a reconversion whose legacy fields
 * differ from the original), and only then return the composed next
 * config for the client to persist through HB UI X's API. The
 * composed config physically cannot reach config.json before that
 * record is durable.
 *
 * Refusals return `{ ok: false, error }` (JSON-safe, editor-consumable)
 * and perform NO writes — with one deliberate exception: a successful
 * snapshot write followed by a later refusal is harmless (the snapshot
 * is the pre-conversion record either way and is verified on the next
 * attempt); the same holds for a journal append.
 */
/**
 * Everything the validation pipeline resolves for a proposed save.
 * Produced by runSavePipeline and consumed by BOTH /compose-save and
 * /preview-save — the preview cannot diverge from the save because
 * they are the same computation (review #69 PR B: the browser never
 * gets a second, weaker validation path).
 */
interface SavePipelineContext {
  block: Record<string, unknown>;
  /** The assembled inventory through the ON-DISK block's stationFilter (the before runtime world). */
  stationsBefore: StationInventory;
  /** The assembled inventory through the PATCHED block's stationFilter (the after runtime world). */
  stationsAfter: StationInventory;
  /** The block with the settings patch applied — what compose consumes. */
  effectiveBlock: Record<string, unknown>;
  /** Settings keys the patch changed (credential VALUES never appear). */
  settingsChanged: string[];
  modeResult: ReturnType<typeof detectConfigMode>;
  proposal: SensorMapOverride[];
  stations: StationInventory;
  discovery: DiscoveryStore;
  uiState: UiStateStore;
  effectiveMap: ReturnType<typeof buildEffectiveSensorMap>;
  canonical: SensorMapOverride[];
  /** The block's stamps as read from disk (§18.3). */
  stampsCurrent: CatalogStamps;
  /** The stamps the composed output will carry (adoption applied). */
  stampsResolved: CatalogStamps;
}

type SavePipelineResult =
  | { ok: true; settingsOnly: SettingsOnlyCtx }
  | { ok: true; ctx: SavePipelineContext }
  | { ok: false; error: ComposeSaveError };

/**
 * Steps 1–7b of the guarded save: authoritative on-disk config, block
 * location + staleness check, mode + sensorMap-shape gates, proposal
 * shape/seeding, §8.7 inventory, same-machinery validation, canonical
 * serialization, and the hard divergence gate. Performs NO writes.
 */
type SettingsPatchOutcome =
  | { block: Record<string, unknown>; changed: string[] }
  | { error: string };

const SETTINGS_KEYS = new Set([
  'name', 'dataSource', 'stationFilter', 'embedNameUpdateMinIntervalMinutes', 'apiKey', 'applicationKey',
]);

/**
 * Apply the consolidated page's settings patch to a COPY of the
 * on-disk block. Fail-closed: any unknown key or malformed value
 * refuses the whole save. Credentials are intent-shaped; a sensor-only
 * save (no settings field at all) returns the block object UNTOUCHED,
 * so stored credentials pass through compose byte-for-byte.
 */
function applySettingsPatch(block: Record<string, unknown>, raw: unknown): SettingsPatchOutcome {
  if (raw === undefined) {
    return { block, changed: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'settings must be an object.' };
  }
  const patch = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(patch).filter(k => !SETTINGS_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return { error: `settings contains unsupported keys: ${unknownKeys.join(', ')}.` };
  }
  const next: Record<string, unknown> = { ...block };
  const changed: string[] = [];

  if ('name' in patch) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') {
      return { error: 'settings.name must be a non-empty string.' };
    }
    const v = patch.name.trim();
    if (v !== block.name) {
      next.name = v;
      changed.push('name');
    }
  }

  if ('dataSource' in patch) {
    if (patch.dataSource !== 'polling' && patch.dataSource !== 'realtime') {
      return { error: "settings.dataSource must be 'polling' or 'realtime'." };
    }
    const current = block.dataSource === 'realtime' ? 'realtime' : 'polling';
    if (patch.dataSource !== current) {
      if (patch.dataSource === 'polling') {
        delete next.dataSource; // polling is the default; keep the block minimal
      } else {
        next.dataSource = 'realtime';
      }
      changed.push('dataSource');
    }
  }

  if ('stationFilter' in patch) {
    if (!Array.isArray(patch.stationFilter)
      || patch.stationFilter.some(e => typeof e !== 'string')) {
      return { error: 'settings.stationFilter must be an array of strings.' };
    }
    const v = (patch.stationFilter as string[]).map(e => e.trim()).filter(e => e !== '');
    const current = Array.isArray(block.stationFilter) ? block.stationFilter : [];
    if (JSON.stringify(v) !== JSON.stringify(current)) {
      if (v.length === 0) {
        delete next.stationFilter;
      } else {
        next.stationFilter = v;
      }
      changed.push('stationFilter');
    }
  }

  if ('embedNameUpdateMinIntervalMinutes' in patch) {
    const v = patch.embedNameUpdateMinIntervalMinutes;
    if (v === null) {
      if ('embedNameUpdateMinIntervalMinutes' in block) {
        delete next.embedNameUpdateMinIntervalMinutes;
        changed.push('embedNameUpdateMinIntervalMinutes');
      }
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { error: 'settings.embedNameUpdateMinIntervalMinutes must be a non-negative number (or null to reset).' };
    } else if (v !== block.embedNameUpdateMinIntervalMinutes) {
      next.embedNameUpdateMinIntervalMinutes = v;
      changed.push('embedNameUpdateMinIntervalMinutes');
    }
  }

  for (const key of ['apiKey', 'applicationKey'] as const) {
    if (!(key in patch)) {
      continue; // unchanged: the stored secret passes through untouched
    }
    const intent = patch[key];
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
      return { error: `settings.${key} must be { set: <value> } or { clear: true }.` };
    }
    const { set, clear, ...rest } = intent as { set?: unknown; clear?: unknown };
    if (Object.keys(rest).length > 0 || (set !== undefined && clear !== undefined)) {
      return { error: `settings.${key} must carry exactly one of set / clear.` };
    }
    if (clear !== undefined) {
      if (clear !== true) {
        return { error: `settings.${key}.clear must be literally true.` };
      }
      if (key in block) {
        delete next[key];
        changed.push(key);
      }
    } else if (set !== undefined) {
      if (typeof set !== 'string' || set.trim() === '') {
        return { error: `settings.${key}.set must be a non-empty string.` };
      }
      // Deliberately marked changed even when the value equals the
      // stored one: comparing would create an equality oracle on a
      // secret.
      next[key] = set.trim();
      changed.push(key);
    } else {
      return { error: `settings.${key} must carry exactly one of set / clear.` };
    }
  }

  return { block: next, changed };
}

/**
 * The base token /editor-state issues when NO platform block exists
 * (GA review P1-2): a fresh installation has nothing to digest, and
 * the settings-only save that creates the block must still prove the
 * session saw that state (a block appearing in the meantime refuses
 * as stale, exactly like any other base drift).
 */
export const FRESH_INSTALL_DIGEST = 'fresh-install:no-platform-block';

/**
 * A SETTINGS-ONLY save (GA review P1-2/P1-3): the sensor map is
 * untouched (the proposal canonically equals the on-disk authored
 * state, or no block exists yet) and only connection settings change.
 * It runs a guarded path with no station-inventory requirement and
 * NEVER converts: nothing sensor-map-shaped is written, so a legacy
 * block stays legacy and a fresh block is created plain. This is how
 * a new installation enters credentials and how broken credentials
 * are corrected before the first successful discovery.
 */
export interface SettingsOnlyCtx {
  /** The on-disk block, or null on a fresh installation. */
  block: Record<string, unknown> | null;
  effectiveBlock: Record<string, unknown>;
  settingsChanged: string[];
  freshInstall: boolean;
}

/**
 * Settings whose change has NO accessory consequence: the
 * settings-only path may carry these and nothing else. stationFilter
 * is deliberately absent — narrowing or widening it registers and
 * deregisters accessories, so it always takes the full pipeline with
 * its inventory-bound preview.
 */
const CONSEQUENCE_FREE_SETTINGS: ReadonlySet<string> = new Set([
  'name', 'apiKey', 'applicationKey', 'dataSource', 'embedNameUpdateMinIntervalMinutes',
]);

function settingsOnlyDigest(block: Record<string, unknown> | null, settingsChanged: string[]): string {
  return createHash('sha256').update(canonicalJsonLocal({
    v: 'settings-only-1',
    base: block,
    settingsChanged: [...settingsChanged].sort(),
  })).digest('hex');
}

async function runSavePipeline(
  deps: HandlerDeps,
  p: ComposeSavePayload,
): Promise<SavePipelineResult> {
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
    // Fresh installation (GA review P1-2): the ONLY save that may
    // proceed with no block is the settings-only save that creates
    // one — the session must have loaded the fresh-install state, the
    // proposal must be empty, and a settings patch must exist. The
    // created block is PLAIN (no v2 markers): it stays a
    // never-converted configuration until the first sensor-map save.
    if (p.baseDigest !== FRESH_INSTALL_DIGEST) {
      return { ok: false, error: { code: 'no-platform-block', message: 'No AmbientWeatherSensors platform block found in config.json.' } };
    }
    if (Array.isArray(p.proposal) && p.proposal.length > 0) {
      return { ok: false, error: { code: 'no-platform-block', message: 'No platform block exists yet: sensors cannot be configured before the first connection. Save the connection settings first.' } };
    }
    if (p.adoptCatalogVersion !== undefined) {
      return { ok: false, error: { code: 'invalid-adoption', message: 'A fresh installation is already at the current catalog version; there is nothing to adopt. Nothing was written.' } };
    }
    // Born stamped (§18.3): a fresh installation's exposure history is
    // "knew the current catalog from birth", and later saves preserve
    // the pair verbatim — it is never rewound by the first sensor-map
    // save.
    const skeleton: Record<string, unknown> = {
      platform: 'AmbientWeatherSensors', name: 'AmbientWeather',
      catalogBaseline: CURRENT_CATALOG_VERSION, catalogAdopted: CURRENT_CATALOG_VERSION,
    };
    const outcome = applySettingsPatch(skeleton, p.settings);
    if ('error' in outcome) {
      return { ok: false, error: { code: 'invalid-settings', message: `${outcome.error} Nothing was written.` } };
    }
    if (outcome.changed.length === 0) {
      return { ok: false, error: { code: 'invalid-settings', message: 'Nothing to save yet: enter the connection settings first. Nothing was written.' } };
    }
    if (!outcome.changed.every(k => CONSEQUENCE_FREE_SETTINGS.has(k))) {
      return { ok: false, error: { code: 'invalid-settings', message: 'Only connection settings can be saved before the plugin first connects. Nothing was written.' } };
    }
    return { ok: true, settingsOnly: { block: null, effectiveBlock: outcome.block, settingsChanged: outcome.changed, freshInstall: true } };
  }
  // ---- 1b. Exactly-one-block invariant (review #47 P1-2). The
  //          session token identifies a block by CONTENT, while the
  //          client replaces a block by POSITION — with multiple
  //          blocks those can disagree, composing one Home's block and
  //          overwriting another's. Until a multi-Home editor exists,
  //          previews and saves refuse outright; /editor-state keeps
  //          `editorAvailable: false` for the same configs.
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

  // ---- 2. Locate the block being edited — which doubles as the
  //         stale-session check: if the on-disk block no longer equals
  //         what the client loaded, refuse rather than compose against
  //         a stale view. The PREFERRED token is `baseDigest`, the
  //         canonical digest /editor-state issued for the block it
  //         rendered: HB UI X's getPluginConfig() hands the client its
  //         session's IN-MEMORY config, which is not guaranteed to
  //         byte-match disk (pre-beta.17 the schema form materialized
  //         defaults into it; beta.13 smoke: preview refused
  //         stale-base on an untouched config). The
  //         digest ties the session to what the EDITOR loaded from
  //         disk instead. A raw `base` block is still accepted for
  //         callers that hold a faithful copy.
  const wantDigest = typeof p.baseDigest === 'string' && p.baseDigest.length > 0;
  const baseJson = wantDigest ? undefined : canonicalJsonLocal(p.base);
  const matches = blocks.filter(b => (wantDigest
    ? blockDigest(b) === p.baseDigest
    : canonicalJsonLocal(b) === baseJson));
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
  const block = matches[0];

  // ---- 3. Mode detection from the ON-DISK block (single authority).
  const modeResult = detectConfigMode(block as ConfigInputShape);
  if (modeResult.mode === 'safe-mode') {
    return { ok: false, error: { code: 'safe-mode', message: 'UI saves are refused in safe mode (§5). Fix or restore the configuration first.' } };
  }

  // ---- 3b. Malformed-sensorMap hard stop (same gate the runtime and
  //          /editor-state apply): a present-but-non-array sensorMap
  //          means the editor rendered ZERO rows, so any draft was
  //          composed from nothing — previewing or saving it would
  //          silently REPLACE a configuration the runtime refused to
  //          interpret. Refuse; the user must repair config.json first.
  const shapeErr = sensorMapShapeError(block as EffectiveMapConfig, modeResult.mode);
  if (shapeErr !== undefined) {
    return { ok: false, error: { code: 'sensor-map-shape', message: shapeErr } };
  }

  // ---- 3b2. Catalog stamps (§18.3). Mode detection validates the
  //           pair in EVERY mode and fails invalid stamps closed into
  //           safe mode before this point; this parse is a defensive
  //           redundant gate on the same rule. A valid existing pair
  //           is preserved verbatim through compose; only a config
  //           with BOTH stamps absent initializes to (1, 1), the
  //           behavior it already had.
  const stampResult = parseCatalogStamps(block as Record<string, unknown>);
  if (stampResult.status === 'invalid') {
    return {
      ok: false,
      error: {
        code: 'catalog-stamps',
        message: `The catalog adoption stamps are invalid: ${stampResult.problem}. `
          + 'Repair the catalogBaseline/catalogAdopted fields in the JSON config editor. Nothing was written.',
      },
    };
  }
  const stampsCurrent = stampResult.stamps;
  let stampsResolved = stampsCurrent;
  if (p.adoptCatalogVersion !== undefined) {
    if (modeResult.mode === 'legacy') {
      return { ok: false, error: { code: 'invalid-adoption', message: 'Catalog adoption requires a converted (v2) configuration. Save the sensor map first, then adopt. Nothing was written.' } };
    }
    if (p.adoptCatalogVersion !== CURRENT_CATALOG_VERSION) {
      return { ok: false, error: { code: 'invalid-adoption', message: `adoptCatalogVersion must be exactly ${CURRENT_CATALOG_VERSION} (the catalog version this plugin ships). Nothing was written.` } };
    }
    if (p.adoptCatalogVersion < stampsCurrent.catalogAdopted) {
      return { ok: false, error: { code: 'invalid-adoption', message: 'This configuration has already adopted a newer catalog. Nothing was written.' } };
    }
    stampsResolved = { catalogBaseline: stampsCurrent.catalogBaseline, catalogAdopted: p.adoptCatalogVersion };
  }

  // ---- 3c. SETTINGS PATCH (beta.17, GA #56): applied to a copy of
  //          the on-disk block inside this transaction, fail-closed on
  //          any malformed value. Compose consumes the PATCHED block;
  //          the base digest and the configuration-copy drift gate
  //          keep judging the on-disk one.
  const settingsOutcome = applySettingsPatch(block as Record<string, unknown>, p.settings);
  if ('error' in settingsOutcome) {
    return { ok: false, error: { code: 'invalid-settings', message: `${settingsOutcome.error} Nothing was written.` } };
  }
  const effectiveBlock = settingsOutcome.block;
  const settingsChanged = settingsOutcome.changed;

  // ---- 3d. SETTINGS-ONLY SHORT-CIRCUIT (GA review P1-3): when the
  //          proposal canonically equals the on-disk authored state
  //          and only settings change, the save needs no station
  //          inventory (broken credentials mean there may BE none)
  //          and performs no conversion. Any sensor-map difference
  //          falls through to the full pipeline, fail-closed.
  if (settingsChanged.length > 0
    && p.adoptCatalogVersion === undefined
    && settingsChanged.every(k => CONSEQUENCE_FREE_SETTINGS.has(k))
    && Array.isArray(p.proposal)) {
    const authoredNow: unknown = modeResult.mode === 'legacy'
      ? undefined // computed below only if the cheap v2 check missed
      : (Array.isArray(block.sensorMap) ? block.sensorMap : []);
    let untouched = authoredNow !== undefined
      && canonicalJsonLocal(p.proposal) === canonicalJsonLocal(authoredNow);
    if (!untouched && modeResult.mode === 'legacy') {
      // Replicate /editor-state's compat seeding exactly, so the
      // client's untouched proposal (rebuilt from that authored view)
      // compares equal.
      const discoveryEq = await loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log, undefined, READ_ONLY_STORE);
      const assembleEq = (overridesForMacs: ReadonlyArray<unknown>): StationInventory =>
        assembleStationInventory({
          liveStations: p.liveStations,
          discovery: discoveryEq,
          cachedAccessoryUniqueIds: p.cachedAccessoryUniqueIds,
          overrideSources: [Array.isArray(block.sensorMap) ? (block.sensorMap as unknown[]) : [], overridesForMacs],
        });
      const seeded = compatToOverrides(block as LegacyConfig, assembleEq([]), dynamicDataPointsFrom(discoveryEq));
      untouched = canonicalJsonLocal(p.proposal) === canonicalJsonLocal(seeded);
    }
    if (untouched) {
      return { ok: true, settingsOnly: { block, effectiveBlock, settingsChanged, freshInstall: false } };
    }
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
  const discovery = await loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log, undefined, READ_ONLY_STORE);
  const uiState = await loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log, undefined, READ_ONLY_STORE);
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
  let assembled: StationInventory;
  if (p.proposal === undefined) {
    // Compat seeding is an AUTHORING concern: it translates the
    // legacy config's semantics for every station, unfiltered — the
    // station filter narrows the runtime, never the configuration.
    proposal = compatToOverrides(block as LegacyConfig, assemble([]), dynamicDataPointsFrom(discovery));
    assembled = assemble(proposal);
  } else {
    proposal = p.proposal as SensorMapOverride[];
    assembled = assemble(proposal);
  }
  // THREE inventory views (PR #60 review rounds 1-2). The runtime
  // applies stationFilter BEFORE reconciliation, so runtime
  // CONSEQUENCES are computed per side through that side's filter —
  // the before-world through the on-disk filter, the after-world
  // through the patched one. But the filter is a runtime-visibility
  // concern, never an authoring concern: validation, canonical
  // serialization, the divergence gate, and the mirror all use the
  // UNFILTERED inventory, so a filtered-out station's overrides and
  // custom identities stay byte-present in the saved configuration
  // (round 2 P1: canonicalize skips entries for stations absent from
  // its inventory — feeding it a filtered list deletes config). The
  // availability gate also stays unfiltered: a deliberately
  // non-matching filter (the documented accessory-wipe trick) is a
  // valid save, not a missing-inventory condition.
  // FAIL CLOSED on indeterminate filter membership (round 3 P1): a
  // name-form filter cannot be evaluated for a station whose name the
  // assembled inventory does not know (cached-only or override-derived
  // stations carry no name), while the runtime evaluates the same
  // filter after fetching, with the real name. Interpreting the
  // unknown name as excluded could preview ZERO consequences for a
  // structural operation the runtime will perform. Refuse with the
  // remedies instead.
  for (const [label, filt] of [
    ['current', (block as Record<string, unknown>).stationFilter],
    ['proposed', effectiveBlock.stationFilter],
  ] as const) {
    const indeterminate = indeterminateFilterStations(assembled, filt);
    if (indeterminate.length > 0) {
      const macs = indeterminate.map(st => st.macAddress).join(', ');
      return {
        ok: false,
        error: {
          code: 'indeterminate-station-filter',
          message: `The ${label} station filter uses station names, but the name of station ${macs} is not known `
            + 'yet (the station is known only from cached accessories or overrides), so the preview cannot '
            + 'determine which accessories the filter keeps. Run the plugin until it records the station in its '
            + 'discovery data, or use the MAC form in the station filter. Nothing was written.',
        },
      };
    }
  }
  const stationsBefore = filterStationInventory(assembled, (block as Record<string, unknown>).stationFilter);
  const stationsAfter = filterStationInventory(assembled, effectiveBlock.stationFilter);
  const stations = assembled;
  const legacyEnablesSensors = LEGACY_CATEGORY_TOGGLES.some(k => block[k] === true);
  const wouldConfigure = legacyEnablesSensors
    || proposal.length > 0
    || (Array.isArray(block.sensorMap) && block.sensorMap.length > 0);
  if (assembled.length === 0 && wouldConfigure) {
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
    catalogBaseline: stampsResolved.catalogBaseline,
    catalogAdopted: stampsResolved.catalogAdopted,
  });
  if (effectiveMap.errors.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invalid-rows',
        message: `${effectiveMap.errors.length} proposed ${effectiveMap.errors.length === 1 ? 'row' : 'rows'} failed validation; nothing was written.`,
        rows: effectiveMap.errors,
      },
    };
  }

  // ---- 7. The SERVER assembles canonical config (§11.3/§17.4) — the
  //         client is never responsible for canonical serialization.
  const canonical = canonicalizeSensorMap({
    overrides: proposal, stations, discovery, uiState,
    catalogBaseline: stampsResolved.catalogBaseline,
    catalogAdopted: stampsResolved.catalogAdopted,
  });

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
    catalogBaseline: stampsResolved.catalogBaseline,
    catalogAdopted: stampsResolved.catalogAdopted,
  });
  const reloaded = buildEffectiveSensorMap({
    userOverrides: canonical,
    discovery,
    uiState,
    stations: gateStations,
    configMode: 'v2',
    catalogBaseline: stampsResolved.catalogBaseline,
    catalogAdopted: stampsResolved.catalogAdopted,
  });
  const divergent = diffEffectiveRows(gateBefore as unknown as EffectiveRowsHolder, reloaded as unknown as EffectiveRowsHolder);
  if (divergent.length > 0) {
    return {
      ok: false,
      error: {
        code: 'canonical-divergence',
        message: 'Canonical serialization would change the meaning of this configuration for '
          + `${divergent.length} ${divergent.length === 1 ? 'row' : 'rows'}, most commonly because multiple rows claim the same battery `
          + 'field and ownership depends on authoring order, which canonical (sorted) output does not '
          + "preserve. Make ownership explicit (set batteryField: null on each non-owning row, or "
          + 'assign distinct battery fields) and retry. Nothing was written.',
        rows: divergent,
      },
    };
  }

  return {
    ok: true,
    ctx: { block, effectiveBlock, settingsChanged, modeResult, proposal, stations, stationsBefore, stationsAfter, discovery, uiState, effectiveMap, canonical, stampsCurrent, stampsResolved },
  };
}

/**
 * VALIDATE phase of the two-phase save (review #47 round 4, P1-2):
 * every gate and the full composition run, but NOTHING is durably
 * recorded — no snapshot, no journal entry. The client re-samples its
 * in-memory configuration copy after this succeeds, then calls
 * /commit-save; an attempt abandoned at the re-check consumes nothing,
 * and the permanent snapshot always describes the configuration
 * immediately preceding an ACTUAL conversion. The `snapshot` result
 * reports the prospective outcome ('pending-write' /
 * 'pending-journal') so refusable record problems (corrupt snapshot,
 * corrupt journal) surface here, before anything is written.
 */
export async function handleComposeSave(
  deps: HandlerDeps,
  payload: unknown,
): Promise<ComposeSaveResult> {
  return composeSaveInternal(deps, payload, false);
}

/**
 * COMMIT phase: identical pipeline and gates, re-run from the current
 * disk state (nothing is trusted from the validate phase), with the
 * snapshot/journal written durably immediately before the persistable
 * config is returned. The client persists the RESULT of this call.
 */
export async function handleCommitSave(
  deps: HandlerDeps,
  payload: unknown,
): Promise<ComposeSaveResult> {
  return composeSaveInternal(deps, payload, true);
}

/**
 * Compose/commit for a SETTINGS-ONLY save (GA review P1-2/P1-3). The
 * reviewed gates that still apply, apply unchanged: the base is the
 * on-disk state (stale refuses in the pipeline), a digest session
 * must present its configuration copy and any drift refuses, and the
 * two-phase validation token binds commit to exactly the validated
 * state. What deliberately does NOT apply: the v2 opt-out gate
 * (nothing v2-shaped is written — correcting credentials under the
 * opt-out is precisely the recovery this path exists for), the
 * station-inventory requirement, conversion, and the snapshot/journal
 * record (no sensor-map bytes change).
 */
function composeSettingsOnly(
  deps: HandlerDeps,
  p: ComposeSavePayload,
  ctx: SettingsOnlyCtx,
  persist: boolean,
): ComposeSaveResult {
  const { block, effectiveBlock, settingsChanged, freshInstall } = ctx;

  if (!freshInstall) {
    if (typeof p.baseDigest === 'string' && p.formBlock === undefined) {
      return {
        ok: false,
        error: {
          code: 'unsaved-settings-changes',
          message: 'The page did not provide its configuration copy, so divergence cannot be ruled out. '
            + 'Reload the plugin settings and retry; nothing was written.',
        },
      };
    }
    if (p.formBlock !== undefined) {
      if (!p.formBlock || typeof p.formBlock !== 'object' || Array.isArray(p.formBlock)) {
        return {
          ok: false,
          error: {
            code: 'unsaved-settings-changes',
            message: 'The page configuration copy could not be verified. Reload the plugin settings and retry; nothing was written.',
          },
        };
      }
      const drifted = settingsFormDrift(p.formBlock as Record<string, unknown>, block!, deps);
      if (drifted !== undefined) {
        return {
          ok: false,
          error: {
            code: 'unsaved-settings-changes',
            message: `The page's configuration copy differs from the saved configuration ('${drifted}'). `
              + 'Reload the plugin settings page and retry; nothing was written.',
          },
        };
      }
    }
  }

  const digest = settingsOnlyDigest(block, settingsChanged);
  if (p.confirmDigest !== undefined && p.confirmDigest !== digest) {
    return {
      ok: false,
      error: {
        code: 'stale-confirmation',
        message: 'The configuration changed since this save was previewed. Preview again and re-confirm; nothing was written.',
      },
    };
  }

  const nextConfig = effectiveBlock;
  const nextConfigDigest = blockDigest(nextConfig);
  const validationToken = createHash('sha256').update(canonicalJsonLocal({
    v: 'settings-only-1',
    baseDigest: block === null ? FRESH_INSTALL_DIGEST : blockDigest(block),
    formBlock: p.formBlock ?? null,
    nextConfigDigest,
  })).digest('hex');
  const canonicalSensorMap = (block !== null && Array.isArray(block.sensorMap)
    ? block.sensorMap : []) as SensorMapOverride[];

  if (!persist) {
    return {
      ok: true,
      nextConfig,
      settingsChanged,
      nextConfigDigest,
      validationToken,
      snapshot: 'not-applicable',
      canonicalSensorMap,
      warnings: [],
      notes: [],
    };
  }
  if (typeof p.validationToken !== 'string' || p.validationToken.length === 0) {
    return {
      ok: false,
      error: {
        code: 'commit-without-validation',
        message: 'The commit did not present a validation token. Saves must validate first (/compose-save), '
          + 'then commit. Nothing was written.',
      },
    };
  }
  if (p.validationToken !== validationToken) {
    return {
      ok: false,
      error: {
        code: 'stale-confirmation',
        message: 'The configuration or page state changed between validating and committing this save. '
          + 'Preview again and retry; nothing was written.',
      },
    };
  }
  // No snapshot, no journal: nothing sensor-map-shaped changes.
  return {
    ok: true,
    nextConfig,
    settingsChanged,
    nextConfigDigest,
    validationToken,
    snapshot: 'not-applicable',
    canonicalSensorMap,
    warnings: [],
    notes: [],
  };
}

async function composeSaveInternal(
  deps: HandlerDeps,
  payload: unknown,
  persist: boolean,
): Promise<ComposeSaveResult> {
  const p = (payload ?? {}) as ComposeSavePayload;
  const r = await runSavePipeline(deps, p);
  if (!r.ok) {
    return r;
  }
  if ('settingsOnly' in r) {
    return composeSettingsOnly(deps, p, r.settingsOnly, persist);
  }
  const { block, effectiveBlock, settingsChanged, modeResult, effectiveMap, canonical, stampsResolved } = r.ctx;

  // ---- 7b2. V2 OPT-OUT GATE (review #45 P1-1): saving converts the
  //           configuration to v2, and a v2 config on an installation
  //           that explicitly opts out of the v2 runtime is exactly
  //           the dangerous state the rollback docs warn about (the
  //           v1.6 pipeline cannot read sensorMap and can deregister
  //           cached accessories). The editor is read-only client-side
  //           under the opt-out; this is the fail-closed server
  //           backstop. Previews stay available — a dry run is how
  //           users decide whether to remove the opt-out.
  if (detectV2FlagSource(block as ConfigInputShape, deps.env ?? process.env) === 'opted-out') {
    return {
      ok: false,
      error: {
        code: 'v2-flag-off',
        message: 'This installation explicitly opts out of the sensor-map runtime (_sensorMapV2: false or '
          + 'SENSOR_MAP_V2=0), so the runtime would not read a saved sensor map — and a v2 configuration with the '
          + 'opt-out active can deregister cached accessories. Remove the opt-out, restart Homebridge, and retry. '
          + 'Nothing was written.',
      },
    };
  }

  // ---- 7b3. CONFIGURATION-COPY DRIFT GATE (review #47 P1-1):
  //           persistence replaces HB UI X's in-memory config with the
  //           disk-derived composed block, so any divergence in that
  //           session copy would be silently discarded — and the
  //           post-save receipt would still read clean, because disk
  //           matches what was composed. When the client supplies its
  //           copy, refuse any difference from disk beyond the
  //           measured automatic materialization a pre-beta.17
  //           schema-form session left behind (empty arrays for
  //           absent keys).
  //           Fail-safe by design: unmeasured normalization refuses
  //           too, and reloading the page clears it. REQUIRED for
  //           digest sessions (review #47 round 3, P2): a digest save
  //           comes from the browser, which always holds an in-memory
  //           configuration copy — omitting formBlock must not bypass
  //           the gate. Callers without one use the faithful
  //           raw-`base` path, whose byte-equality proves the same
  //           thing.
  if (typeof p.baseDigest === 'string' && p.formBlock === undefined) {
    return {
      ok: false,
      error: {
        code: 'unsaved-settings-changes',
        message: 'The page did not provide its configuration copy, so divergence cannot be ruled out. '
          + 'Reload the plugin settings and retry; nothing was written.',
      },
    };
  }
  if (p.formBlock !== undefined) {
    if (!p.formBlock || typeof p.formBlock !== 'object' || Array.isArray(p.formBlock)) {
      return {
        ok: false,
        error: {
          code: 'unsaved-settings-changes',
          message: 'The page configuration copy could not be verified. Reload the plugin settings and retry; nothing was written.',
        },
      };
    }
    const drifted = settingsFormDrift(p.formBlock as Record<string, unknown>, block, deps);
    if (drifted !== undefined) {
      return {
        ok: false,
        error: {
          code: 'unsaved-settings-changes',
          message: `The page's configuration copy differs from the saved configuration ('${drifted}'). `
            + 'Reload the plugin settings page and retry; nothing was written.',
        },
      };
    }
  }

  // ---- 7c. STRUCTURAL CONFIRMATION GATE (PR C / finding 5): the
  //          consequences are recomputed HERE, from the current
  //          on-disk config and inventory — never trusted from the
  //          client. A save that would register, deregister, or
  //          re-register accessories requires the digest issued by
  //          /preview-save for exactly these consequences; anything
  //          missing or mismatched fails closed BEFORE the snapshot
  //          or composition. The fresh digest is deliberately NOT
  //          included in the refusal — the only way to get one is to
  //          preview, which is what puts the confirmation in front
  //          of the user.
  const consequences = computeSaveConsequences(r.ctx);
  if (p.confirmDigest !== undefined && p.confirmDigest !== consequences.digest) {
    return {
      ok: false,
      error: {
        code: 'stale-confirmation',
        message: 'The configuration, station inventory, or discovery state changed since this save was previewed. '
          + 'Preview again and re-confirm; nothing was written.',
      },
    };
  }
  if (consequences.structuralChangeCount > 0 && p.confirmDigest === undefined) {
    return {
      ok: false,
      error: {
        code: 'confirmation-required',
        message: `This save would register, deregister, or re-register ${consequences.structuralChangeCount} `
          + `${consequences.structuralChangeCount === 1 ? 'accessory' : 'accessories'}. Preview the changes and confirm them first; nothing was written.`,
        structuralChangeCount: consequences.structuralChangeCount,
      },
    };
  }
  // Adoption ALWAYS requires its own preview digest (PR #66 review
  // F4), even with zero structural consequences: advancing
  // catalogAdopted changes what every future resolution sees, and the
  // digest above binds the stamp transition, so only a preview of THIS
  // adoption can mint it.
  if (p.adoptCatalogVersion !== undefined && p.confirmDigest === undefined) {
    return {
      ok: false,
      error: {
        code: 'confirmation-required',
        message: 'Adopting the new catalog version must be previewed and confirmed first; nothing was written.',
        structuralChangeCount: consequences.structuralChangeCount,
      },
    };
  }

  // ---- 8. Compose. detectConfigMode's verdict is passed explicitly
  //         (it is the single authority on "legacy").
  const composed = composeV2ConfigSave(effectiveBlock, canonical as unknown[], effectiveMap, modeResult.mode, stampsResolved);

  // ---- 9a. Prospective pre-conversion-record outcome, READ-ONLY in
  //          BOTH phases: every refusable record problem (corrupt
  //          snapshot, unreadable journal) surfaces before anything
  //          could be written, and the outcome is bound into the
  //          validation token below (review #47 rounds 4–5).
  let snapshot: SnapshotOutcome = 'not-applicable';
  if (composed.snapshot !== undefined) {
    const verdict = await verifyLegacySnapshot(deps.persistDir, composed.snapshot);
    if (verdict === 'absent') {
      snapshot = 'pending-write';
    } else if (verdict === 'match') {
      snapshot = 'exists';
    } else if (verdict === 'mismatch') {
      try {
        await verifyConversionJournalReadable(deps.persistDir);
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'conversion-journal-error',
            message: `The conversion journal could not be read: ${(e as Error).message} `
              + 'The save was refused; nothing was written.',
          },
        };
      }
      snapshot = 'pending-journal';
    } else {
      return {
        ok: false,
        error: {
          code: 'legacy-snapshot-corrupt',
          message: 'The existing legacy snapshot could not be read for verification. Refusing to convert.',
        },
      };
    }
  }

  // ---- 9b. The validation token — SERVER-SIDE enforcement of the
  //          two-phase protocol (review #47 round 5, P1): /commit-save
  //          only writes when presented with the token /compose-save
  //          issued for EXACTLY this state — the authoritative disk
  //          block, the canonicalized proposal, the page's
  //          configuration-copy state, the inventory-bound
  //          consequences, the composed output, and the prospective
  //          record outcome. The commit
  //          recomputes the token from CURRENT state, so a direct
  //          commit (stale client, console request, future refactor)
  //          refuses before anything is written, and any drift between
  //          the phases refuses the same way. An integrity token, not
  //          an auth token: the bridge already trusts its session —
  //          the token guarantees VALIDATE-BEFORE-COMMIT on matching
  //          state; it cannot prove the browser re-sampled its
  //          in-memory configuration copy between the phases, which
  //          remains client-enforced in composeAndPersist (pinned by
  //          the hostile-mutation test).
  const nextConfigDigest = blockDigest(composed.nextConfig);
  const validationToken = createHash('sha256').update(canonicalJsonLocal({
    v: 1,
    baseDigest: blockDigest(block),
    canonical,
    formBlock: p.formBlock ?? null,
    consequencesDigest: consequences.digest,
    nextConfigDigest,
    prospectiveRecord: snapshot,
  })).digest('hex');

  if (!persist) {
    return {
      ok: true,
      nextConfig: composed.nextConfig,
      settingsChanged,
      nextConfigDigest,
      validationToken,
      snapshot,
      canonicalSensorMap: canonical,
      warnings: effectiveMap.warnings,
      notes: effectiveMap.notes,
    };
  }
  if (typeof p.validationToken !== 'string' || p.validationToken.length === 0) {
    return {
      ok: false,
      error: {
        code: 'commit-without-validation',
        message: 'The commit did not present a validation token. Saves must validate first (/compose-save), '
          + 'then commit. Nothing was written.',
      },
    };
  }
  if (p.validationToken !== validationToken) {
    return {
      ok: false,
      error: {
        code: 'stale-confirmation',
        message: 'The configuration, proposal, page state, or station inventory changed between validating '
          + 'and committing this save. Preview again and retry; nothing was written.',
      },
    };
  }

  // ---- 9c. COMMIT: the durable pre-conversion record, race-safe —
  //          exclusive-create snapshot write; on 'exists', verify
  //          against the authoritative pre-conversion fields (review
  //          P1-6), never overwrite; a verified MISMATCH is the
  //          reconversion path and appends the baseline to the journal
  //          BEFORE config.json can be mutated.
  if (composed.snapshot !== undefined) {
    let outcome: 'written' | 'exists';
    try {
      outcome = await writeLegacySnapshot(deps.persistDir, composed.snapshot, deps.log);
    } catch (e) {
      return { ok: false, error: { code: 'snapshot-write-failed', message: `Legacy snapshot write failed: ${(e as Error).message}. The save was aborted; config.json was not touched.` } };
    }
    snapshot = outcome;
    if (outcome === 'exists') {
      const verdict = await verifyLegacySnapshot(deps.persistDir, composed.snapshot);
      if (verdict === 'mismatch') {
        try {
          await journalConversionBaseline(deps.persistDir, composed.snapshot, deps.log);
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'conversion-journal-error',
              message: `Recording the pre-conversion legacy baseline failed: ${(e as Error).message} `
                + 'The save was aborted; config.json was not touched.',
            },
          };
        }
        snapshot = 'journaled';
      } else if (verdict === 'corrupt' || verdict === 'absent') {
        return {
          ok: false,
          error: {
            code: 'legacy-snapshot-corrupt',
            message: 'The existing legacy snapshot could not be read back for verification. Refusing to convert.',
          },
        };
      }
    }
  }

  return {
    ok: true,
    nextConfig: composed.nextConfig,
    settingsChanged,
    nextConfigDigest,
    validationToken,
    snapshot,
    canonicalSensorMap: canonical,
    warnings: effectiveMap.warnings,
    notes: effectiveMap.notes,
  };
}

// ---- Preview-save (GA task #69, PR B — no writes) -------------------

/**
 * Server-authoritative dry run of a save (design decision 2026-08-19:
 * the structural-change confirmation must not make the browser a
 * second signature calculator). Runs the EXACT save pipeline —
 * validation, canonicalization, divergence gate — via runSavePipeline
 * and returns what the save WOULD do: the canonical sensorMap, the
 * proposed effective rows, a row-by-row diff against the current
 * on-disk state with structural re-registration flags, and a digest.
 *
 * Performs NO writes of any kind — not even the legacy snapshot.
 *
 * The digest is the PR C confirmation token, computed by
 * computeSaveConsequences(): sha256 over the canonical JSON of the
 * on-disk block, the canonical sensorMap, AND the sorted current and
 * proposed runtime accessory sets — binding the CONSEQUENCES, so
 * discovery/inventory drift after a preview invalidates the token
 * even when the typed inputs are unchanged. It is stateless — at save
 * time /compose-save recomputes the same function and refuses a
 * structural save whose presented digest does not match, proving the
 * user confirmed THESE consequences against THIS base.
 */
export async function handlePreviewSave(
  deps: HandlerDeps,
  payload: unknown,
): Promise<PreviewResultDto> {
  const p = (payload ?? {}) as ComposeSavePayload;
  const r = await runSavePipeline(deps, p);
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  if ('settingsOnly' in r) {
    // A settings-only preview (GA review P1-2/P1-3): no accessory
    // consequences exist and no inventory is required — exactly the
    // states (fresh install, broken credentials) where none can be.
    const { block, settingsChanged } = r.settingsOnly;
    return {
      ok: true,
      canonicalSensorMap: (block !== null && Array.isArray(block.sensorMap)
        ? block.sensorMap : []) as SensorMapOverride[],
      settingsChanged,
      rows: [],
      changes: [],
      configOnly: [],
      batteryPolarity: [],
      structuralChangeCount: 0,
      digest: settingsOnlyDigest(block, settingsChanged),
      warnings: [],
      notes: [],
    };
  }
  const { effectiveMap, canonical } = r.ctx;
  const consequences = computeSaveConsequences(r.ctx);

  // Notes that concern a previewed change attach to that row (beta.17
  // RC smoke: detached note boxes read as page-wide alarms); only
  // notes matching no change stay in the residual list. Presentation
  // only — the digest was computed above, before this attachment, and
  // /compose-save recomputes the same unattached projection.
  const noteDtos = effectiveMap.notes.map(n => toDiagnosticDto('note', n));
  const changeKeys = new Set([...consequences.changes, ...consequences.configOnly]
    .map(c => `${c.stationMac.toUpperCase()}|${c.dataPoint}`));
  const residualNotes: EditorDiagnosticDto[] = [];
  const inlineNotes = new Map<string, string[]>();
  for (const n of noteDtos) {
    const key = n.stationMac !== undefined && n.dataPoint !== undefined
      ? `${n.stationMac.toUpperCase()}|${n.dataPoint}` : undefined;
    if (key !== undefined && changeKeys.has(key)) {
      const list = inlineNotes.get(key) ?? [];
      if (!list.includes(n.message)) {
        list.push(n.message);
      }
      inlineNotes.set(key, list);
    } else {
      residualNotes.push(n);
    }
  }
  const attach = <T extends { stationMac: string; dataPoint: string; notes?: string[] }>(c: T): T => {
    const list = inlineNotes.get(`${c.stationMac.toUpperCase()}|${c.dataPoint}`);
    return list !== undefined ? { ...c, notes: list } : c;
  };

  return {
    ok: true,
    canonicalSensorMap: canonical,
    configurationTransition: {
      before: {
        mode: r.ctx.modeResult.mode === 'legacy' ? 'legacy' : 'v2',
        baseline: r.ctx.stampsCurrent.catalogBaseline,
        adopted: r.ctx.stampsCurrent.catalogAdopted,
        stamped: r.ctx.block.catalogBaseline !== undefined && r.ctx.block.catalogAdopted !== undefined,
      },
      after: {
        mode: 'v2', baseline: r.ctx.stampsResolved.catalogBaseline,
        adopted: r.ctx.stampsResolved.catalogAdopted, stamped: true,
      },
    },
    settingsChanged: r.ctx.settingsChanged,
    rows: consequences.proposedRows,
    changes: consequences.changes.map(attach),
    configOnly: consequences.configOnly.map(attach),
    batteryPolarity: consequences.batteryPolarity,
    structuralChangeCount: consequences.structuralChangeCount,
    digest: consequences.digest,
    warnings: effectiveMap.warnings.map(w => toDiagnosticDto('warning', w)),
    notes: residualNotes,
  };
}

/** Everything a save DOES to the HomeKit accessory set, plus the digest binding it. */
export interface SaveConsequences {
  changes: PreviewChangeDto[];
  configOnly: ConfigOnlyChangeDto[];
  /** Adoption battery-decoder polarity changes (§19.6 / F5). */
  batteryPolarity: BatteryPolarityChangeDto[];
  structuralChangeCount: number;
  /**
   * The confirmation token (review #43 P1-2): sha256 over canonical
   * JSON of the on-disk block, the canonical sensorMap, AND the sorted
   * current/proposed runtime accessory sets (station, dataPoint,
   * structuralSignature). Binding the accessory sets makes the digest
   * sensitive to everything that shapes the CONSEQUENCES — discovery,
   * station inventory, cached accessories, ui-state — not just the
   * inputs the user typed. PR C's /compose-save recomputes this same
   * function and refuses a structural save whose presented digest
   * differs.
   */
  digest: string;
  /** All proposed effective rows (disabled included), for display. */
  proposedRows: EditorRowDto[];
}

/**
 * Compute the accessory-set consequences of a validated save pipeline
 * result. THE diff is over the RUNTIME ACCESSORY SET — configured AND
 * enabled rows, the same filter the platform's reconciliation applies
 * (review #43 P1-1): a disabled row has no accessory, so disabling
 * registers as 'removed' (the accessory DEregisters) and enabling as
 * 'added' (it registers). 'modified' rows exist on both sides;
 * structural iff the signature changed (re-registration).
 *
 * Single implementation for /preview-save today and /compose-save's
 * digest verification in PR C.
 */
export function computeSaveConsequences(ctx: SavePipelineContext): SaveConsequences {
  const { block, modeResult, proposal, stationsBefore, stationsAfter, discovery, uiState, canonical, stampsCurrent, stampsResolved } = ctx;

  // The after-side RUNTIME world: the validated proposal evaluated
  // over the PATCHED filter's inventory (round 2 P1: ctx.effectiveMap
  // is the authoring/serialization map over the unfiltered inventory
  // and must not be the consequence model).
  const proposedRuntimeMap = buildEffectiveSensorMap({
    userOverrides: proposal,
    discovery,
    uiState,
    stations: stationsAfter,
    configMode: 'v2',
    catalogBaseline: stampsResolved.catalogBaseline,
    catalogAdopted: stampsResolved.catalogAdopted,
  });

  // CURRENT effective state from the on-disk block over the SAME
  // inventory: a legacy config's current state is its compat
  // translation (what a migration preserves), a v2 config's is its
  // sensorMap. Same-inventory comparison keeps the diff about the
  // PROPOSAL, never about station drift.
  const currentOverrides: ReadonlyArray<unknown> = modeResult.mode === 'legacy'
    ? compatToOverrides(block as LegacyConfig, stationsBefore, dynamicDataPointsFrom(discovery))
    : (Array.isArray(block.sensorMap) ? block.sensorMap : []);
  const currentMap = buildEffectiveSensorMap({
    userOverrides: currentOverrides,
    discovery,
    uiState,
    // The before-world sees the ON-DISK filter (PR #60 review F1); a
    // save that narrows the filter diffs against what the runtime
    // currently exposes, so the exclusions surface as removals.
    stations: stationsBefore,
    configMode: 'v2',
    catalogBaseline: stampsCurrent.catalogBaseline,
    catalogAdopted: stampsCurrent.catalogAdopted,
  });
  // The row universe is a UNION (defaults x stations, discovery pairs,
  // override targets), so filtering the inventory alone does not
  // remove a filtered-out station's discovery-driven rows. The runtime
  // world per side is rows whose station the filter leaves VISIBLE.
  const macsBefore = new Set(stationsBefore.map(st => st.macAddress.toUpperCase()));
  const macsAfter = new Set(stationsAfter.map(st => st.macAddress.toUpperCase()));

  const currentLayers = acceptedOverrideLayers(currentOverrides, currentMap.errors);
  const proposedLayers = acceptedOverrideLayers(proposal, proposedRuntimeMap.errors);

  type ConfiguredRow = Exclude<EffectiveSensorRow, { kind: 'unrecognized' }>;
  const accessorySet = (rows: EffectiveSensorRow[]): Map<string, ConfiguredRow> => {
    const out = new Map<string, ConfiguredRow>();
    for (const row of rows) {
      if (row.kind !== 'unrecognized' && row.enabled) {
        out.set(`${row.stationMac}|${row.dataPoint}`, row as ConfiguredRow);
      }
    }
    return out;
  };
  const before = accessorySet(currentMap.rows.filter(r => macsBefore.has(r.stationMac.toUpperCase())));
  const after = accessorySet(proposedRuntimeMap.rows.filter(r => macsAfter.has(r.stationMac.toUpperCase())));

  // Fields whose change matters to the user. structuralSignature
  // decides the `structural` flag (re-registration); the rest mark a
  // row as modified-in-place. (No `enabled` here — both sides of a
  // 'modified' pair are enabled by construction.)
  const ROW_FIELDS = [
    'structuralSignature', 'kind', 'measurement', 'name',
    'sourceUnit', 'displayUnit', 'threshold', 'triggerEnabled',
    'triggerDirection', 'batteryField', 'hasBatterySubService', 'embedName',
    // Non-structural: a label-only change is a modified-in-place value
    // change, not a re-registration (§19.9).
    'unitLabel',
  ] as const;
  // The platform composes HAP display names from the RUNTIME station
  // inventory (station prefix only when multiple stations are
  // visible), so a filter change that crosses the 1-station boundary
  // RENAMES every retained accessory in place. Model it with the
  // platform's own recipe per side (round 2 P2).
  const composedName = (row: ConfiguredRow, inventory: StationInventory): string => {
    const station = inventory.find(st => st.macAddress.toUpperCase() === row.stationMac.toUpperCase());
    return composeRowDisplayName(
      { macAddress: row.stationMac, name: station?.name ?? '' },
      row.name,
      inventory.length > 1,
    );
  };

  const changes: PreviewChangeDto[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      changes.push({
        stationMac: b.stationMac, dataPoint: b.dataPoint,
        change: 'removed', structural: true,
        before: toEditorRowDto(b, currentLayers, stampsCurrent.catalogAdopted),
      });
      continue;
    }
    const differs = ROW_FIELDS.filter(f =>
      (b as unknown as Record<string, unknown>)[f] !== (a as unknown as Record<string, unknown>)[f]);
    const nameBefore = composedName(b, stationsBefore);
    const nameAfter = composedName(a, stationsAfter);
    if (differs.length > 0 || nameBefore !== nameAfter) {
      changes.push({
        stationMac: b.stationMac, dataPoint: b.dataPoint,
        change: 'modified',
        structural: b.structuralSignature !== a.structuralSignature,
        before: toEditorRowDto(b, currentLayers, stampsCurrent.catalogAdopted),
        after: toEditorRowDto(a, proposedLayers, stampsResolved.catalogAdopted),
        ...(nameBefore !== nameAfter ? { displayName: { before: nameBefore, after: nameAfter } } : {}),
      });
    }
  }
  for (const [key, a] of after) {
    if (!before.has(key)) {
      changes.push({
        stationMac: a.stationMac, dataPoint: a.dataPoint,
        change: 'added', structural: true,
        after: toEditorRowDto(a, proposedLayers, stampsResolved.catalogAdopted),
      });
    }
  }
  changes.sort((x, y) => x.stationMac === y.stationMac
    ? (x.dataPoint < y.dataPoint ? -1 : x.dataPoint > y.dataPoint ? 1 : 0)
    : (x.stationMac < y.stationMac ? -1 : 1));

  // Saved-configuration changes with NO accessory effect right now:
  // recognized rows DISABLED on both sides whose settings differ
  // (e.g. a family unit landing on a disabled weekly-rain total).
  // Listed so the draft count and the preview visibly add up
  // (Bruno's beta.15 RC feedback); enabled/disabled transitions are
  // already 'added'/'removed' above.
  const disabledSet = (rows: EffectiveSensorRow[]): Map<string, ConfiguredRow> => {
    const out = new Map<string, ConfiguredRow>();
    for (const row of rows) {
      if (row.kind !== 'unrecognized' && !row.enabled) {
        out.set(`${row.stationMac}|${row.dataPoint}`, row as ConfiguredRow);
      }
    }
    return out;
  };
  const beforeDisabled = disabledSet(currentMap.rows.filter(r => macsBefore.has(r.stationMac.toUpperCase())));
  const afterDisabled = disabledSet(proposedRuntimeMap.rows.filter(r => macsAfter.has(r.stationMac.toUpperCase())));
  const configOnly: ConfigOnlyChangeDto[] = [];
  for (const key of new Set([...beforeDisabled.keys(), ...afterDisabled.keys()])) {
    const b = beforeDisabled.get(key);
    const a = afterDisabled.get(key);
    if (b && a) {
      const differs = ROW_FIELDS.some(f =>
        (b as unknown as Record<string, unknown>)[f] !== (a as unknown as Record<string, unknown>)[f]);
      if (differs) {
        configOnly.push({
          stationMac: a.stationMac, dataPoint: a.dataPoint, change: 'modified',
          before: toEditorRowDto(b, currentLayers, stampsCurrent.catalogAdopted),
          after: toEditorRowDto(a, proposedLayers, stampsResolved.catalogAdopted),
        });
      }
    } else if (b && !after.has(key)) {
      // Disabled row gone entirely (not enabled): a saved deletion,
      // e.g. Use defaults on a disabled custom row (round 6 F4).
      configOnly.push({
        stationMac: b.stationMac, dataPoint: b.dataPoint, change: 'removed',
        before: toEditorRowDto(b, currentLayers, stampsCurrent.catalogAdopted),
      });
    } else if (a && !b && !before.has(key)) {
      // Disabled row appears from nowhere (not an enabled->disabled
      // transition): a saved addition, e.g. a custom row authored
      // disabled.
      configOnly.push({
        stationMac: a.stationMac, dataPoint: a.dataPoint, change: 'added',
        after: toEditorRowDto(a, proposedLayers, stampsResolved.catalogAdopted),
      });
    }
  }
  configOnly.sort((x, y) => x.stationMac === y.stationMac
    ? (x.dataPoint < y.dataPoint ? -1 : x.dataPoint > y.dataPoint ? 1 : 0)
    : (x.stationMac < y.stationMac ? -1 : 1));

  const proposedRows = proposedRuntimeMap.rows
    .map(row => toEditorRowDto(row, proposedLayers, stampsResolved.catalogAdopted))
    .sort((a, b) => a.stationMac === b.stationMac
      ? (a.dataPoint < b.dataPoint ? -1 : a.dataPoint > b.dataPoint ? 1 : 0)
      : (a.stationMac < b.stationMac ? -1 : 1));

  // Battery-decoder polarity consequences (§19.6 / PR #67 review F5).
  // The vendor-inverted decode is adoption-gated at catalog 3: an
  // enabled battery-OWNING row whose field is vendor-inverted flips
  // its low/normal decode when the save crosses the catalog-3
  // boundary, with NO structural change. Disclose every affected
  // existing (enabled, both-sides) row; the reverse transition (a
  // downgrade save) is disclosed the same way.
  // The SAME policy function the runtime decoder uses (R2-F2): the
  // save pipeline always runs v2-driven (saves are refused in safe
  // mode), so both worlds map their adopted stamp straight to a
  // policy — matching the runtime's decode exactly, including across a
  // pure conversion (no stamp change → no polarity change).
  const fromPolicy = batteryDecoderPolicy(stampsCurrent.catalogAdopted);
  const toPolicy = batteryDecoderPolicy(stampsResolved.catalogAdopted);
  const batteryPolarity: BatteryPolarityChangeDto[] = [];
  if (fromPolicy !== toPolicy) {
    for (const [key, a] of after) {
      if (a.hasBatterySubService
        && a.batteryField !== null
        && VENDOR_INVERTED_BATTERY_FIELDS.has(a.batteryField)
        && before.has(key)) {
        batteryPolarity.push({
          stationMac: a.stationMac,
          dataPoint: a.dataPoint,
          batteryField: a.batteryField,
          from: fromPolicy,
          to: toPolicy,
        });
      }
    }
    batteryPolarity.sort((x, y) => x.stationMac === y.stationMac
      ? (x.dataPoint < y.dataPoint ? -1 : x.dataPoint > y.dataPoint ? 1 : 0)
      : (x.stationMac < y.stationMac ? -1 : 1));
  }

  const setSummary = (set: Map<string, ConfiguredRow>): Array<Record<string, string>> =>
    [...set.values()]
      .map(row => ({
        stationMac: row.stationMac,
        dataPoint: row.dataPoint,
        structuralSignature: row.structuralSignature,
      }))
      .sort((a, b) => `${a.stationMac}|${a.dataPoint}` < `${b.stationMac}|${b.dataPoint}` ? -1 : 1);
  // The digest binds EVERY user-visible consequence (round 3 P2): the
  // full normalized change list — kind of change, structural flag, the
  // salient row fields on both sides, and the composed display-name
  // rename — plus the config-only list. A stable PROJECTION rather
  // than the raw DTOs, because rows carry volatile observation
  // timestamps (firstSeen/lastSeen) that must not stale a digest
  // between preview and commit. A discovery station-name change that
  // alters a shown rename therefore changes the digest, and the stale
  // confirmation refuses.
  const rowProjection = (r: EditorRowDto | undefined): Record<string, unknown> | null => r ? {
    enabled: r.enabled,
    name: r.name ?? null,
    kind: r.kind,
    measurement: r.measurement ?? null,
    sourceUnit: r.sourceUnit ?? null,
    displayUnit: r.displayUnit ?? null,
    threshold: r.threshold ?? null,
    triggerEnabled: r.triggerEnabled ?? null,
    triggerDirection: r.triggerDirection ?? null,
    batteryField: r.batteryField,
    hasBatterySubService: r.hasBatterySubService ?? null,
    embedName: r.embedName ?? null,
    // §19.9: bind the numeric label into the digest so a label-only
    // change is a real, confirmable consequence. `null` = absent,
    // '' = a deliberately cleared label (distinct states).
    unitLabel: r.unitLabel ?? null,
  } : null;
  const changeProjection = changes.map(c => ({
    stationMac: c.stationMac,
    dataPoint: c.dataPoint,
    change: c.change,
    structural: c.structural,
    displayName: c.displayName ?? null,
    before: rowProjection(c.before),
    after: rowProjection(c.after),
  }));
  const configOnlyProjection = configOnly.map(c => ({
    stationMac: c.stationMac,
    dataPoint: c.dataPoint,
    change: c.change,
    before: rowProjection(c.before),
    after: rowProjection(c.after),
  }));
  // Bind the disclosed polarity consequences into the digest (F5): a
  // preview that lists them authorizes exactly that adoption, and a
  // commit that would list different ones refuses as stale.
  const batteryPolarityProjection = batteryPolarity.map(c => ({
    stationMac: c.stationMac, dataPoint: c.dataPoint,
    batteryField: c.batteryField, from: c.from, to: c.to,
  }));
  const digest = createHash('sha256')
    .update(canonicalJsonLocal({
      base: block,
      canonical,
      current: setSummary(before),
      proposed: setSummary(after),
      changes: changeProjection,
      configOnly: configOnlyProjection,
      batteryPolarity: batteryPolarityProjection,
      // The visible settings banner is a consequence too (round 4 P2):
      // key NAMES only, never values — a consequence-equivalent switch
      // between settings patches must not reuse the old confirmation.
      settingsChanged: [...ctx.settingsChanged].sort(),
      // The stamp transition is a consequence in its own right (PR #66
      // review F4): adoption changes which definitions every future
      // resolution sees, even when today's accessory sets are equal
      // (all six fields already explicitly assigned). A digest minted
      // by an ordinary preview must never authorize an adoption save,
      // so both sides of the transition are bound.
      stamps: { current: ctx.stampsCurrent, resolved: ctx.stampsResolved },
    }))
    .digest('hex');

  return {
    changes,
    configOnly,
    batteryPolarity,
    structuralChangeCount: changes.filter(c => c.structural).length,
    digest,
    proposedRows,
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
function settingsDtoFor(block: Record<string, unknown>): EditorStateDto['settings'] {
  return {
    name: typeof block.name === 'string' ? block.name : '',
    dataSource: block.dataSource === 'realtime' ? 'realtime' : 'polling',
    stationFilter: Array.isArray(block.stationFilter)
      ? (block.stationFilter as unknown[]).filter((e): e is string => typeof e === 'string')
      : [],
    ...(typeof block.embedNameUpdateMinIntervalMinutes === 'number'
      ? { embedNameUpdateMinIntervalMinutes: block.embedNameUpdateMinIntervalMinutes }
      : {}),
    apiKeySet: typeof block.apiKey === 'string' && block.apiKey.length > 0,
    applicationKeySet: typeof block.applicationKey === 'string' && block.applicationKey.length > 0,
  };
}

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
    // Fresh installation (GA review P1-2): render a functional page
    // whose Connection section can enter credentials; the
    // settings-only save creates the block. baseDigest is the
    // fresh-install sentinel, so a block appearing before the save
    // refuses as stale like any other base drift.
    return {
      configMode: 'legacy',
      v2FlagEnabled: detectV2FlagSource({} as ConfigInputShape, deps.env ?? process.env) !== 'opted-out',
      freshInstall: true,
      settings: settingsDtoFor({}),
      editorAvailable: true,
      baseDigest: FRESH_INSTALL_DIGEST,
      blockIndex: 0,
      version: deps.version,
      stations: [],
      authored: [],
      authoredSource: 'sensorMap',
      mirrorState: recognizeMirror({}).state,
      catalog: { baseline: CURRENT_CATALOG_VERSION, adopted: CURRENT_CATALOG_VERSION, current: CURRENT_CATALOG_VERSION },
      rows: [],
      warnings: [],
      errors: [],
      notes: [],
    };
  }

  const warnings: EditorDiagnosticDto[] = [];
  if (blocks.length > 1) {
    warnings.push({
      severity: 'warning',
      code: 'duplicate-platform-blocks',
      message: `${blocks.length} AmbientWeatherSensors platform blocks found in config.json (a multi-Home setup; `
        + 'see MultiHome.md); showing the first. The sensor-map editor is read-only while more than one block '
        + 'exists. Edit sensorMap in the JSON config editor instead.',
    });
  }
  const block = blocks[0];

  const modeResult = detectConfigMode(block as ConfigInputShape);
  // The block's adoption stamps (§18.3), resolved by mode detection in
  // EVERY mode: (1, 1) when both fields are absent, and the block's
  // own pair otherwise — a fresh settings-only install is a
  // legacy-shaped block born stamped at the current version. An
  // invalid pair took the safe-mode return above and never reaches
  // the builds below.
  const blockCatalogBaseline = modeResult.catalogBaseline ?? 1;
  const blockCatalogAdopted = modeResult.catalogAdopted ?? 1;
  const v2FlagEnabled = detectV2FlagSource(block as ConfigInputShape, deps.env ?? process.env) !== 'opted-out';
  // detectConfigMode already includes safeModeBanner in warnings —
  // no separate push, or safe mode would show the banner twice.
  for (const w of modeResult.warnings) {
    warnings.push({ severity: 'warning', code: 'config-mode', message: w });
  }
  if (!v2FlagEnabled && modeResult.mode !== 'safe-mode') {
    warnings.push({
      severity: 'warning',
      code: 'v2-flag-off',
      message: 'This installation explicitly opts out of the sensor-map runtime, so the table below is a preview '
        + 'and saving is disabled. Remove the opt-out (_sensorMapV2: false or SENSOR_MAP_V2=0) and restart '
        + 'Homebridge to edit for real.',
    });
  }
  if (modeResult.mode === 'safe-mode') {
    return {
      configMode: 'safe-mode',
      v2FlagEnabled,
      settings: settingsDtoFor(block),
      editorAvailable: false,
      baseDigest: blockDigest(block),
      blockIndex: 0,
      version: deps.version,
      stations: [],
      authored: [],
      authoredSource: 'sensorMap',
      mirrorState: recognizeMirror(block).state,
      rows: [],
      warnings,
      errors: [],
      notes: [],
    };
  }

  // Malformed-sensorMap HARD STOP (review #32 round 2 F1): the runtime
  // freezes reconciliation on a present-but-non-array sensorMap
  // (string, object, number, null) rather than exposing the full
  // default map off a config error. The preview must represent the
  // SAME state — zero effective rows and a structured diagnostic —
  // never a fictitious default configuration for PR B to draft from.
  // (An ABSENT sensorMap in v2 mode legitimately exposes defaults.)
  const shapeError = sensorMapShapeError(block as EffectiveMapConfig, modeResult.mode);
  if (shapeError !== undefined) {
    return {
      configMode: modeResult.mode,
      v2FlagEnabled,
      settings: settingsDtoFor(block),
      editorAvailable: false,
      baseDigest: blockDigest(block),
      blockIndex: 0,
      version: deps.version,
      stations: [],
      authored: [],
      authoredSource: 'sensorMap',
      mirrorState: recognizeMirror(block).state,
      rows: [],
      warnings,
      errors: [{ severity: 'error', code: 'sensor-map-shape', message: shapeError }],
      notes: [],
    };
  }

  // §8.7 inventory + overrides — the same assembly compose-save uses.
  // A LEGACY config is presented as its compat translation, so the
  // editor shows exactly what a pure migration would produce. The raw
  // sensorMap entries are UNTRUSTED (review round 2 F2): they stay
  // unknown[] until each consumer has applied its own guards.
  const discovery = await loadDiscoveryStore(path.join(deps.persistDir, 'discovery.json'), deps.log, undefined, READ_ONLY_STORE);
  const uiState = await loadUiStateStore(path.join(deps.persistDir, 'ui-state.json'), deps.log, undefined, READ_ONLY_STORE);
  const sources = new Map<string, EditorStationDto['source']>();
  const rawSensorMap: ReadonlyArray<unknown> = Array.isArray(block.sensorMap) ? block.sensorMap : [];
  const assemble = (overridesForMacs: ReadonlyArray<unknown>): StationInventory =>
    assembleStationInventory({
      liveStations: p.liveStations,
      discovery,
      cachedAccessoryUniqueIds: p.cachedAccessoryUniqueIds,
      overrideSources: [rawSensorMap, overridesForMacs],
      sources,
    });
  let overrides: ReadonlyArray<unknown>;
  let stations: StationInventory;
  if (modeResult.mode === 'legacy') {
    stations = assemble([]);
    overrides = compatToOverrides(block as LegacyConfig, stations, dynamicDataPointsFrom(discovery));
    stations = assemble(overrides);
  } else {
    overrides = rawSensorMap;
    stations = assemble(overrides);
  }

  // The resolver is raw-safe by contract — BuildInput.userOverrides
  // is ReadonlyArray<unknown> precisely because config-sourced entries
  // are untrusted; invalid fragments come back as structured errors,
  // never crashes.
  const effectiveMap = buildEffectiveSensorMap({
    userOverrides: overrides,
    discovery,
    uiState,
    stations,
    configMode: 'v2',
    catalogBaseline: blockCatalogBaseline,
    catalogAdopted: blockCatalogAdopted,
  });

  const layers = acceptedOverrideLayers(overrides, effectiveMap.errors);

  // Pure-defaults resolution over the SAME inventory: the values Use
  // Defaults returns a row to (beta.17 RC smoke — the editor shows
  // them instead of staging an invisible removal). Family displayUnit
  // templates are overrides and deliberately absent here; the client
  // overlays them.
  const defaultsMap = buildEffectiveSensorMap({
    userOverrides: [],
    discovery,
    uiState,
    stations,
    configMode: 'v2',
    catalogBaseline: blockCatalogBaseline,
    catalogAdopted: blockCatalogAdopted,
  });
  const defaultsByKey = new Map<string, EditorRowDefaultsDto>();
  for (const d of defaultsMap.rows) {
    if (d.kind === 'unrecognized') {
      continue;
    }
    const dto: EditorRowDefaultsDto = { enabled: d.enabled };
    if (d.name !== undefined) {
      dto.name = d.name;
    }
    if (d.sourceUnit !== undefined) {
      dto.sourceUnit = d.sourceUnit;
    }
    if (d.displayUnit !== undefined) {
      dto.displayUnit = d.displayUnit;
    }
    if (typeof d.threshold === 'number') {
      dto.threshold = d.threshold;
    }
    if (d.triggerEnabled !== undefined) {
      dto.triggerEnabled = d.triggerEnabled;
    }
    if (d.triggerDirection === 'above' || d.triggerDirection === 'below') {
      dto.triggerDirection = d.triggerDirection;
    }
    defaultsByKey.set(`${d.stationMac.toUpperCase()}|${d.dataPoint}`, dto);
  }

  // POSITIVE reported-evidence sets (review P1: "never reported" must
  // not be inferred from missing history alone). Cached accessories
  // prove a field produced an accessory even when discovery.json does
  // not exist yet (fresh upgrade); a station with NO discovery entries
  // has never been observed, so absence proves nothing there.
  // A MISSING cache snapshot is not an empty one (review round-2 P1):
  // the client sends no key when the cache read failed or timed out,
  // and without a complete read a missing accessory proves nothing.
  const cacheKnown = Array.isArray(p.cachedAccessoryUniqueIds);
  const cachedKeys = new Set<string>();
  if (Array.isArray(p.cachedAccessoryUniqueIds)) {
    for (const id of p.cachedAccessoryUniqueIds) {
      if (typeof id !== 'string') {
        continue;
      }
      const m = /^([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})-(.+)$/.exec(id);
      if (m) {
        cachedKeys.add(`${m[1].toUpperCase()}|${m[2]}`);
      }
    }
  }
  const observedStations = new Set<string>();
  for (const entry of discovery.entries) {
    observedStations.add(entry.stationMac.toUpperCase());
  }

  const rows = effectiveMap.rows
    .map(row => {
      const dto = toEditorRowDto(row, layers, blockCatalogAdopted);
      const key = `${row.stationMac.toUpperCase()}|${row.dataPoint}`;
      const defaults = defaultsByKey.get(key);
      // Only rows whose identity IS the catalog/compat identity carry
      // defaults (review F2): for an explicit custom assignment on a
      // fallback-recognized name, the empty-overrides map resolves the
      // FALLBACK identity, and reseeding those defaults into a form
      // built for the assigned identity mixes two sensors' facts. The
      // client's Use defaults closes such editors and lets the preview
      // state the truth (an identity change is a re-registration).
      if (defaults !== undefined && row.kind !== 'unrecognized' && dto.identityScope === 'known') {
        dto.defaults = defaults;
      }
      if (dto.firstSeen !== undefined || cachedKeys.has(key)) {
        dto.everReported = true;
      } else if (cacheKnown && observedStations.has(row.stationMac.toUpperCase())) {
        dto.everReported = false;
      } // else: unknown — leave undefined.
      return dto;
    })
    .sort((a, b) => a.stationMac === b.stationMac
      ? (a.dataPoint < b.dataPoint ? -1 : a.dataPoint > b.dataPoint ? 1 : 0)
      : (a.stationMac < b.stationMac ? -1 : 1));

  for (const w of effectiveMap.warnings) {
    warnings.push(toDiagnosticDto('warning', w));
  }

  return {
    configMode: modeResult.mode,
    v2FlagEnabled,
    // Live settings for the Connection section (beta.17, GA #56).
    // Constructed explicitly, never spread from the block: credential
    // values must not reach this DTO — only presence booleans.
    settings: settingsDtoFor(block),
    // PR C: save path live, gated on the v2 opt-in (review #45 P1-1).
    // Multi-block configs stay read-only until a multi-Home editor
    // exists (review #47 P1-2) — the save pipeline refuses them too.
    editorAvailable: v2FlagEnabled && blocks.length === 1,
    baseDigest: blockDigest(block),
    blockIndex: 0,
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
    mirrorState: recognizeMirror(block).state,
    catalog: { baseline: blockCatalogBaseline, adopted: blockCatalogAdopted, current: CURRENT_CATALOG_VERSION },
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
export function handleGetVocabulary(): LegacyVocabularyDto;
export function handleGetVocabulary(payload: unknown): VocabularyResponseDto;
export function handleGetVocabulary(payload?: unknown): VocabularyResponseDto {
  const protocol = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { vocabularyProtocol?: unknown }).vocabularyProtocol : undefined;
  if ((payload !== undefined && payload !== null && (typeof payload !== 'object' || Array.isArray(payload)))
    || (protocol !== undefined && protocol !== 2)) {
    return { ok: false, error: {
      code: 'unsupported-vocabulary-protocol',
      message: 'The editor and plugin service use incompatible vocabulary versions. Reload the plugin settings page.',
    } };
  }
  const measurements: VocabularyDto['measurements'] = {};
  for (const m of Object.keys(UNIT_VOCABULARY) as Measurement[]) {
    measurements[m] = {
      customSource: unitOptionsFor(m, 'custom-source').map(o => ({ unit: o.unit, label: o.label })),
      extendedDisplay: unitOptionsFor(m, 'extended-display').map(o => ({ unit: o.unit, label: o.label })),
    };
  }
  // Display families: pure projection of DISPLAY_FAMILIES (the Units
  // panel's canonical metadata - PR #53 review F2/F4).
  const families: VocabularyDto['families'] = DISPLAY_FAMILIES.map(f => ({
    key: f.key,
    label: f.label,
    measurements: [...f.measurements],
    choices: f.choices.map(c => ({ id: c.id, label: c.label, units: { ...c.units } })),
  }));
  // An old iframe can outlive an in-place package upgrade. Without
  // negotiation it must retain the measurement-keyed, since-1 list;
  // sending multiple boolean kinds could silently choose the wrong one.
  const vocabOrder = Object.keys(UNIT_VOCABULARY) as Measurement[];
  const assignments: LegacyVocabularyDto['assignments'] = Object.keys(WRAPPER_FOR_KIND_AND_MEASUREMENT)
    .filter(key => protocol === 2 || (WRAPPER_PAIR_SINCE[key as keyof typeof WRAPPER_PAIR_SINCE] ?? 1) <= 1)
    .map(key => {
      const sep = key.indexOf('|');
      const kind = key.slice(0, sep);
      const measurement = key.slice(sep + 1) as Measurement;
      return {
        measurement,
        kind,
        label: MEASUREMENT_LABELS[measurement],
        // Trigger capability comes from the SAME list the validator's
        // warn-strip uses (PR #57 review F3): controls the strip would
        // nullify are never rendered.
        triggering: kind === 'motion' && !NON_TRIGGERING_MEASUREMENTS.includes(measurement),
      };
    })
    .sort((a, b) => vocabOrder.indexOf(a.measurement as Measurement) - vocabOrder.indexOf(b.measurement as Measurement));
  if (protocol !== 2) {
    return { measurements, families, assignments };
  }
  const states: Record<string, { label: string; normal: string; active: string }> = {
    leak: { label: 'Leak', normal: 'No leak', active: 'Leak detected' },
    contact: { label: 'Contact', normal: 'Closed', active: 'Open' },
    occupancy: { label: 'Occupancy', normal: 'Unoccupied', active: 'Occupied' },
    smoke: { label: 'Smoke', normal: 'No smoke detected', active: 'Smoke detected' },
    motion: { label: 'Motion', normal: 'No motion', active: 'Motion detected' },
  };
  const capabilities: CapabilityOptionDto[] = assignments.map(a => {
    const id = `${a.kind}|${a.measurement}`;
    const state = a.measurement === 'boolean' ? states[a.kind] : undefined;
    const output = state ? 'native-state' : a.kind === 'motion' ? 'extended-numeric' : 'native-measurement';
    return {
      ...a, id, since: WRAPPER_PAIR_SINCE[id as keyof typeof WRAPPER_PAIR_SINCE] ?? 1,
      label: state?.label ?? a.label,
      triggering: a.triggering && !state,
      source: state ? { type: 'none' }
        : a.measurement === 'numeric' ? { type: 'fixed-authored', unit: 'raw' }
          : a.measurement === 'timestamp' ? { type: 'fixed-implicit', unit: 'ms' }
            : { type: 'selectable' },
      output,
      inputHelp: state
        ? `0/false = ${state.normal}; 1/true = ${state.active}. Other reported values, including 2, indicate a fault and clear the alert. Missing data retains the previous state and fault. Reversed encodings and text are not supported.`
        : a.measurement === 'timestamp'
          ? 'Accepts a finite numeric Unix timestamp in milliseconds or a supported date string, including an ISO-8601 date.'
          : 'Accepts finite numeric readings, not numeric strings or text.',
      outputHelp: output === 'extended-numeric'
        ? 'Creates a motion tile in Apple Home. Compatible controller apps can display the value.'
          + (a.triggering ? ' An optional threshold controls the motion state: above means at or above, below means at or below.' : ' This measurement does not trigger motion.')
        : output === 'native-state'
          ? 'Uses the reported detector state for a native Apple Home sensor. The plugin does not derive an alarm from a concentration.'
          : 'Uses the corresponding native HomeKit measurement service.',
      ...(state ? { state: { normal: state.normal, active: state.active } } : {}),
    };
  });
  return { vocabularyProtocol: 2, measurements, families, assignments: capabilities };
}

type OverrideLayers = ReturnType<typeof partitionOverrideLayers>;

/**
 * Layer/origin metadata must reflect what the resolver ACCEPTED
 * (review #32 round 2 F2): partitionOverrideLayers requires validated
 * overrides, and a resolver-REJECTED fragment must not label the
 * surviving default row as override-authored. A rejected fragment
 * also poisons its whole (station, dataPoint) key — every fragment
 * for that key merged into the row that was rejected. Shared by
 * /editor-state and /preview-save.
 */
function acceptedOverrideLayers(
  overrides: ReadonlyArray<unknown>,
  errors: ReadonlyArray<RowValidationError>,
): OverrideLayers {
  const structurallySafe = (o: unknown): o is SensorMapOverride =>
    !!o && typeof o === 'object' && !Array.isArray(o)
    && typeof (o as { dataPoint?: unknown }).dataPoint === 'string'
    && ((o as { stationMac?: unknown }).stationMac === undefined
      || typeof (o as { stationMac?: unknown }).stationMac === 'string');
  const keyOf = (o: SensorMapOverride): string =>
    `${o.stationMac !== undefined ? o.stationMac.toUpperCase() : '*'}|${o.dataPoint}`;
  const rejectedIdx = new Set(errors.map(e => e.overrideIndex));
  const rejectedKeys = new Set<string>();
  overrides.forEach((o, i) => {
    if (rejectedIdx.has(i) && structurallySafe(o)) {
      rejectedKeys.add(keyOf(o));
    }
  });
  const accepted = overrides.filter((o, i): o is SensorMapOverride =>
    structurallySafe(o) && !rejectedIdx.has(i) && !rejectedKeys.has(keyOf(o as SensorMapOverride)));
  return partitionOverrideLayers(accepted);
}

function toEditorRowDto(row: EffectiveSensorRow, layers: OverrideLayers, catalogAdopted: number): EditorRowDto {
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
  // Identity scope for the family unit action (PR #53 rounds 2-3 F1):
  // only known rows and rows genuinely GOVERNED by a global custom
  // identity may take a global displayUnit template. Classification
  // is per RESOLVED row, not per dataPoint: a station identity
  // override may carry a DIFFERENT measurement than the global custom
  // template (global pressure, station wind-speed — both valid), and
  // writing that station's family unit onto the global fragment would
  // be illegal-displayunit-for-measurement. A row is 'custom-global'
  // only when its resolved measurement matches the accepted global
  // identity's measurement.
  const globalOverride = layers.global.get(row.dataPoint);
  const stationOverride = layers.station.get(row.stationMac)?.get(row.dataPoint);
  // Stamp-aware (§18.4 AP-2): an ADOPTED definition with no authored
  // identity presents as 'known' — the editor shows the inherited
  // identity and Use defaults attaches (the F2-of-P0 rule) — while any
  // authored identity keeps presenting as custom, exactly like before
  // the definition existed.
  dto.identityScope = defaultRowForConfigOverride(row.dataPoint, catalogAdopted, globalOverride, stationOverride) !== undefined
    ? 'known'
    : globalOverride?.kind !== undefined && globalOverride.measurement !== undefined
      && globalOverride.measurement === row.measurement
      ? 'custom-global'
      : 'custom-station';
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
  // §19.9: the generic numeric label. Carried for numeric rows only; an
  // explicit '' (cleared label) is preserved distinct from absence.
  if (row.measurement === 'numeric' && row.unitLabel !== undefined) {
    dto.unitLabel = row.unitLabel;
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
  'triggerEnabled', 'unitLabel',
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
    dto.unreconstructable = true;
    return dto;
  }
  const frag = entry as Record<string, unknown>;
  // Identity keys are hoisted only when they satisfy the ENGINE's
  // identity rules (validateOverrideIdentity: non-empty dataPoint;
  // stationMac MAC-shaped per STATION_MAC_REGEX) — string type alone
  // is not validation (review #32 round 3). A PRESENT-but-invalid
  // stationMac makes the fragment layer 'invalid' (it is neither a
  // real station exception nor a global template), and the authored
  // value is preserved VERBATIM in identityRaw either way.
  if (typeof frag.stationMac === 'string' && STATION_MAC_REGEX.test(frag.stationMac)) {
    dto.layer = 'station';
    dto.stationMac = frag.stationMac;
    dto.stationMacKey = frag.stationMac.toUpperCase();
  } else if ('stationMac' in frag) {
    dto.layer = 'invalid';
    dto.identityRaw = { ...dto.identityRaw, stationMac: frag.stationMac };
  }
  if (typeof frag.dataPoint === 'string' && frag.dataPoint.length > 0) {
    dto.dataPoint = frag.dataPoint;
  } else if ('dataPoint' in frag) {
    dto.identityRaw = { ...dto.identityRaw, dataPoint: frag.dataPoint };
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
  /**
   * Override fragments to harvest stationMac values from. UNTRUSTED
   * (config-sourced entries can be null, arrays, or carry wrong-typed
   * stationMac — review #32 round 2 F2), so every entry is guarded.
   */
  overrideSources: ReadonlyArray<ReadonlyArray<unknown>>;
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
      if (o && typeof o === 'object' && !Array.isArray(o)
        && typeof (o as { stationMac?: unknown }).stationMac === 'string') {
        add((o as { stationMac: string }).stationMac, '', 'override');
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

/**
 * Canonical digest of one platform block — the session staleness token
 * issued by /editor-state (`baseDigest`) and verified by the save
 * pipeline. Key order and absent-vs-undefined never change it.
 */
export function blockDigest(block: unknown): string {
  return createHash('sha256').update(canonicalJsonLocal(block)).digest('hex');
}

/** The subset of JSON-schema shape the drift gate consults. */
interface SchemaProp {
  type?: string;
  default?: unknown;
  properties?: Record<string, SchemaProp>;
}

let cachedSchemaProperties: Record<string, SchemaProp> | undefined;

/**
 * The plugin's config.schema.json property map — the vocabulary the
 * drift gate tolerates as automatic materialization in a session's
 * in-memory copy (the schema form that produced such copies retired
 * at beta.17; the tolerance remains for old sessions). Read from the package
 * root (this file compiles into homebridge-ui/); packaging tests pin
 * the schema into the published tarball. The path derives from
 * import.meta.url — the package is ESM, where __dirname does not
 * exist at runtime (it type-checks via @types/node and then throws in
 * production only). A read failure propagates: without the schema the
 * drift gate cannot separate form edits from form artifacts, and the
 * save must refuse rather than guess.
 */
function configSchemaProperties(deps?: HandlerDeps): Record<string, SchemaProp> {
  // The dynamic-schema preference retired with the schema form
  // (beta.17): no form renders, so the packaged schema is the only
  // materialization vocabulary the drift gate needs.
  if (!cachedSchemaProperties) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.resolve(here, '..', 'config.schema.json'), 'utf8');
    const parsed = JSON.parse(raw) as { schema?: { properties?: Record<string, SchemaProp> } };
    const properties = parsed.schema?.properties;
    if (!properties || typeof properties !== 'object') {
      throw new Error('config.schema.json has no schema.properties; cannot evaluate the configuration copy.');
    }
    cachedSchemaProperties = properties;
  }
  return cachedSchemaProperties;
}

/**
 * Is `value` something a pre-beta.17 schema-form session MATERIALIZED on its own for a
 * key absent from config.json? Measured on HB UI X 5.28: the form
 * value fills every declared `default` (top-level AND nested inside
 * object properties like `thresholds`/`units`), and has also been
 * observed to materialize empty arrays for array-typed keys with no
 * default (beta.13 smoke on the production box). Anything else in a
 * form-only key is a real user edit.
 */
function isMaterializedDefault(value: unknown, prop: SchemaProp): boolean {
  if (prop.default !== undefined && canonicalJsonLocal(value) === canonicalJsonLocal(prop.default)) {
    return true;
  }
  if (prop.type === 'array' && Array.isArray(value) && value.length === 0) {
    return true;
  }
  if (prop.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).every(([k, v]) => {
      const nested = prop.properties![k];
      return nested !== undefined && isMaterializedDefault(v, nested);
    });
  }
  return false;
}

/**
 * Compare one schema-declared property between the form state and the
 * on-disk block. Object properties recurse per their nested schema:
 * the form materializes nested defaults too, so `thresholds` from a
 * disk block holding two keys legitimately comes back with the full
 * default family filled in. Returns the dotted path of the first real
 * difference, or undefined.
 */
function propDrift(formValue: unknown, diskValue: unknown, prop: SchemaProp, pathPrefix: string): string | undefined {
  if (prop.properties
    && formValue && typeof formValue === 'object' && !Array.isArray(formValue)
    && diskValue && typeof diskValue === 'object' && !Array.isArray(diskValue)) {
    const form = formValue as Record<string, unknown>;
    const disk = diskValue as Record<string, unknown>;
    for (const key of new Set([...Object.keys(form), ...Object.keys(disk)])) {
      const nested = prop.properties[key];
      const at = `${pathPrefix}.${key}`;
      if (!nested) {
        // A nested key the schema does not declare: the form cannot
        // express it (it is dropped from the form value), so a
        // disk-only occurrence is a form artifact, not an edit. A
        // form-side occurrence has no legitimate origin — fail closed.
        if (key in form) {
          return at;
        }
        continue;
      }
      const inForm = key in form;
      const onDisk = key in disk;
      if (inForm && onDisk) {
        const d = propDrift(form[key], disk[key], nested, at);
        if (d !== undefined) {
          return d;
        }
      } else if (inForm) {
        if (!isMaterializedDefault(form[key], nested)) {
          return at;
        }
      } else {
        return at; // schema-declared, on disk, cleared in the form
      }
    }
    return undefined;
  }
  return canonicalJsonLocal(formValue) === canonicalJsonLocal(diskValue) ? undefined : pathPrefix;
}

/**
 * First property path on which the settings page's in-memory block
 * holds an UNSAVED USER EDIT relative to the on-disk block, or
 * undefined when it holds none (review #47 P1-1).
 *
 * Scope (measured on HB UI X 5.28, pre-beta.17 — the form no longer renders): the settings modal's schema form
 * binds two-way into pluginConfig[0] and REPLACES the block with the
 * form VALUE — which contains only schema-declared properties, with
 * every declared default materialized. Consequences for this gate:
 *
 *   - Keys outside config.schema.json (`platform`, `_bridge`,
 *     `sensorMap`, the mirror metadata) are invisible to the form —
 *     the user cannot edit them there, the form value never carries
 *     them, and the composed save preserves them from disk. A
 *     disk-only occurrence is therefore the form replacement at work,
 *     never an edit (refusing it would refuse EVERY production save);
 *     an occurrence on BOTH sides (a session that never rendered the
 *     form is a pristine copy of disk) must still MATCH; a form-only
 *     occurrence has no legitimate origin at all — fail closed
 *     (review #47 round 3, P2: an allowlist, not a shape rule).
 *   - For schema-declared keys: a form-only key whose value is a
 *     materialized default is a form artifact, not an edit. A
 *     form-only key with any OTHER value, a changed value, or a key
 *     cleared from the form is a real unsaved edit the editor save
 *     would destroy: refuse.
 */
function settingsFormDrift(
  formBlock: Record<string, unknown>,
  diskBlock: Record<string, unknown>,
  deps?: HandlerDeps,
): string | undefined {
  const schema = configSchemaProperties(deps);
  for (const key of new Set([...Object.keys(formBlock), ...Object.keys(diskBlock)])) {
    const prop = schema[key];
    const inForm = key in formBlock;
    const onDisk = key in diskBlock;
    if (!prop) {
      if (inForm && onDisk) {
        if (canonicalJsonLocal(formBlock[key]) !== canonicalJsonLocal(diskBlock[key])) {
          return key;
        }
      } else if (inForm) {
        return key;
      }
      continue;
    }
    if (inForm && onDisk) {
      const d = propDrift(formBlock[key], diskBlock[key], prop, key);
      if (d !== undefined) {
        return d;
      }
    } else if (inForm) {
      if (!isMaterializedDefault(formBlock[key], prop)) {
        return key;
      }
    } else {
      return key; // schema-declared, on disk, cleared in the form
    }
  }
  return undefined;
}

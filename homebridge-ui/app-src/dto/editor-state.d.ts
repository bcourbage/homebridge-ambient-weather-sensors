/**
 * Sanitized wire DTOs shared by the UI bridge (server) and the Angular
 * editor app (browser) — GA task #69.
 *
 * This is a DECLARATION module on purpose: it cannot contain runtime
 * code, so nothing server-side can leak into the browser bundle
 * through it, and the server can `import type` from it without
 * creating a runtime dependency on app sources.
 *
 * SANITIZATION CONTRACT: credentials (apiKey/applicationKey),
 * filesystem paths, and internal wrapper machinery
 * (structuralSignature, wrapper descriptors) never appear here.
 * Diagnostic metadata (stable codes, field names, override indices,
 * note sources) is NOT internal machinery — it is the structured
 * validation contract the needs-attention UI is built on and crosses
 * the boundary intact (review #32 round 1).
 *
 * TWO VIEWS OF THE SENSOR MAP (review #32 round 1): the editor needs
 * both what the user AUTHORED (fragment order, layers, field
 * presence — including invalid fragments and explicit nulls) and what
 * it RESOLVES to (effective rows for preview). The browser never
 * reconstructs resolver semantics; the server supplies both views and
 * all provenance.
 */

/** One station the editor can group rows under (§8.7 inventory). */
export interface EditorStationDto {
  /** Uppercase MAC — the grouping key. */
  mac: string;
  name?: string;
  model?: string;
  /** Which §8.7 inventory source produced this station. */
  source: 'live' | 'discovery' | 'cached-accessory' | 'override';
}

/**
 * One AUTHORED override fragment, sanitized but otherwise verbatim:
 * array order, layer, and field presence are preserved exactly —
 * including fragments the resolver rejected and explicit
 * `batteryField: null` — so the editor can implement reset/remove-
 * override, field-level dirty state, and repair of invalid rows.
 * `index` is the same override index every diagnostic refers to.
 */
export interface EditorAuthoredFragmentDto {
  /** Position in the authored array == diagnostics' overrideIndex. */
  index: number;
  /**
   * Absent stationMac = 'global' template; a VALIDATED stationMac
   * (MAC-shaped, per the engine's identity rules) = 'station'
   * exception; a PRESENT-but-invalid stationMac = 'invalid' — the
   * fragment is neither a real station key nor a global template,
   * and the authored value is in identityRaw.
   */
  layer: 'global' | 'station' | 'invalid';
  /** Verbatim authored value (not normalized) so edits round-trip. */
  stationMac?: string;
  /** Uppercase form, for matching against stations/rows. */
  stationMacKey?: string;
  dataPoint?: string;
  /**
   * Identity keys whose authored value failed the ENGINE's identity
   * rules (non-empty dataPoint; MAC-shaped stationMac), preserved
   * verbatim (e.g. `stationMac: "not-a-mac"`, `stationMac: 42`,
   * `dataPoint: ""`) — distinguishable from an absent key. The
   * hoisted fields and `stationMacKey` carry only validated values.
   */
  identityRaw?: { dataPoint?: unknown; stationMac?: unknown };
  /**
   * The authored key/value pairs, restricted to the known override
   * keys but otherwise VERBATIM — wrong types and explicit nulls
   * included (they are what the editor must surface and repair).
   * Identity keys (dataPoint/stationMac) are hoisted above and not
   * repeated here.
   */
  fields: { [key: string]: unknown };
  /**
   * Names of authored keys outside the known override vocabulary.
   * Values are withheld (an unknown key could hold anything).
   */
  unknownKeys?: string[];
}

/** One effective sensor row, resolved by the server, for preview. */
export interface EditorRowDto {
  /** Pure-default values for this row; see EditorRowDefaultsDto. */
  defaults?: EditorRowDefaultsDto;
  /**
   * Whether the station is known to have reported this field, from
   * POSITIVE evidence only (review P1: absence of history is not
   * absence of the sensor):
   *   true      — a discovery observation exists, or a cached
   *               accessory for this (station, dataPoint) exists (an
   *               upgrade can have live accessories and no
   *               discovery.json yet).
   *   false     — the discovery tracker HAS observed this station's
   *               payload and this field has never appeared, and no
   *               cached accessory exists for it.
   *   undefined — unknown: no discovery history for this station, so
   *               nothing may be inferred (the no-data affordances
   *               must not render).
   */
  everReported?: boolean;
  stationMac: string;
  dataPoint: string;
  /** 'unrecognized' rows carry observational metadata only. */
  kind: string;
  measurement?: string;
  /** Unit CODES — the vocabulary DTO maps codes to display labels. */
  sourceUnit?: string;
  displayUnit?: string;
  name?: string;
  enabled: boolean;
  /**
   * Resolved battery field. `null` mirrors the resolver exactly: the
   * row has no battery field (whether by default or by explicit
   * suppression — the authored view shows which).
   */
  batteryField: string | null;
  hasBatterySubService?: boolean;
  threshold?: number;
  triggerEnabled?: boolean;
  triggerDirection?: 'above' | 'below';
  embedName?: boolean;
  /**
   * Which layer authored this row's configuration:
   * built-in default, global template, or station exception.
   */
  origin: 'default' | 'global' | 'station' | 'unrecognized';
  /**
   * How the row's IDENTITY is established (recognized rows only):
   * 'known' = a default-map dataPoint; 'custom-global' = a custom
   * identity authored by a global fragment; 'custom-station' = a
   * custom identity existing only in this station's fragment.
   * Governs the family unit action (PR #53 review round 2 F1): only
   * known and custom-global dataPoints may receive a global
   * displayUnit template — a bare global fragment for a custom
   * dataPoint is refused as custom-missing-kind, and copying the
   * identity would create the accessory on every station.
   */
  identityScope?: 'known' | 'custom-global' | 'custom-station';
  /** ISO-8601 observation metadata, when the station has reported it. */
  firstSeen?: string;
  lastSeen?: string;
}

/**
 * One structured diagnostic. Mirrors the engine's validation contract
 * (RowValidationError / RowValidationWarning / InternalInvariantNote)
 * so the needs-attention UI can associate a problem with its authored
 * fragment and field without parsing human-facing messages.
 */
/**
 * The values a row returns to when nothing is authored for it — the
 * pure-defaults resolution over the same station inventory. Absent on
 * unrecognized and custom rows (their default is nonexistence). The
 * client overlays family displayUnit templates: they are overrides,
 * deliberately not part of this projection.
 */
export interface EditorRowDefaultsDto {
  enabled: boolean;
  name?: string;
  sourceUnit?: string;
  displayUnit?: string;
  threshold?: number;
  triggerEnabled?: boolean;
  triggerDirection?: 'above' | 'below';
}

export interface EditorDiagnosticDto {
  severity: 'error' | 'warning' | 'note';
  /** Stable machine-readable identifier for the diagnostic class. */
  code: string;
  message: string;
  /**
   * Index into `authored` (errors/warnings always carry it; notes
   * only when `source` is 'override'). Absent on page-level
   * diagnostics (config mode, duplicate blocks).
   */
  overrideIndex?: number;
  /** The offending key, when the problem is field-scoped. */
  field?: string;
  dataPoint?: string;
  stationMac?: string;
  /** Notes only: 'default-map' | 'override' (attribution channel). */
  source?: string;
}

/** Response of request '/editor-state'. */
/**
 * Live plugin settings for the consolidated page (beta.17, GA #56).
 * Credentials appear ONLY as presence booleans — never as values, on
 * any DTO surface.
 */
export interface EditorSettingsDto {
  name: string;
  dataSource: 'polling' | 'realtime';
  stationFilter: string[];
  embedNameUpdateMinIntervalMinutes?: number;
  apiKeySet: boolean;
  applicationKeySet: boolean;
}

export interface EditorStateDto {
  /**
   * No platform block exists yet (a fresh installation): the page
   * renders the Connection section for first-time credential entry,
   * and the settings-only save creates the block. baseDigest is the
   * fresh-install sentinel in this state.
   */
  freshInstall?: boolean;
  configMode: 'legacy' | 'v2' | 'safe-mode';
  v2FlagEnabled: boolean;
  /** Live settings rendered by the Connection section. */
  settings: EditorSettingsDto;
  /**
   * True when this server's save path is live (PR C, finding 5) —
   * the client gates every save-capable control on it, so a newer
   * page against an older bridge stays read-only. False in safe mode
   * and on the malformed-sensorMap hard stop.
   */
  editorAvailable: boolean;
  /**
   * Canonical digest of the on-disk platform block this state was
   * derived from — the session staleness token. Preview and save
   * requests pass it back as `baseDigest`; the server refuses when it
   * no longer matches the disk block. NEVER derive a staleness token
   * from homebridge.getPluginConfig(): HB UI X hands back the schema
   * form's mutated in-memory copy, which does not byte-match disk.
   */
  baseDigest: string;
  /**
   * Index of that block among the plugin's platform blocks, in
   * config.json order. A CROSS-CHECK only: composeAndPersist derives
   * the write-back position itself from the single plugin block and
   * refuses when this value disagrees (review #47 P1-2 — a supplied
   * index is never trusted to pick the replacement target). Always 0
   * while the editor requires exactly one block.
   */
  blockIndex: number;
  version: string;
  stations: EditorStationDto[];
  /**
   * The authored override state (see EditorAuthoredFragmentDto).
   * For a legacy config this is the compat-seeded migration proposal
   * — what a pure migration would author.
   */
  authored: EditorAuthoredFragmentDto[];
  authoredSource: 'sensorMap' | 'compat-seeded';
  /**
   * Rollback-mirror recognition for the on-disk block (review #45
   * round 4): the POSITIVE signal the current-state manual rollback
   * requires. 'recognized' = editor-generated, hash-matching mirror —
   * the three-marker deletion is safe; anything else means DO NOT
   * delete the markers ('absent' produces no warning banner at all,
   * which is exactly why absence-of-warnings was not a safe check).
   */
  mirrorState: 'recognized' | 'absent' | 'stale' | 'invalid';
  /**
   * Catalog adoption state (sensor-map.md §18.3). `baseline` and
   * `adopted` are the block's stamps ((1, 1) for legacy mode and every
   * unstamped config); `current` is the catalog version this plugin
   * ships. `adopted < current` means newer definitions exist that this
   * configuration has not adopted; adoption is an explicit save
   * carrying `adoptCatalogVersion: current`. Absent when the block is
   * uninterpretable (safe mode, or the v2-flag/read-only gates that
   * return before stamps resolve).
   */
  catalog?: { baseline: number; adopted: number; current: number };
  /** Server-resolved effective rows (preview view). */
  rows: EditorRowDto[];
  /** Row-validation failures (rejected fragments stay in `authored`). */
  errors: EditorDiagnosticDto[];
  /** Row-validation warnings plus page-level warnings. */
  warnings: EditorDiagnosticDto[];
  /** Ownership/plugin-health notes (attribution per `source`). */
  notes: EditorDiagnosticDto[];
}

/**
 * One row-level difference in the RUNTIME ACCESSORY SET (configured
 * AND enabled rows — the filter reconciliation applies) between the
 * current on-disk configuration and a previewed proposal.
 * `structural: true` means the registration set changes: an 'added'
 * row REGISTERS an accessory, a 'removed' row (including a disable)
 * DEREGISTERS one, and a structural 'modified' row RE-REGISTERS
 * (its HAP service graph changes). These are the cases the
 * confirmation UX exists for.
 */
export interface PreviewChangeDto {
  stationMac: string;
  dataPoint: string;
  change: 'added' | 'removed' | 'modified';
  structural: boolean;
  before?: EditorRowDto;
  after?: EditorRowDto;
  /**
   * Present when the platform-composed HAP display name changes in
   * place — e.g. a stationFilter change crossing the one-station
   * boundary switches every retained accessory between prefixed and
   * bare names (round 2 P2). An in-place rename, not a structural
   * re-registration.
   */
  displayName?: { before: string; after: string };
  /**
   * Note messages that concern THIS row (matched by station + data
   * point), shown inline with the change instead of in a detached
   * list (beta.17 RC smoke). Notes matching no previewed change stay
   * in the top-level `notes`.
   */
  notes?: string[];
}

/**
 * A saved-configuration change with NO accessory effect right now:
 * nothing registers or updates, but the saved settings differ.
 * Listed so the draft count and the preview visibly add up (beta.15
 * RC feedback). Three shapes (review round 6 F4):
 *   - 'modified': disabled on both sides with differing settings.
 *   - 'added':    a disabled row exists only in the proposal (for
 *                 example a new custom row authored disabled).
 *   - 'removed':  a disabled row exists only in the current config
 *                 (for example Use defaults on a disabled custom row).
 * Enabled/disabled transitions are accessory changes and appear in
 * `changes` instead.
 */
export interface ConfigOnlyChangeDto {
  stationMac: string;
  dataPoint: string;
  change: 'added' | 'removed' | 'modified';
  before?: EditorRowDto;
  after?: EditorRowDto;
  /** Same inline note attachment as PreviewChangeDto.notes. */
  notes?: string[];
}

/**
 * A NON-STRUCTURAL semantic consequence of catalog adoption
 * (sensor-map.md §19.6, PR #67 review F5): a row whose battery field
 * decodes with a DIFFERENT polarity after the adoption because the
 * field is vendor-inverted and the adoption crosses the catalog-3
 * boundary. No accessory registers or re-registers, but a low/normal
 * battery reading can flip, so the preview discloses it and the digest
 * binds it. `from`/`to` name the decoder policy on each side.
 */
export interface BatteryPolarityChangeDto {
  stationMac: string;
  dataPoint: string;
  batteryField: string;
  from: 'standard' | 'vendor-inverted';
  to: 'standard' | 'vendor-inverted';
}

/**
 * Response of request '/preview-save' — a server-authoritative dry
 * run of the save. NO writes happen; the browser never computes
 * signatures or diffs itself. `digest` is the stateless confirmation
 * token a structural save must present to /compose-save (live since
 * PR C).
 */
export type PreviewResultDto =
  | {
    ok: true;
    /** The canonical sensorMap the save would write (§11.3/§17.4). */
    canonicalSensorMap: unknown[];
    /** Proposed effective rows, resolved by the server. */
    rows: EditorRowDto[];
    changes: PreviewChangeDto[];
    configOnly: ConfigOnlyChangeDto[];
    /**
     * Battery-decoder polarity changes this save causes (adoption
     * only; §19.6 / PR #67 review F5). Empty for every non-adoption
     * save. Disclosed and digest-bound though non-structural.
     */
    batteryPolarity: BatteryPolarityChangeDto[];
    /** Settings keys this save changes (names only; never values). */
    settingsChanged: string[];
    structuralChangeCount: number;
    /**
     * sha256 over canonical JSON of the previewed CONSEQUENCES: the
     * on-disk block, the canonical map, both sorted accessory sets,
     * the normalized changes and configOnly lists (salient row fields
     * and composed display-name renames; volatile observation
     * timestamps excluded), and the settingsChanged key list. Every
     * consequence the user sees is bound.
     */
    digest: string;
    warnings: EditorDiagnosticDto[];
    notes: EditorDiagnosticDto[];
  }
  | {
    ok: false;
    /** A structured refusal — same codes the save itself uses. */
    error: { code: string; message: string; [detail: string]: unknown };
  };

/** One selectable unit with its human-facing label (#70 vocabulary). */
export interface UnitOptionDto {
  unit: string;
  label: string;
}

/**
 * One choice of a display family (GA #70 editor layer): a single
 * user selection that sets the display unit of every measurement the
 * family spans (AWN's Rainfall toggle covers rain-rate AND
 * rain-accumulation).
 */
export interface DisplayFamilyChoiceDto {
  id: string;
  label: string;
  /** displayUnit per measurement this choice sets. */
  units: { [measurement: string]: string };
}

export interface DisplayFamilyDto {
  key: string;
  label: string;
  measurements: string[];
  choices: DisplayFamilyChoiceDto[];
}

/**
 * One assignable identity for an unrecognized row (PR E): a
 * (kind, measurement) pair the wrapper table can actually build,
 * labeled by measurement. The list is a server-side projection of
 * WRAPPER_FOR_KIND_AND_MEASUREMENT — the browser never decides what
 * is buildable.
 */
export interface AssignmentOptionDto {
  measurement: string;
  kind: string;
  label: string;
  /**
   * Whether rows of this measurement can cross a threshold. False for
   * the measurements the validator's non-triggering strip governs
   * (direction, timestamp): the editor renders no threshold or trigger
   * controls for them, in assignments and row editors alike.
   */
  triggering: boolean;
}

/**
 * Response of request '/vocabulary': per-measurement unit options for
 * each selection context, in vocabulary display order, plus the
 * display families the Units panel offers, in AWN units-page order,
 * plus the assignment targets unrecognized rows may take.
 */
export interface VocabularyDto {
  measurements: {
    [measurement: string]: {
      customSource: UnitOptionDto[];
      extendedDisplay: UnitOptionDto[];
    };
  };
  families: DisplayFamilyDto[];
  assignments: AssignmentOptionDto[];
}

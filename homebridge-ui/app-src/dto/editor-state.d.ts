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
export interface EditorStateDto {
  configMode: 'legacy' | 'v2' | 'safe-mode';
  v2FlagEnabled: boolean;
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
}

/**
 * Response of request '/preview-save' — a server-authoritative dry
 * run of the save. NO writes happen; the browser never computes
 * signatures or diffs itself. `digest` is the stateless confirmation
 * token a structural save must present (activated with the save path
 * in a later release; carried here so the preview contract is
 * complete).
 */
export type PreviewResultDto =
  | {
    ok: true;
    /** The canonical sensorMap the save would write (§11.3/§17.4). */
    canonicalSensorMap: unknown[];
    /** Proposed effective rows, resolved by the server. */
    rows: EditorRowDto[];
    changes: PreviewChangeDto[];
    structuralChangeCount: number;
    /**
     * sha256 over canonical JSON of (on-disk block, canonical map,
     * sorted current accessory set, sorted proposed accessory set) —
     * bound to the previewed CONSEQUENCES, not just the typed inputs.
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
 * Response of request '/vocabulary': per-measurement unit options for
 * each selection context, in vocabulary display order, plus the
 * display families the Units panel offers, in AWN units-page order.
 */
export interface VocabularyDto {
  measurements: {
    [measurement: string]: {
      customSource: UnitOptionDto[];
      extendedDisplay: UnitOptionDto[];
    };
  };
  families: DisplayFamilyDto[];
}

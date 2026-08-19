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
  /** Absent stationMac = global template; present = station exception. */
  layer: 'global' | 'station';
  /** Verbatim authored value (not normalized) so edits round-trip. */
  stationMac?: string;
  /** Uppercase form, for matching against stations/rows. */
  stationMacKey?: string;
  dataPoint?: string;
  /**
   * Identity keys whose authored value did NOT validate as a string,
   * preserved verbatim (e.g. `stationMac: 42`, `dataPoint: null`) —
   * distinguishable from an absent key. `layer`/`stationMacKey` are
   * derived only from validated values, so a fragment with a
   * wrong-typed stationMac reports layer 'global' but carries the
   * authored value here for the editor to surface and repair.
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
  /** False until PR C activates the real save path (finding 5). */
  editorAvailable: boolean;
  version: string;
  stations: EditorStationDto[];
  /**
   * The authored override state (see EditorAuthoredFragmentDto).
   * For a legacy config this is the compat-seeded migration proposal
   * — what a pure migration would author.
   */
  authored: EditorAuthoredFragmentDto[];
  authoredSource: 'sensorMap' | 'compat-seeded';
  /** Server-resolved effective rows (preview view). */
  rows: EditorRowDto[];
  /** Row-validation failures (rejected fragments stay in `authored`). */
  errors: EditorDiagnosticDto[];
  /** Row-validation warnings plus page-level warnings. */
  warnings: EditorDiagnosticDto[];
  /** Ownership/plugin-health notes (attribution per `source`). */
  notes: EditorDiagnosticDto[];
}

/** One selectable unit with its human-facing label (#70 vocabulary). */
export interface UnitOptionDto {
  unit: string;
  label: string;
}

/**
 * Response of request '/vocabulary': per-measurement unit options for
 * each selection context, in vocabulary display order.
 */
export interface VocabularyDto {
  measurements: {
    [measurement: string]: {
      customSource: UnitOptionDto[];
      extendedDisplay: UnitOptionDto[];
    };
  };
}

/**
 * Sanitized wire DTOs shared by the UI bridge (server) and the Angular
 * editor app (browser) — GA task #69.
 *
 * This is a DECLARATION module on purpose: it cannot contain runtime
 * code, so nothing server-side can leak into the browser bundle
 * through it, and the server can `import type` from it without
 * creating a runtime dependency on app sources.
 *
 * SANITIZATION CONTRACT: these shapes carry ONLY what the editor
 * renders. Credentials (apiKey/applicationKey), filesystem paths, and
 * internal machinery (structuralSignature, wrapper descriptors) never
 * appear here. Enum-ish fields the UI merely displays (kind,
 * measurement, units) are open strings — validity is the server's
 * job (§3.7); display labels come from the vocabulary DTO.
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

/** One effective sensor row, sanitized for display. */
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
  /** null = battery explicitly suppressed; absent = no battery. */
  batteryField?: string | null;
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

/** A validation warning/error anchored to a row when possible. */
export interface EditorNoteDto {
  message: string;
  stationMac?: string;
  dataPoint?: string;
}

/** Response of GET-style request '/editor-state'. */
export interface EditorStateDto {
  configMode: 'legacy' | 'v2' | 'safe-mode';
  v2FlagEnabled: boolean;
  /** False until PR C activates the real save path (finding 5). */
  editorAvailable: boolean;
  version: string;
  stations: EditorStationDto[];
  rows: EditorRowDto[];
  warnings: EditorNoteDto[];
  errors: EditorNoteDto[];
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

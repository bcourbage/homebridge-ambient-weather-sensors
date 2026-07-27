/**
 * buildEffectiveSensorMap — pure merge of built-in defaults, user
 * overrides, and observational data into per-(station, dataPoint)
 * effective rows.
 *
 * See docs/future/sensor-map.md §7 for the design contract and §3.4
 * for the discriminated-union output shape.
 *
 * Precedence (later wins):
 *   1. Built-in defaults (global template, keyed by dataPoint)
 *   2. Global user overrides (stationMac absent)
 *   3. Station-specific user overrides (stationMac matches)
 *   4. Observational metadata (firstSeen, lastSeen from discovery)
 *
 * The compat-layer transformation (legacy config → synthetic overrides)
 * belongs to Stage 3; this function takes already-normalized overrides.
 *
 * Safe mode: returns { rows: [], errors: [] }. Existing cached
 * accessories continue via configureAccessory() restore; no new
 * add/remove decisions happen.
 */

import { DEFAULT_SENSOR_MAP, defaultRowFor } from './defaultMap.js';
import { computeStructuralSignature } from './structuralSignature.js';
import type {
  BooleanSensorRow,
  DefaultSensorRow,
  DiscoveredFieldRecord,
  DiscoveryStore,
  EffectiveSensorMap,
  EffectiveSensorRow,
  ForgottenField,
  Measurement,
  NumericSensorRow,
  RowValidationError,
  RowValidationWarning,
  SensorKind,
  SensorMapOverride,
  SensorUnit,
  StationInventory,
  TimestampSensorRow,
  UiStateStore,
  UnrecognizedRow,
  WrapperDescriptor,
} from './types.js';
import {
  validateOverrideBody,
  validateOverrideIdentity,
} from './validation.js';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT } from './wrappers.js';

export interface BuildInput {
  /**
   * Raw override entries. Accepted as `unknown[]` because in v2 mode
   * the values come from user-authored `config.json`; the boundary
   * runtime-typechecks them before promoting to `SensorMapOverride`
   * (fix for review finding #10). Callers on the compat path may
   * pass already-typed overrides — they'll pass validation trivially.
   */
  userOverrides: ReadonlyArray<unknown>;
  discovery: DiscoveryStore;
  uiState: UiStateStore;
  stations: StationInventory;
  configMode: 'legacy' | 'v2' | 'safe-mode';
}

export function buildEffectiveSensorMap(input: BuildInput): EffectiveSensorMap {
  if (input.configMode === 'safe-mode') {
    return { rows: [], errors: [], warnings: [] };
  }

  const errors: RowValidationError[] = [];
  const warnings: RowValidationWarning[] = [];

  // ---- 1. Identity-only validation. Reject entries with missing or
  //         invalid dataPoint / stationMac BEFORE dedup. Everything
  //         else — including per-field runtime type checks and
  //         semantic rules — waits for Phase 2 (§3.3.2 later-wins
  //         allows two individually-incomplete fragments to merge
  //         into a valid override).
  //
  // `pendingMerges` groups raw records by their identity key. Duplicate
  // keys accumulate; merge order is preserved so "later wins" works.
  interface RawFragment { originalIndex: number; record: Record<string, unknown> }
  const pendingMerges = new Map<string, {
    key: { dataPoint: string; stationMac?: string };
    fragments: RawFragment[];
  }>();

  input.userOverrides.forEach((raw, i) => {
    const idResult = validateOverrideIdentity(raw);
    if (idResult.status === 'error') {
      errors.push({
        overrideIndex: i,
        dataPoint: extractDataPointForError(raw),
        stationMac: extractStationMacForError(raw),
        message: idResult.message,
      });
      return;
    }
    const { dataPoint, stationMac } = idResult.identity;
    const key = `${stationMac ?? '*'}|${dataPoint}`;
    let bucket = pendingMerges.get(key);
    if (!bucket) {
      bucket = { key: { dataPoint, stationMac }, fragments: [] };
      pendingMerges.set(key, bucket);
    }
    // At this point raw passed identity check, so it IS an object.
    bucket.fragments.push({ originalIndex: i, record: raw as Record<string, unknown> });
  });

  // ---- 2. Dedup + merge fragments, then run Phase 2 body validation
  //         on each merged entry. `later wins` semantics per §3.3.2.
  const globalOverrides = new Map<string, SensorMapOverride>();
  const stationOverrides = new Map<string, Map<string, SensorMapOverride>>();

  for (const { key, fragments } of pendingMerges.values()) {
    // Merge fragments field-by-field, later wins on conflict.
    const merged: Record<string, unknown> = {};
    for (const frag of fragments) {
      for (const [k, v] of Object.entries(frag.record)) {
        if (v !== undefined) {
          merged[k] = v;
        }
      }
    }

    // Warn once per duplicated key, per §3.3.2. Attributed to the
    // first fragment's index because that's the one users typically
    // look at first when scrolling through their config.
    if (fragments.length > 1) {
      warnings.push({
        overrideIndex: fragments[0].originalIndex,
        dataPoint: key.dataPoint,
        stationMac: key.stationMac,
        message: `Duplicate sensorMap entries for '${key.dataPoint}'${key.stationMac ? ` on ${key.stationMac}` : ''}; merged in order with later fields winning. Canonicalize on next UI save.`,
      });
    }

    const defaultRow = defaultRowFor(key.dataPoint);
    const result = validateOverrideBody(merged, key, defaultRow);

    // Attribute validation output to the LAST fragment's index — the
    // one whose values won. That's the most actionable pointer.
    const attributionIndex = fragments[fragments.length - 1].originalIndex;

    // Body validation may emit warnings even on ok — surface all.
    for (const w of result.warnings) {
      warnings.push({
        overrideIndex: attributionIndex,
        dataPoint: key.dataPoint,
        stationMac: key.stationMac,
        message: w,
      });
    }

    if (result.status === 'error') {
      errors.push({
        overrideIndex: attributionIndex,
        dataPoint: key.dataPoint,
        stationMac: key.stationMac,
        message: result.message,
      });
      continue;
    }

    const validated = result.validated;
    if (validated.stationMac === undefined) {
      globalOverrides.set(validated.dataPoint, validated);
    } else {
      let m = stationOverrides.get(validated.stationMac);
      if (!m) {
        m = new Map();
        stationOverrides.set(validated.stationMac, m);
      }
      m.set(validated.dataPoint, validated);
    }
  }

  // ---- 2. Build lookup for discovery entries.
  const discoveryByStationDp = new Map<string, DiscoveredFieldRecord>();
  for (const e of input.discovery.entries) {
    discoveryByStationDp.set(`${e.stationMac.toUpperCase()}|${e.dataPoint}`, e);
  }

  const forgotten = new Set(
    input.uiState.forgottenFields.map((f: ForgottenField) => `${f.stationMac.toUpperCase()}|${f.dataPoint}`),
  );

  // ---- 3. Collect the set of (stationMac, dataPoint) pairs to emit.
  //         Union of:
  //           - default map × stations (known defaults for every station)
  //           - discovery entries (whether or not the field has a default)
  //           - station-specific overrides (user might reference a field
  //             AWN hasn't reported yet — row loads "waiting for station"
  //             but still emits)
  type Pair = { mac: string; dataPoint: string; stationName: string };
  const pairs = new Map<string, Pair>();

  const stationByMac = new Map<string, string>();
  for (const s of input.stations) {
    stationByMac.set(s.macAddress.toUpperCase(), s.name);
  }

  // Defaults × stations.
  for (const station of input.stations) {
    const mac = station.macAddress.toUpperCase();
    for (const row of DEFAULT_SENSOR_MAP) {
      const key = `${mac}|${row.dataPoint}`;
      if (!pairs.has(key)) {
        pairs.set(key, { mac, dataPoint: row.dataPoint, stationName: station.name });
      }
    }
  }
  // Discovery-observed pairs.
  for (const e of input.discovery.entries) {
    const mac = e.stationMac.toUpperCase();
    const key = `${mac}|${e.dataPoint}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        mac,
        dataPoint: e.dataPoint,
        stationName: stationByMac.get(mac) ?? e.stationName,
      });
    }
  }
  // Station-specific override targets.
  for (const [mac, m] of stationOverrides) {
    for (const dp of m.keys()) {
      const key = `${mac}|${dp}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          mac,
          dataPoint: dp,
          stationName: stationByMac.get(mac) ?? '',
        });
      }
    }
  }

  // ---- 4. Resolve each pair to an EffectiveSensorRow.
  const rows: EffectiveSensorRow[] = [];
  for (const { mac, dataPoint } of pairs.values()) {
    const key = `${mac}|${dataPoint}`;

    // Skip forgotten unrecognized fields.
    if (forgotten.has(key) && !defaultRowFor(dataPoint)) {
      continue;
    }

    const defaultRow = defaultRowFor(dataPoint);
    const globalOv = globalOverrides.get(dataPoint);
    const stationOv = stationOverrides.get(mac)?.get(dataPoint);
    const merged = mergeOverrides(globalOv, stationOv);
    const discovered = discoveryByStationDp.get(key);

    const row = resolveRow({
      stationMac: mac,
      dataPoint,
      defaultRow,
      override: merged,
      discovered,
    });
    if (row) {
      rows.push(row);
    }
  }

  return { rows, errors, warnings };
}

// ---- Helpers ------------------------------------------------------

/**
 * Best-effort dataPoint extraction for a RowValidationError whose
 * source failed identity validation. Purely for user-facing error
 * attribution — do not use for anything semantic.
 */
function extractDataPointForError(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const dp = (raw as Record<string, unknown>).dataPoint;
  return typeof dp === 'string' ? dp : undefined;
}

function extractStationMacForError(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const mac = (raw as Record<string, unknown>).stationMac;
  return typeof mac === 'string' ? mac : undefined;
}

/**
 * Later-wins field merge for duplicate override entries with the same
 * (dataPoint, stationMac?) key. §3.3.2.
 */
function mergeInto(prev: SensorMapOverride | undefined, next: SensorMapOverride): SensorMapOverride {
  if (!prev) {
    return next;
  }
  const out: SensorMapOverride = { ...prev, dataPoint: prev.dataPoint };
  const bag = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined) {
      bag[k] = v;
    }
  }
  return out;
}

/** Station-specific fields override global fields for the same key. */
function mergeOverrides(
  global: SensorMapOverride | undefined,
  station: SensorMapOverride | undefined,
): SensorMapOverride | undefined {
  if (!global && !station) {
    return undefined;
  }
  if (!global) {
    return station;
  }
  if (!station) {
    return global;
  }
  return mergeInto(global, station);
}

interface ResolveInput {
  stationMac: string;
  dataPoint: string;
  defaultRow: DefaultSensorRow | undefined;
  override: SensorMapOverride | undefined;
  discovered: DiscoveredFieldRecord | undefined;
}

function resolveRow(inp: ResolveInput): EffectiveSensorRow | null {
  const { stationMac, dataPoint, defaultRow, override, discovered } = inp;

  // ---- Unrecognized: no default, no user override with kind+measurement.
  if (!defaultRow && !hasKindAndMeasurement(override)) {
    if (!discovered) {
      // Neither default, custom-declared, nor observed. Nothing to emit.
      return null;
    }
    return buildUnrecognizedRow(stationMac, dataPoint, discovered);
  }

  // ---- Resolve kind + measurement.
  const kind: Exclude<SensorKind, 'unrecognized'> =
    (override?.kind && override.kind !== 'unrecognized' ? override.kind : undefined)
    ?? defaultRow?.kind
    ?? 'motion';
  const measurement: Measurement =
    defaultRow?.measurement ?? override?.measurement ?? 'temperature';

  // ---- Resolve wrapper.
  const wrapper = defaultRow?.wrapper ?? WRAPPER_FOR_KIND_AND_MEASUREMENT[`${kind}|${measurement}`];
  if (!wrapper) {
    // Custom row with no registered wrapper for its (kind, measurement).
    // Should have been caught by validation; belt-and-suspenders skip.
    return null;
  }

  // ---- Resolve units.
  const sourceUnit: SensorUnit | undefined = defaultRow?.sourceUnit ?? override?.sourceUnit;
  const displayUnit: SensorUnit | undefined =
    override?.displayUnit ?? defaultRow?.displayUnit ?? sourceUnit;

  // ---- Resolve battery attachment.
  const batteryField = resolveBatteryField(defaultRow, override);
  const hasBatterySubService = batteryField !== null
    && (defaultRow?.canonicalForBattery ?? false);

  // ---- Resolve name.
  const name = override?.name ?? defaultRow?.name ?? dataPoint;

  // ---- Motion trigger fields. Non-motion rows never carry any of
  //       these — validation (Phase 2) has already stripped them
  //       from `override`, but we also gate the fallback to
  //       defaultRow here so a non-motion row's threshold/embedName
  //       can't slip through via the built-in default. §3.6 / §3.7.
  const isMotion = kind === 'motion';
  const triggerEnabled = isMotion
    ? (override?.triggerEnabled ?? defaultRow?.triggerEnabled ?? true)
    : false;
  const triggerDirection: 'above' | 'below' = isMotion
    ? (override?.triggerDirection ?? defaultRow?.triggerDirection ?? 'above')
    : 'above';
  const threshold = isMotion
    ? (override?.threshold ?? defaultRow?.threshold)
    : undefined;
  const embedName = isMotion
    ? (override?.embedName ?? defaultRow?.embedName ?? false)
    : false;

  const enabled = override?.enabled !== false;

  const wrapperId = wrapper.id;
  const structuralSignature = computeStructuralSignature(kind, measurement, hasBatterySubService, wrapper);

  const base = {
    dataPoint,
    stationMac,
    firstSeen: discovered?.firstSeen,
    lastSeen: discovered?.lastSeen,
    kind,
    name,
    threshold,
    triggerEnabled,
    triggerDirection,
    batteryField,
    hasBatterySubService,
    embedName,
    enabled,
    structuralSignature,
    wrapperId,
  } as const;

  if (measurement === 'boolean') {
    const row: BooleanSensorRow = { ...base, measurement: 'boolean' };
    return row;
  }
  if (measurement === 'timestamp') {
    const row: TimestampSensorRow = { ...base, measurement: 'timestamp', sourceUnit: 'ms' };
    return row;
  }
  // Numeric.
  if (!sourceUnit || !displayUnit) {
    // Underspecified custom row that slipped past validation. Skip.
    return null;
  }
  const row: NumericSensorRow = {
    ...base,
    measurement: measurement as NumericSensorRow['measurement'],
    sourceUnit,
    displayUnit,
  };
  return row;
}

function hasKindAndMeasurement(o: SensorMapOverride | undefined): boolean {
  return !!o && !!o.kind && o.kind !== 'unrecognized' && !!o.measurement;
}

function buildUnrecognizedRow(
  stationMac: string,
  dataPoint: string,
  discovered: DiscoveredFieldRecord,
): UnrecognizedRow {
  return {
    dataPoint,
    stationMac,
    kind: 'unrecognized',
    enabled: false,
    firstSeen: discovered.firstSeen,
    lastSeen: discovered.lastSeen,
  };
}

/**
 * batteryField resolution: explicit `null` in override suppresses the
 * plugin-default battery attachment. Absent in override → keep the
 * default. Otherwise use the override's value verbatim.
 */
function resolveBatteryField(
  defaultRow: DefaultSensorRow | undefined,
  override: SensorMapOverride | undefined,
): string | null {
  if (override && 'batteryField' in override) {
    return override.batteryField ?? null;
  }
  return defaultRow?.batteryField ?? null;
}

// Suppress the "wrapper unused" hint for callers that only need the type.
export type { WrapperDescriptor };

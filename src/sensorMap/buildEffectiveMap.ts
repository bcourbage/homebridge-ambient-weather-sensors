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
        code: 'invalid-identity',
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
  //         Track per-field provenance so a warning about a specific
  //         field can be attributed to the fragment whose value for
  //         THAT field survived the merge (not just the last fragment).
  const globalOverrides = new Map<string, SensorMapOverride>();
  const stationOverrides = new Map<string, Map<string, SensorMapOverride>>();

  // batteryField provenance side-table — keyed by
  // `${stationMac ?? '*'}|${dataPoint}`, value is the originalIndex
  // of the merge fragment that supplied the winning `batteryField`.
  // The ownership pass (in resolveRow) reads this to attribute
  // `duplicate-battery-owner` warnings to the loser's actual
  // config-authored fragment, not a synthetic -1 sentinel that
  // violates the Group 1 provenance contract.
  const batteryFieldProvenance = new Map<string, number>();

  for (const { key, fragments } of pendingMerges.values()) {
    // Merge fragments field-by-field, later wins on conflict. Record
    // which fragment provided each field's final value.
    const merged: Record<string, unknown> = {};
    const provenance: Record<string, number> = {};
    for (const frag of fragments) {
      for (const [k, v] of Object.entries(frag.record)) {
        if (v !== undefined) {
          merged[k] = v;
          provenance[k] = frag.originalIndex;
        }
      }
    }
    if (provenance.batteryField !== undefined) {
      batteryFieldProvenance.set(
        `${key.stationMac ?? '*'}|${key.dataPoint}`,
        provenance.batteryField,
      );
    }

    // Warn once per duplicated key, per §3.3.2. Whole-row warning —
    // attributed to the FIRST fragment because that's the one users
    // typically scroll to first when auditing their config.
    if (fragments.length > 1) {
      warnings.push({
        overrideIndex: fragments[0].originalIndex,
        code: 'duplicate-merged',
        dataPoint: key.dataPoint,
        stationMac: key.stationMac,
        message: `Duplicate sensorMap entries for '${key.dataPoint}'${key.stationMac ? ` on ${key.stationMac}` : ''}; merged in order with later fields winning. Canonicalize on next UI save.`,
      });
    }

    const defaultRow = defaultRowFor(key.dataPoint);
    const result = validateOverrideBody(merged, key, defaultRow);

    // Body validation warnings — attribute each to the fragment
    // whose value for that field survived the merge. If the warning
    // has no field (whole-row warning), fall back to the last
    // fragment.
    const lastFragmentIndex = fragments[fragments.length - 1].originalIndex;
    for (const w of result.warnings) {
      const attributionIndex = w.field !== undefined && provenance[w.field] !== undefined
        ? provenance[w.field]
        : lastFragmentIndex;
      warnings.push({
        overrideIndex: attributionIndex,
        code: w.code,
        field: w.field,
        dataPoint: key.dataPoint,
        stationMac: key.stationMac,
        message: w.message,
      });
    }

    if (result.status === 'error') {
      // Attribute the error the same way we attribute warnings —
      // through per-field merge provenance when the failure names a
      // specific field, falling back to the last fragment for
      // row-scope failures (unknown key, missing required field,
      // kind × measurement incompatibility). Point at the fragment
      // that ACTUALLY caused the rejection so the UI can highlight
      // the right entry, not an unrelated last-write-wins fragment.
      const errField = result.field;
      const attributionIndex = errField !== undefined && provenance[errField] !== undefined
        ? provenance[errField]
        : lastFragmentIndex;
      errors.push({
        overrideIndex: attributionIndex,
        code: result.code,
        field: errField,
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
  // Global custom override targets × every known station.
  //
  // A global custom row (stationMac absent, dataPoint outside the
  // built-in default map) declares a custom sensor the user wants
  // on every station. Without this pass, such rows only produce a
  // pair once AWN's discovery layer observes the dataPoint on a
  // specific station — meaning a valid custom configuration
  // produces no row and no error until discovery happens. Per
  // review finding #8, we emit a row for the (station, dataPoint)
  // pair on every station in inventory so the user gets immediate
  // feedback ("waiting for station" rows, per §3.3.4 of
  // sensor-map.md), instead of a silent nothing.
  for (const dp of globalOverrides.keys()) {
    if (defaultRowFor(dp)) {
      // Global row for a known dataPoint — the defaults × stations
      // pass above already emitted a pair for every station.
      continue;
    }
    for (const station of input.stations) {
      const mac = station.macAddress.toUpperCase();
      const key = `${mac}|${dp}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          mac,
          dataPoint: dp,
          stationName: station.name,
        });
      }
    }
  }

  // ---- 4. Resolve each pair to an EffectiveSensorRow.
  //
  // The battery-ownership context is threaded through the pass so
  // custom rows can claim their (station, batteryField) key. Iteration
  // order determines first-writer-wins for custom-vs-custom collisions;
  // the pair map is insertion-ordered (defaults first per §3 above,
  // then discovery, then station-specific and global custom targets)
  // so a default canonical row always resolves before any custom row
  // that might collide with it — matches the reserved-owner rule.
  const rows: EffectiveSensorRow[] = [];
  const batteryOwnership: BatteryOwnershipContext = {
    reservedFields: RESERVED_BATTERY_FIELDS,
    claims: new Map(),
    onDuplicate: (mac, batteryField, winner, loser, loserOverrideIndex) => {
      // Attribute the warning to the fragment that supplied the
      // losing row's `batteryField` (the row currently being
      // resolved; provenance already threaded via `overrideIndex`).
      // Fallback chain if the loser had no config-authored
      // batteryField (its field came from a default row):
      //   1. winner's batteryField provenance (station-scoped first, then global);
      //   2. -1 sentinel is DISALLOWED — the Group 1 provenance
      //      contract requires a real index. If we somehow have
      //      neither, drop to 0 as a "safe" attribution that at
      //      least points at a real config row instead of nowhere.
      const winnerIndex = batteryFieldProvenance.get(`${mac}|${winner}`)
        ?? batteryFieldProvenance.get(`*|${winner}`);
      const attribution = loserOverrideIndex ?? winnerIndex ?? 0;
      warnings.push({
        overrideIndex: attribution,
        code: 'duplicate-battery-owner',
        field: 'batteryField',
        dataPoint: loser,
        stationMac: mac,
        message: `Row '${loser}' on ${mac} declares batteryField '${batteryField}', `
          + `but '${winner}' already owns that field's Battery sub-service on this station. `
          + `'${loser}' will report the battery value but not host the HAP BatteryService.`,
      });
    },
  };
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

    // Provenance for THIS row's batteryField: station-scoped wins
    // over global (the same precedence mergeOverrides applies).
    const overrideIndex = batteryFieldProvenance.get(`${mac}|${dataPoint}`)
      ?? batteryFieldProvenance.get(`*|${dataPoint}`);

    const row = resolveRow({
      stationMac: mac,
      dataPoint,
      defaultRow,
      override: merged,
      discovered,
      overrideIndex,
      batteryOwnership,
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
  /**
   * originalIndex of the merge fragment that supplied this row's
   * `batteryField`. Undefined when the row's batteryField came from
   * the default map (no override authored it). The ownership pass
   * threads this through to attribute `duplicate-battery-owner`
   * warnings to the actual user-authored fragment when this row
   * loses a collision.
   */
  overrideIndex: number | undefined;
  batteryOwnership: BatteryOwnershipContext;
}

/**
 * Threaded through the resolution loop so a custom row asking for a
 * Battery sub-service can claim its `batteryField` per-station and
 * later rows can see the claim. Group 4 review finding #6: custom
 * rows previously got `hasBatterySubService: false` unconditionally
 * because the check was gated on `defaultRow.canonicalForBattery`.
 *
 * The rule (Group 4 shipping subset of docs/future/
 * wrapper-parameterization.md's ownership pass — the full priority
 * spec ships with #4's Stage 2):
 *
 *   1. Default-map canonical rows keep their reservation. Every AWN
 *      battery field is contractually owned by the row with
 *      `canonicalForBattery: true` — this preserves v1.6.0's exact
 *      behavior and matches user muscle memory (battout → tempf,
 *      batt_co2 → co2_in_aqin, ...).
 *   2. A CUSTOM row (no defaultRow) may claim a `batteryField` only
 *      when that field is not in the reserved-by-default set. This
 *      is what makes a custom sensor with `my_barn_batt` able to
 *      attach a HAP BatteryService that v1.6.0 would have missed.
 *   3. Two custom rows claiming the same (station, batteryField):
 *      the first-resolved wins. `duplicate-battery-owner` warning
 *      surfaces so the UI can name the winner. Full file-order
 *      priority (via `RowResolutionMeta` per the design doc) ships
 *      with #4 Stage 2.
 *   4. Disabled rows still hold reservations — a disabled canonical
 *      default does NOT roll ownership over to a custom claimant
 *      (structural-signature stability). Toggling enable state
 *      must not create/destroy sub-services.
 */
interface BatteryOwnershipContext {
  /** batteryField values reserved by any default-map canonical row. Static. */
  readonly reservedFields: ReadonlySet<string>;
  /** (mac|batteryField) → dataPoint that already claimed it this pass. */
  readonly claims: Map<string, string>;
  /**
   * Push to append a duplicate-battery-owner warning.
   * `loserOverrideIndex` is the merge fragment that supplied the
   * loser's `batteryField`, or undefined if the field came from
   * the default map (no user override authored it — a rare fallback
   * scenario since claim-path rows almost always come from an
   * override).
   */
  readonly onDuplicate: (
    mac: string,
    batteryField: string,
    winner: string,
    loser: string,
    loserOverrideIndex: number | undefined,
  ) => void;
}

function resolveRow(inp: ResolveInput): EffectiveSensorRow | null {
  const { stationMac, dataPoint, defaultRow, override, discovered, batteryOwnership } = inp;

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

  // ---- Resolve enabled BEFORE battery ownership. A disabled row
  //       must never consume a claim slot; see the
  //       `resolveHasBatterySubService` doc-comment for why.
  const enabled = override?.enabled !== false;

  // ---- Resolve battery attachment.
  const batteryField = resolveBatteryField(defaultRow, override);
  const hasBatterySubService = resolveHasBatterySubService(
    stationMac,
    dataPoint,
    batteryField,
    defaultRow,
    enabled,
    inp.overrideIndex,
    batteryOwnership,
  );

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

/**
 * Static set of every `batteryField` value reserved by a canonical
 * default-map row. Computed once at module load. A custom row's
 * `batteryField` that appears in this set gets `hasBatterySubService:
 * false` — the reserved default row owns the sub-service and a
 * custom row cannot take that over (rule 2 in
 * `BatteryOwnershipContext`).
 */
const RESERVED_BATTERY_FIELDS: ReadonlySet<string> = new Set(
  DEFAULT_SENSOR_MAP
    .filter(r => r.canonicalForBattery && r.batteryField !== null)
    .map(r => r.batteryField as string),
);

/**
 * Ownership decision for a single row. See `BatteryOwnershipContext`
 * for the full rule; this function is where those rules are executed
 * per row and where `claims` gets mutated on a successful custom
 * attachment.
 *
 * Order of operations, per Group 4 follow-up review:
 *
 *   1. If the row's effective batteryField is null → no sub-service.
 *   2. If the row is DISABLED (`enabled: false`) → no sub-service AND
 *      no claim recorded. A disabled row must never block an enabled
 *      row from taking ownership of the same batteryField.
 *   3. Canonical-owner fast path: a default-map row whose resolved
 *      batteryField still equals `defaultRow.batteryField` and
 *      `canonicalForBattery: true` — reserved forever, no need to
 *      touch claims (the reservation is static across resolveRow
 *      calls; other rows check RESERVED_BATTERY_FIELDS below).
 *   4. Any other row (custom OR default-with-overridden-batteryField
 *      OR non-canonical default with explicit user-set batteryField):
 *      go through the CLAIMS path. Reject if RESERVED_BATTERY_FIELDS
 *      says the field is default-owned. Otherwise first-writer wins
 *      via ownership.claims.
 */
function resolveHasBatterySubService(
  stationMac: string,
  dataPoint: string,
  batteryField: string | null,
  defaultRow: DefaultSensorRow | undefined,
  enabled: boolean,
  overrideIndex: number | undefined,
  ownership: BatteryOwnershipContext,
): boolean {
  if (batteryField === null) {
    return false;
  }
  if (!enabled) {
    // Disabled rows never own a sub-service and never consume a
    // claim slot. This is the fix for the "disabled row wins over
    // enabled row" bug flagged in the Group 4 follow-up.
    return false;
  }

  const isCanonicalDefault = defaultRow !== undefined
    && defaultRow.canonicalForBattery
    && defaultRow.batteryField === batteryField;

  if (isCanonicalDefault) {
    // Canonical owner keeps ownership. Reserved by DEFAULT_SENSOR_MAP
    // (see RESERVED_BATTERY_FIELDS); no need to record in claims
    // because reservation is checked statically below.
    return true;
  }

  // Any other row wanting a sub-service — including a default row
  // whose batteryField was OVERRIDDEN to something novel, or a
  // non-canonical default with an explicit user batteryField, or a
  // custom row — must go through the reserved-set + claims path.
  if (RESERVED_BATTERY_FIELDS.has(batteryField)) {
    return false;
  }
  const key = `${stationMac}|${batteryField}`;
  const priorClaim = ownership.claims.get(key);
  if (priorClaim !== undefined) {
    ownership.onDuplicate(stationMac, batteryField, priorClaim, dataPoint, overrideIndex);
    return false;
  }
  ownership.claims.set(key, dataPoint);
  return true;
}

// Suppress the "wrapper unused" hint for callers that only need the type.
export type { WrapperDescriptor };

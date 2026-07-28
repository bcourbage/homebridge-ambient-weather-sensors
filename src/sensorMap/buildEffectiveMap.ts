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
  InternalInvariantNote,
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
import { DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT } from './units.js';
import {
  validateOverrideBody,
  validateOverrideIdentity,
} from './validation.js';
import { WRAPPER_FOR_KIND_AND_MEASUREMENT, wrapperById } from './wrappers.js';
import { WRAPPER_SPEC } from './wrapperFactories.js';

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
    return { rows: [], errors: [], warnings: [], notes: [] };
  }

  const errors: RowValidationError[] = [];
  const warnings: RowValidationWarning[] = [];
  const notes: InternalInvariantNote[] = [];

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

  // batteryField AUTHORSHIP side-table — keyed by
  // `${stationMac ?? '*'}|${dataPoint}`, value is {index, value}: the
  // fragment that AUTHORED the current batteryField value plus the
  // value itself. This is the `earliestOverrideIndex` ordering key of
  // the ownership pass, so it deliberately does NOT follow plain
  // last-writer provenance (review R12-1): a later fragment that
  // redundantly re-states the SAME value keeps the earlier authoring
  // index — otherwise repeating a batteryField in a duplicate fragment
  // would silently flip ownership and, with it, structural signatures.
  // Only an ACTUAL value change moves authorship. The stored value
  // lets the claim lookup pick, across the global/station scopes, the
  // earliest fragment whose value equals the row's RESOLVED field.
  const batteryFieldAuthor = new Map<string, { index: number; value: unknown }>();

  // Row-scope provenance side-table — keyed by
  // `${stationMac ?? '*'}|${dataPoint}`, value is the LAST merge
  // fragment's originalIndex (the documented row-scope / last-fragment
  // attribution rule). Distinct from `batteryFieldProvenance`: a
  // row-scope failure (e.g. `no-wrapper` on a custom row) must NOT be
  // attributed to whichever fragment happened to carry `batteryField`,
  // and must never fall back to a synthetic index 0. See finding-#4
  // review (P2 — no-wrapper attribution).
  const rowScopeProvenance = new Map<string, number>();

  // `enabled` provenance side-table — the fragment whose `enabled`
  // value survived the merge. The orphan-battery-field note (Stage-4
  // battery-ownership pass) attributes to the fragment that DISABLED a
  // reserved canonical owner.
  const enabledProvenance = new Map<string, number>();

  for (const { key, fragments } of pendingMerges.values()) {
    // Merge fragments field-by-field, later wins on conflict. Record
    // which fragment provided each field's final value.
    const merged: Record<string, unknown> = {};
    const provenance: Record<string, number> = {};
    // batteryField AUTHORSHIP within this key (see batteryFieldAuthor):
    // a redundant same-value re-statement keeps the earlier index; a
    // value change moves it (review R12-1).
    let batteryAuthor: { index: number; value: unknown } | undefined;
    for (const frag of fragments) {
      for (const [k, v] of Object.entries(frag.record)) {
        if (v !== undefined) {
          merged[k] = v;
          provenance[k] = frag.originalIndex;
          if (k === 'batteryField' && (batteryAuthor === undefined || batteryAuthor.value !== v)) {
            batteryAuthor = { index: frag.originalIndex, value: v };
          }
        }
      }
    }
    if (batteryAuthor !== undefined) {
      batteryFieldAuthor.set(`${key.stationMac ?? '*'}|${key.dataPoint}`, batteryAuthor);
    }
    if (provenance.enabled !== undefined) {
      enabledProvenance.set(
        `${key.stationMac ?? '*'}|${key.dataPoint}`,
        provenance.enabled,
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
    rowScopeProvenance.set(`${key.stationMac ?? '*'}|${key.dataPoint}`, lastFragmentIndex);
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
  // custom rows can claim their (station, batteryField) key. Ownership
  // is adjudicated AFTER the resolution loop (Stage-4 battery-ownership
  // pass): claims are collected per (station, batteryField) and the
  // winner is the claimant whose `batteryField` was authored by the
  // EARLIEST config fragment, with `(stationMac, dataPoint)`
  // lexicographic order as the final tie-break — replacing PR #20's
  // resolution-iteration-order rule. Structural signatures are computed
  // only after ownership settles, so signature stability is a function
  // of resolved ownership, never of iteration order.
  const rows: EffectiveSensorRow[] = [];
  const batteryClaims: BatteryClaimCandidate[] = [];
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

    // Row-scope (last-fragment) provenance — used for row-scope failures
    // like `no-wrapper`, independent of batteryField authorship.
    const rowScopeIndex = rowScopeProvenance.get(`${mac}|${dataPoint}`)
      ?? rowScopeProvenance.get(`*|${dataPoint}`);

    const resolved = resolveRow({
      stationMac: mac,
      dataPoint,
      defaultRow,
      override: merged,
      discovered,
      onNoWrapper: (kind, measurement) => {
        // A custom (no-default) row is authored entirely by overrides, so
        // rowScopeProvenance always has its last-fragment index. Attribute
        // the error there — NEVER a synthetic index 0 (finding-#4 review).
        if (rowScopeIndex === undefined) {
          // Unreachable: reaching no-wrapper requires a configured custom
          // override, which always populates rowScopeProvenance.
          return;
        }
        errors.push({
          overrideIndex: rowScopeIndex,
          code: 'no-wrapper',
          dataPoint,
          stationMac: mac,
          message: `Custom dataPoint '${dataPoint}' has no wrapper for `
            + `(${kind}, ${measurement}). Custom sensors are not available in this `
            + 'plugin version.',
        });
      },
      onWrapperMismatch: (wrapperId, kind, measurement, fromDefaultMap) => {
        // The row's resolved wrapperId disagrees with its (kind,
        // measurement) — a plugin bug when it comes from the default map,
        // an impossible-if-validation-is-correct belt-and-suspenders when
        // from an override. Route through the attribution-free `notes`
        // channel (no config to blame for a default-map bug) and DROP the
        // row so a mis-typed accessory is never registered.
        notes.push({
          code: 'wrapper-mismatch',
          source: fromDefaultMap ? 'default-map' : 'override',
          overrideIndex: fromDefaultMap ? undefined : rowScopeIndex,
          dataPoint,
          stationMac: mac,
          message: `Row ${mac}|${dataPoint} resolved wrapper '${wrapperId}', but its `
            + `(${kind}, ${measurement}) does not match that wrapper's spec. Row dropped.`,
        });
      },
    });
    if (resolved.row) {
      rows.push(resolved.row);
      if (resolved.batteryClaim) {
        // earliestOverrideIndex (review R12-1): among the global- and
        // station-scope authorship entries whose authored VALUE equals
        // the row's RESOLVED batteryField, take the EARLIEST fragment.
        // Value matching makes cross-scope redundancy behave like
        // within-scope redundancy — a station fragment re-stating the
        // global value keeps the global fragment's authorship.
        const authorEntries = [
          batteryFieldAuthor.get(`${mac}|${dataPoint}`),
          batteryFieldAuthor.get(`*|${dataPoint}`),
        ].filter((e): e is { index: number; value: unknown } =>
          e !== undefined && e.value === resolved.batteryClaim);
        batteryClaims.push({
          stationMac: mac,
          dataPoint,
          batteryField: resolved.batteryClaim,
          overrideIndex: authorEntries.length > 0
            ? Math.min(...authorEntries.map(e => e.index))
            : undefined,
          row: resolved.row,
        });
      }
    }
  }

  // ---- 5. Battery-ownership adjudication (Stage-4 pass). Claims on
  //         the same (station, batteryField) are ordered by
  //         `earliestOverrideIndex` — the fragment that authored the
  //         winning `batteryField` value — with `(stationMac,
  //         dataPoint)` lexicographic order as the final tie-break.
  //         Losers keep the field for battery-low reading but host no
  //         sub-service; the collision routes through the NOTES channel
  //         (source 'override' with the loser's fragment, falling back
  //         to the winner's; 'default-map' only in the
  //         unreachable-by-invariant both-default case).
  const claimGroups = new Map<string, BatteryClaimCandidate[]>();
  for (const claim of batteryClaims) {
    const key = `${claim.stationMac}|${claim.batteryField}`;
    const group = claimGroups.get(key) ?? [];
    group.push(claim);
    claimGroups.set(key, group);
  }
  for (const group of claimGroups.values()) {
    group.sort((a, b) => {
      const ai = a.overrideIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.overrideIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) {
        return ai - bi;
      }
      // stationMac is constant within a group; dataPoint breaks the tie.
      return a.dataPoint.localeCompare(b.dataPoint);
    });
    const winner = group[0];
    (winner.row as { hasBatterySubService: boolean }).hasBatterySubService = true;
    for (const loser of group.slice(1)) {
      const attribution = loser.overrideIndex ?? winner.overrideIndex;
      notes.push({
        code: 'duplicate-battery-owner',
        source: attribution !== undefined ? 'override' : 'default-map',
        overrideIndex: attribution,
        dataPoint: loser.dataPoint,
        stationMac: loser.stationMac,
        message: `Row '${loser.dataPoint}' on ${loser.stationMac} declares batteryField `
          + `'${loser.batteryField}', but '${winner.dataPoint}' owns that field's Battery `
          + 'sub-service on this station (earliest-authored fragment wins). '
          + `'${loser.dataPoint}' will report the battery value but not host the HAP BatteryService.`,
      });
    }
  }

  // ---- 6. Orphan-battery-field notes (Stage-4 pass). A reserved
  //         field loses its HAP sub-service when its canonical owner is
  //         DISABLED or REBOUND to a different batteryField (review
  //         R12-2) — ownership never rolls anywhere in either case
  //         (structural-signature stability; the reserved set blocks
  //         all other claimants). Surface a note per (station, field)
  //         whenever enabled rows still reference the orphaned field,
  //         attributed to the fragment that disabled or rebound the
  //         owner, so users understand why the sub-service went away.
  const rowsByStation = new Map<string, EffectiveSensorRow[]>();
  for (const row of rows) {
    const list = rowsByStation.get(row.stationMac) ?? [];
    list.push(row);
    rowsByStation.set(row.stationMac, list);
  }
  for (const [mac, stationRows] of rowsByStation) {
    for (const [field, ownerDp] of CANONICAL_OWNER_FOR_FIELD) {
      const owner = stationRows.find(r => r.dataPoint === ownerDp);
      if (!owner || owner.kind === 'unrecognized') {
        continue;
      }
      const ownerDisabled = !owner.enabled;
      const ownerRebound = owner.enabled && owner.batteryField !== field;
      if (!ownerDisabled && !ownerRebound) {
        continue;
      }
      const referencing = stationRows.filter(r =>
        r.kind !== 'unrecognized' && r.enabled && r.dataPoint !== ownerDp && r.batteryField === field);
      if (referencing.length === 0) {
        continue;
      }
      // Attribution: the fragment that disabled the owner, or (rebind)
      // the fragment that authored the owner's NEW batteryField value.
      const disabledBy = enabledProvenance.get(`${mac}|${ownerDp}`)
        ?? enabledProvenance.get(`*|${ownerDp}`);
      const reboundBy = [
        batteryFieldAuthor.get(`${mac}|${ownerDp}`),
        batteryFieldAuthor.get(`*|${ownerDp}`),
      ].filter((e): e is { index: number; value: unknown } =>
        e !== undefined && e.value === owner.batteryField)
        .reduce<number | undefined>((min, e) => (min === undefined || e.index < min ? e.index : min), undefined);
      const attribution = ownerDisabled ? disabledBy : reboundBy;
      const cause = ownerDisabled
        ? `is disabled`
        : `was rebound to batteryField '${String(owner.batteryField)}'`;
      const remedy = ownerDisabled
        ? `until '${ownerDp}' is re-enabled`
        : `until '${ownerDp}' is restored to '${field}'`;
      notes.push({
        code: 'orphan-battery-field',
        source: attribution !== undefined ? 'override' : 'default-map',
        overrideIndex: attribution,
        dataPoint: ownerDp,
        stationMac: mac,
        message: `'${ownerDp}' on ${mac} ${cause}, but it is the reserved owner of batteryField `
          + `'${field}', which ${referencing.length} enabled row(s) still reference `
          + `(${referencing.map(r => `'${r.dataPoint}'`).join(', ')}). The field has no HAP Battery `
          + `sub-service on this station ${remedy} — ownership never rolls to another row, so this `
          + 'change cannot invalidate accessory caches.',
      });
    }
  }

  // ---- 7. Structural signatures — computed only AFTER ownership
  //         settles, so a signature is a pure function of the resolved
  //         row, never of resolution iteration order.
  for (const row of rows) {
    if (row.kind === 'unrecognized') {
      continue;
    }
    (row as { structuralSignature: string }).structuralSignature =
      computeStructuralSignature(row.kind, row.measurement, row.hasBatterySubService, wrapperById(row.wrapperId));
  }

  return { rows, errors, warnings, notes };
}

/** One (station, batteryField) claim awaiting the ownership pass. */
interface BatteryClaimCandidate {
  stationMac: string;
  dataPoint: string;
  batteryField: string;
  /**
   * The fragment that authored this row's winning `batteryField` value
   * — the `earliestOverrideIndex` ordering key. Undefined only when the
   * field came from the default map (a default row overridden onto the
   * claims path always has provenance, so undefined is effectively the
   * unreachable both-default case guarded by the module-load invariant).
   */
  overrideIndex: number | undefined;
  row: EffectiveSensorRow;
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
   * Called when a CUSTOM row (no `defaultRow`) resolves no wrapper —
   * i.e. its `(kind, measurement)` isn't in
   * `WRAPPER_FOR_KIND_AND_MEASUREMENT`. With the table restored
   * (Stage 4) this is reachable only for kinds without a concrete
   * wrapper class (co, leak, contact, occupancy). The loop pushes a
   * `no-wrapper` RowValidationError. Known rows never reach here
   * (their wrapper comes from `defaultRow.wrapper`).
   */
  onNoWrapper: (kind: string, measurement: string) => void;
  /**
   * Called when a resolved row's `wrapperId` disagrees with its
   * `(kind, measurement)` per `WRAPPER_SPEC` (finding-#4 review P1 —
   * enforce wrapper compatibility at map construction). The row is
   * DROPPED and the loop pushes a `wrapper-mismatch` note.
   * `fromDefaultMap` is true when the row's kind/measurement came from
   * the built-in default map (a plugin bug, no config to blame).
   */
  onWrapperMismatch: (
    wrapperId: string, kind: string, measurement: string, fromDefaultMap: boolean,
  ) => void;
}

/**
 * resolveRow's result: the row (or null) plus an optional battery-claim
 * marker. The Stage-4 ownership rules (docs/future/
 * wrapper-parameterization.md §"Custom-row battery attachment"):
 *
 *   1. Default-map canonical rows keep their reservation. Every AWN
 *      battery field is contractually owned by the row with
 *      `canonicalForBattery: true` — this preserves v1.6.0's exact
 *      behavior and matches user muscle memory (battout → tempf,
 *      batt_co2 → co2_in_aqin, ...).
 *   2. Any OTHER row (custom, or a default whose batteryField was
 *      overridden to a novel value) may claim a field only when it is
 *      not in the reserved-by-default set. Eligibility is a STATIC
 *      test against DEFAULT_SENSOR_MAP — never transient telemetry.
 *   3. Competing claimants on the same (station, batteryField) are
 *      adjudicated AFTER the resolution loop: `earliestOverrideIndex`
 *      primary, `(stationMac, dataPoint)` lexicographic final
 *      tie-break. The `batteryClaim` marker here just enrolls the row.
 *   4. Disabled rows never participate — and a disabled canonical
 *      default does NOT roll ownership anywhere (structural-signature
 *      stability); the orphan-battery-field note surfaces that state.
 */
interface ResolvedRow {
  row: EffectiveSensorRow | null;
  /** Set when the row enrolls in the post-loop ownership adjudication. */
  batteryClaim?: string;
}

function resolveRow(inp: ResolveInput): ResolvedRow {
  const {
    stationMac, dataPoint, defaultRow, override, discovered,
    onNoWrapper, onWrapperMismatch,
  } = inp;

  // ---- Unrecognized: no default, no user override with kind+measurement.
  if (!defaultRow && !hasKindAndMeasurement(override)) {
    if (!discovered) {
      // Neither default, custom-declared, nor observed. Nothing to emit.
      return { row: null };
    }
    return { row: buildUnrecognizedRow(stationMac, dataPoint, discovered) };
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
    // Custom row (no defaultRow) whose (kind, measurement) has no
    // wrapper. With the table restored (Stage 4) only kinds without a
    // concrete wrapper class (co, leak, contact, occupancy) land here.
    // Surface a `no-wrapper` error (via the loop) rather than silently
    // dropping the row — the user needs to know their custom sensor
    // was rejected. Known rows never reach this branch
    // (defaultRow.wrapper is always set).
    onNoWrapper(kind, measurement);
    return { row: null };
  }

  // ---- Resolve units. A custom row that omits `displayUnit` gets the
  //      measurement's DOCUMENTED default display unit (review R10-3) —
  //      falling back to the row's sourceUnit would silently flip a
  //      metric-source custom to metric display (mm_per_hr / hPa / km
  //      instead of the frozen in_per_hr / inHg / mi defaults).
  const sourceUnit: SensorUnit | undefined = defaultRow?.sourceUnit ?? override?.sourceUnit;
  const displayUnit: SensorUnit | undefined =
    override?.displayUnit
    ?? defaultRow?.displayUnit
    ?? DEFAULT_DISPLAY_UNIT_FOR_MEASUREMENT[measurement]
    ?? sourceUnit;

  // ---- Resolve enabled BEFORE battery ownership. A disabled row
  //       must never consume a claim slot.
  const enabled = override?.enabled !== false;

  // ---- Resolve battery attachment (Stage-4 ownership pass; see the
  //       ResolvedRow doc-comment). Canonical defaults own outright;
  //       novel-field claimants enroll for the post-loop adjudication;
  //       reserved fields and disabled rows never attach here.
  const batteryField = resolveBatteryField(defaultRow, override);
  const isCanonicalDefault = defaultRow !== undefined
    && defaultRow.canonicalForBattery
    && defaultRow.batteryField === batteryField;
  let hasBatterySubService = false;
  let batteryClaim: string | undefined;
  if (batteryField !== null && enabled) {
    if (isCanonicalDefault) {
      hasBatterySubService = true;
    } else if (!RESERVED_BATTERY_FIELDS.has(batteryField)) {
      batteryClaim = batteryField;
    }
  }

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
  // Direction fallback is MEASUREMENT-AWARE (review R10-2): for
  // pressure and lightning-distance the alarming direction is LOW
  // (storm incoming / strike nearby) — every known default row of
  // those families carries `below`, and a custom row with a threshold
  // but no explicit direction must behave the same, not trigger on
  // high pressure or distant lightning.
  const familyDefaultDirection: 'above' | 'below' =
    (measurement === 'pressure' || measurement === 'distance') ? 'below' : 'above';
  const triggerDirection: 'above' | 'below' = isMotion
    ? (override?.triggerDirection ?? defaultRow?.triggerDirection ?? familyDefaultDirection)
    : 'above';
  const threshold = isMotion
    ? (override?.threshold ?? defaultRow?.threshold)
    : undefined;
  const embedName = isMotion
    ? (override?.embedName ?? defaultRow?.embedName ?? false)
    : false;

  const wrapperId = wrapper.id;

  // ---- Enforce wrapper compatibility at map construction (finding-#4
  //       review P1). The resolved wrapperId must agree with this row's
  //       (kind, measurement) per WRAPPER_SPEC. On mismatch, DROP the row
  //       and push a `wrapper-mismatch` note rather than signing a row
  //       that would throw at `instantiateWrapper` (the registration-time
  //       assertion stays as defense-in-depth). A known row's kind/
  //       measurement come from the default map (a plugin bug → no config
  //       to blame); a custom row's from the override.
  const spec = WRAPPER_SPEC[wrapperId];
  // Cast to string so the comparison doesn't narrow `measurement` in the
  // outer scope (which would make the future-proof `boolean` branch below
  // unreachable — no WrapperId maps to a boolean measurement today).
  if ((kind as string) !== spec.kind || (measurement as string) !== spec.measurement) {
    onWrapperMismatch(wrapperId, kind, measurement, defaultRow !== undefined);
    return { row: null };
  }

  // structuralSignature is a PLACEHOLDER here — the ownership pass may
  // still flip `hasBatterySubService` for enrolled claimants, and the
  // signature must reflect the settled value. buildEffectiveSensorMap
  // computes every configured row's signature after adjudication.
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
    structuralSignature: '',
    wrapperId,
  } as const;

  if (measurement === 'boolean') {
    const row: BooleanSensorRow = { ...base, measurement: 'boolean' };
    return { row, batteryClaim };
  }
  if (measurement === 'timestamp') {
    const row: TimestampSensorRow = { ...base, measurement: 'timestamp', sourceUnit: 'ms' };
    return { row, batteryClaim };
  }
  // Numeric.
  if (!sourceUnit || !displayUnit) {
    // Underspecified custom row that slipped past validation. Skip.
    return { row: null };
  }
  const row: NumericSensorRow = {
    ...base,
    measurement: measurement as NumericSensorRow['measurement'],
    sourceUnit,
    displayUnit,
  };
  return { row, batteryClaim };
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
 * Startup invariant: every distinct non-null `batteryField` in
 * `DEFAULT_SENSOR_MAP` has EXACTLY ONE row with
 * `canonicalForBattery: true`.
 *
 * Two failure modes we protect against:
 *   1. Two canonical owners for the same field — would produce a
 *      duplicate-battery-owner collision between default-map rows
 *      that have no user-authored `overrideIndex`, so the warning
 *      would have no honest fragment to attribute to.
 *   2. Zero canonical owners for a field that IS referenced by
 *      non-canonical default rows — same problem the moment those
 *      rows try to claim the field: no default row has canonical
 *      authority, and a runtime collision on two non-canonical
 *      defaults sharing the field would also be attribution-free.
 *
 * Failing fast at module load is preferable to silently degrading
 * to a debug-log-and-drop path at runtime. Executed unconditionally
 * on import; if it ever throws in CI, the offending
 * DEFAULT_SENSOR_MAP entries need to be reconciled.
 */
function assertCanonicalBatteryOwnersUnique(): void {
  const canonicalOwners = new Map<string, string>();   // batteryField → dataPoint
  const referencedFields = new Set<string>();

  for (const row of DEFAULT_SENSOR_MAP) {
    if (row.batteryField === null) {
      continue;
    }
    referencedFields.add(row.batteryField);
    if (!row.canonicalForBattery) {
      continue;
    }
    const existing = canonicalOwners.get(row.batteryField);
    if (existing !== undefined) {
      throw new Error(
        `DEFAULT_SENSOR_MAP invariant violation: batteryField '${row.batteryField}' `
        + `has two canonical owners ('${existing}' and '${row.dataPoint}'). `
        + 'A batteryField may be shared by many rows but must have exactly one '
        + 'row with canonicalForBattery: true.',
      );
    }
    canonicalOwners.set(row.batteryField, row.dataPoint);
  }

  for (const field of referencedFields) {
    if (!canonicalOwners.has(field)) {
      throw new Error(
        `DEFAULT_SENSOR_MAP invariant violation: batteryField '${field}' is referenced `
        + 'by one or more rows but has NO row with canonicalForBattery: true. Every '
        + 'referenced batteryField needs exactly one canonical owner.',
      );
    }
  }
}
assertCanonicalBatteryOwnersUnique();

/**
 * batteryField → its canonical owner's dataPoint. Consumed by the
 * orphan-battery-field pass: when the owner row is disabled on a
 * station while other enabled rows still reference the field, a note
 * explains why the sub-service disappeared. Uniqueness of owners is
 * guaranteed by `assertCanonicalBatteryOwnersUnique()` above.
 */
const CANONICAL_OWNER_FOR_FIELD: ReadonlyMap<string, string> = new Map(
  DEFAULT_SENSOR_MAP
    .filter(r => r.canonicalForBattery && r.batteryField !== null)
    .map(r => [r.batteryField as string, r.dataPoint]),
);

// Suppress the "wrapper unused" hint for callers that only need the type.
export type { WrapperDescriptor };

/**
 * Legacy mirror + immutable snapshot — the downgrade-safety package for
 * the v2 config migration (finding-#4 Stage 4, review finding 5).
 *
 * THE PROBLEM (the mirror-ABSENT/STALE case): if a v2 config carried
 * no synchronized legacy fields — or outdated ones — a plugin
 * downgraded to an UNGUARDED release (v1.7.0 and earlier, which DO
 * attempt to interpret whatever legacy fields are present) would read
 * every category toggle as false, produce an empty device set, and
 * unregister the entire accessory cache on its FIRST boot — before any
 * human can restore a backup. Room placement and automations die at
 * that moment and are not recoverable by re-registering the same
 * UUIDs. (The editor migration does NOT remove the legacy toggles: it
 * re-emits them, synchronized, as the mirror below. Guarded v1.7.1+
 * releases never interpret a v2-marked config at all — they freeze.)
 *
 * THE PACKAGE (three layers, each independent):
 *
 *   1. IMMUTABLE SNAPSHOT (permanent). At the first v2 conversion —
 *      BEFORE config.json is mutated — the UI save flow writes the
 *      ORIGINAL legacy sensor-configuration fields (which the
 *      conversion supersedes and re-emits in synchronized, projected
 *      form — see the mirror below) to `legacy-config-snapshot.json`
 *      in the plugin persist dir, via the atomic persistence helper. Never overwritten; never contains API
 *      secrets (only `LEGACY_SENSOR_FIELDS`). Provenance + the manual
 *      late-rollback procedure's source of truth.
 *
 *      Conversions AFTER the first (a user who performed the
 *      current-state rollback and later re-enables v2 converts from
 *      the projected mirror form, which differs from the original)
 *      leave the snapshot untouched and instead append the
 *      pre-conversion legacy baseline to the CONVERSION JOURNAL
 *      (the `legacy-conversion-journal/` directory: one immutable
 *      exclusive-created entry file per baseline, append-only,
 *      deduplicated against the latest entry, same secret-free
 *      vocabulary). The entry is durable and read back BEFORE
 *      config.json is mutated, so no operative legacy state is ever
 *      lost to a reconversion; a corrupt journal fails the save
 *      closed.
 *
 *   2. SYNCHRONIZED MIRROR (time-boxed). Every automated v2 UI save
 *      re-emits legacy sensor fields ALONGSIDE `configVersion: 2` +
 *      `sensorMap`, projected from the effective v2 map by
 *      `projectLegacyMirror`. Its value is the CURRENT-STATE MANUAL
 *      rollback: remove `sensorMap`, `configVersion`, and
 *      `_legacyMirror` from the block, and the remaining synchronized
 *      legacy fields ARE a working 1.x configuration of the current
 *      state — no field reconstruction. The shipped 1.7.x guard
 *      freezes on ANY v2-marked config BEFORE reading these fields,
 *      mirrored or not: nothing on the 1.7.x line consumes the mirror
 *      automatically (that would require a NEW 1.7.x release). Marked
 *      with `_legacyMirror: { version, hash }` so `detectConfigMode`
 *      suppresses its both-shapes-present ambiguity warning ONLY for a
 *      recognized, hash-matching mirror; a manual `sensorMap` edit that
 *      stales the mirror is detectable (hash mismatch) and warned.
 *      The runtime plugin never rewrites config — mirror maintenance is
 *      exclusively the UI server's save path (`composeV2ConfigSave`).
 *
 *   3. The v1.7.1+ guard (separate release) freezes instead of
 *      reconciling when it sees ANY v2 config — downgrade safety comes
 *      from the guard alone, never from the mirror.
 *
 * REVERSE-PROJECTION CONTRACT (conservative, cache-preservation first):
 * the mirror's job is that v1.7 registers EXACTLY the v1.7-representable
 * accessories the v2 map enables — zero unregister calls for those.
 * Behavioral knobs (thresholds, units, embed) are best-effort:
 *
 *   - Enable/disable is expressed via category toggles plus
 *     `excludeSensors` (bare dataPoint when disabled on every station;
 *     `MAC-dataPoint` for station-specific disables — v1.7 matches both
 *     natively). Per-threshold enable checkboxes are NOT used: one
 *     uniform mechanism, no shared-checkbox (windGust/maxdailygust,
 *     both pressures) coupling hazards.
 *   - CUSTOM rows (dataPoints outside the default map) are the explicit
 *     downgrade-loss boundary: v1.7 cannot drive them, and worse, its
 *     broad matchers (`sensor.includes('temp')`) could misclassify one
 *     and construct a WRONG wrapper. Every custom row therefore emits
 *     its station-scoped `MAC-dataPoint` exclusion AND the bare
 *     dataPoint form (covers stations that appear later).
 *   - Station-CONFLICTING thresholds cannot be represented in v1.7
 *     (its knobs are global). Documented fallback: the value effective
 *     on the lexicographically-lowest station MAC wins (deterministic);
 *     other stations see that value after a downgrade. Shared-knob
 *     dataPoints (windGustMph covers windgustmph + maxdailygust;
 *     pressureInHg covers both pressures) take the first-listed
 *     dataPoint's value. Display units are family-wide in v1.7: a
 *     family unit is mirrored only when UNIFORM across the family's
 *     enabled rows, else omitted (v1.7 default applies on downgrade).
 *     Structural registration is unaffected by any of these.
 *   - `extendedDisplayMode: 'embed'` is mirrored only when EVERY
 *     enabled motion row has `embedName: true` (v1.7's knob is global;
 *     defaulting to static avoids surprise battery drain).
 *   - Battery suppression (`batteryField: null` on a row whose default
 *     owns a battery) mirrors as the raw batt* field name in
 *     `excludeSensors` (v1.7 form 1). Sub-service granularity is
 *     per-field in v1.7, not per-station; suppressed anywhere =>
 *     suppressed in the mirror.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import type { LegacyConfig } from './compat.js';
// Type-only: erased at runtime, so no import cycle with configMode.ts
// (which imports recognizeMirror from this module).
import type { ConfigMode } from './configMode.js';
import { defaultRowFor } from './defaultMap.js';
import type {
  EffectiveSensorMap,
  EffectiveSensorRow,
  SensorUnit,
} from './types.js';
import { V17_LEGAL_LEGACY_UNITS } from './unitVocabulary.js';
import {
  REAL_CLOCK,
  type Clock,
  type Logger,
} from './persistence/atomicWrite.js';

/** Metadata key stamped into config.json next to the mirrored fields. */
export const LEGACY_MIRROR_KEY = '_legacyMirror';

/** Persist-dir filename of the immutable first-conversion snapshot. */
export const LEGACY_SNAPSHOT_FILE = 'legacy-config-snapshot.json';

/** Persist-dir DIRECTORY of the append-only conversion journal that
 * records the pre-conversion legacy baseline of every conversion AFTER
 * the first (reconversion following a current-state rollback). One
 * immutable `entry-NNNNNN.json` file per baseline — a directory of
 * exclusive-created files rather than one mutable file, so concurrent
 * writer PROCESSES can never overwrite each other's entries. */
export const LEGACY_JOURNAL_DIR = 'legacy-conversion-journal';

/** Mirror-metadata schema version — module internal (stamped into and
 * validated against `_legacyMirror.version`; consumers interact with it
 * only through `recognizeMirror`'s 'invalid' state). */
const LEGACY_MIRROR_VERSION = 1;

/**
 * The legacy sensor-configuration vocabulary the snapshot preserves and
 * the mirror maintains. Deliberately excludes API credentials
 * (apiKey/applicationKey), platform identity, and mode-independent
 * fields (stationFilter, dataSource, embedNameUpdateMinIntervalMinutes)
 * — those stay live, unmirrored fields in both config shapes. Matches
 * configMode.ts's LEGACY_TOGGLE_KEYS.
 */
export const LEGACY_SENSOR_FIELDS = [
  'temperatureSensors', 'humiditySensors', 'solarRadiationSensors',
  'co2Sensors', 'airQualitySensors', 'extendedSensors',
  'windSensors', 'rainSensors', 'pressureSensors', 'uvSensors',
  'lightningSensors', 'extendedDisplayMode', 'thresholds', 'units',
  'excludeSensors', 'includeOnly',
] as const;

export interface LegacyMirrorMeta {
  version: number;
  /**
   * Canonical hash binding BOTH the mirrored legacy fields AND the
   * canonical `sensorMap` at save time — editing either side by hand
   * reads as STALE. See `mirrorHash`.
   */
  hash: string;
}

/** Configured (registerable) rows only. */
type ConfiguredRow = Exclude<EffectiveSensorRow, { kind: 'unrecognized' }>;

/**
 * Reverse projection: effective v2 map → sparse v1.7 legacy fields.
 * PURE. See the module header for the contract.
 */
export function projectLegacyMirror(effectiveMap: EffectiveSensorMap): LegacyConfig {
  const known: ConfiguredRow[] = [];
  const custom: ConfiguredRow[] = [];
  for (const row of effectiveMap.rows) {
    if (row.kind === 'unrecognized') {
      continue;
    }
    if (defaultRowFor(row.dataPoint)) {
      known.push(row);
    } else {
      custom.push(row);
    }
  }

  const mirror: LegacyConfig = {};

  // ---- Category toggles: ON iff any row of the family is enabled.
  const anyEnabled = (pred: (r: ConfiguredRow) => boolean): boolean =>
    known.some(r => r.enabled && pred(r));

  mirror.temperatureSensors = anyEnabled(r => r.kind === 'temperature');
  mirror.humiditySensors = anyEnabled(r => r.kind === 'humidity');
  mirror.solarRadiationSensors = anyEnabled(r => r.kind === 'light');
  mirror.co2Sensors = anyEnabled(r => r.kind === 'co2');
  mirror.airQualitySensors = anyEnabled(r => r.kind === 'air-quality-pm25' || r.kind === 'air-quality-pm10');

  const motionFamily = (r: ConfiguredRow): 'wind' | 'rain' | 'pressure' | 'uv' | 'lightning' | undefined => {
    if (r.kind !== 'motion') {
      return undefined;
    }
    switch (r.measurement) {
      case 'wind-speed':
      case 'direction':
        return 'wind';
      case 'rain-rate':
      case 'rain-accumulation':
        return 'rain';
      case 'pressure':
        return 'pressure';
      case 'uv-index':
        return 'uv';
      case 'count':
      case 'distance':
        return 'lightning';
      case 'timestamp':
        return r.dataPoint === 'lastRain' ? 'rain'
          : r.dataPoint === 'lightning_time' ? 'lightning'
            : undefined;
      default:
        return undefined;
    }
  };
  mirror.extendedSensors = anyEnabled(r => r.kind === 'motion');
  mirror.windSensors = anyEnabled(r => motionFamily(r) === 'wind');
  mirror.rainSensors = anyEnabled(r => motionFamily(r) === 'rain');
  mirror.pressureSensors = anyEnabled(r => motionFamily(r) === 'pressure');
  mirror.uvSensors = anyEnabled(r => motionFamily(r) === 'uv');
  mirror.lightningSensors = anyEnabled(r => motionFamily(r) === 'lightning');

  // ---- Per-row disables → excludeSensors (single uniform mechanism).
  //      Grouped by dataPoint: disabled on EVERY station → bare form;
  //      otherwise one MAC-dataPoint entry per disabled station. Only
  //      emitted when the row's category toggle is ON (otherwise the
  //      toggle already suppresses it and an exclusion would be noise).
  const excludeSensors: string[] = [];
  const byDataPoint = new Map<string, ConfiguredRow[]>();
  for (const r of known) {
    const list = byDataPoint.get(r.dataPoint) ?? [];
    list.push(r);
    byDataPoint.set(r.dataPoint, list);
  }
  const categoryOn = (r: ConfiguredRow): boolean => {
    switch (r.kind) {
      case 'temperature':      return mirror.temperatureSensors === true;
      case 'humidity':         return mirror.humiditySensors === true;
      case 'light':            return mirror.solarRadiationSensors === true;
      case 'co2':              return mirror.co2Sensors === true;
      case 'air-quality-pm25':
      case 'air-quality-pm10': return mirror.airQualitySensors === true;
      case 'motion': {
        if (mirror.extendedSensors !== true) {
          return false;
        }
        switch (motionFamily(r)) {
          case 'wind':      return mirror.windSensors === true;
          case 'rain':      return mirror.rainSensors === true;
          case 'pressure':  return mirror.pressureSensors === true;
          case 'uv':        return mirror.uvSensors === true;
          case 'lightning': return mirror.lightningSensors === true;
          default:          return false;
        }
      }
      default:
        return false;
    }
  };
  for (const [dataPoint, rows] of byDataPoint) {
    const disabled = rows.filter(r => !r.enabled && categoryOn(r));
    if (disabled.length === 0) {
      continue;
    }
    if (disabled.length === rows.length) {
      excludeSensors.push(dataPoint);
    } else {
      for (const r of disabled) {
        excludeSensors.push(`${r.stationMac}-${dataPoint}`);
      }
    }
  }

  // ---- Custom rows: the explicit downgrade-loss boundary. Exclude by
  //      station-scoped uniqueId AND bare dataPoint so v1.7's broad
  //      includes() matchers can never misclassify one into a wrong
  //      wrapper (on any station, present or future).
  const customDataPoints = new Set<string>();
  for (const r of custom) {
    excludeSensors.push(`${r.stationMac}-${r.dataPoint}`);
    customDataPoints.add(r.dataPoint);
  }
  // Custom declarations for wrapper-less kinds (co, leak, contact,
  // occupancy) surface as `no-wrapper` ERRORS instead of rows — cover
  // both sources so every declared custom dataPoint is excluded from
  // the mirror whether it resolved a wrapper or not.
  for (const e of effectiveMap.errors) {
    if (e.code === 'no-wrapper' && e.dataPoint) {
      if (e.stationMac) {
        excludeSensors.push(`${e.stationMac}-${e.dataPoint}`);
      }
      customDataPoints.add(e.dataPoint);
    }
  }
  for (const dp of customDataPoints) {
    excludeSensors.push(dp);
  }

  // ---- Battery suppression: a known row whose default owns a battery
  //      but whose effective batteryField is null → raw field form.
  const suppressedFields = new Set<string>();
  for (const r of known) {
    const def = defaultRowFor(r.dataPoint);
    if (def?.batteryField && r.batteryField === null) {
      suppressedFields.add(def.batteryField);
    }
  }
  for (const f of suppressedFields) {
    excludeSensors.push(f);
  }

  if (excludeSensors.length > 0) {
    mirror.excludeSensors = [...new Set(excludeSensors)];
  }

  // ---- Thresholds (values only — enable state is excludeSensors').
  //      Lowest-station-MAC fallback on conflicts (documented).
  const thresholdFor = (dataPoint: string): number | undefined => {
    const rows = (byDataPoint.get(dataPoint) ?? [])
      .filter(r => r.enabled)
      .sort((a, b) => a.stationMac.localeCompare(b.stationMac));
    return rows[0]?.threshold;
  };
  const thresholds: NonNullable<LegacyConfig['thresholds']> = {};
  const windSpeedMph = thresholdFor('windspeedmph');
  if (windSpeedMph !== undefined) {
    thresholds.windSpeedMph = windSpeedMph;
  }
  const windGustMph = thresholdFor('windgustmph') ?? thresholdFor('maxdailygust');
  if (windGustMph !== undefined) {
    thresholds.windGustMph = windGustMph;
  }
  const rainRateInHr = thresholdFor('hourlyrainin');
  if (rainRateInHr !== undefined) {
    thresholds.rainRateInHr = rainRateInHr;
  }
  const uv = thresholdFor('uv');
  if (uv !== undefined) {
    thresholds.uv = uv;
  }
  const lightningDistanceMi = thresholdFor('lightning_distance');
  if (lightningDistanceMi !== undefined) {
    thresholds.lightningDistanceMi = lightningDistanceMi;
  }
  const pressureInHg = thresholdFor('baromrelin') ?? thresholdFor('baromabsin');
  if (pressureInHg !== undefined) {
    thresholds.pressureInHg = pressureInHg;
  }
  if (Object.keys(thresholds).length > 0) {
    mirror.thresholds = thresholds;
  }

  // ---- Display units. v1.7's units.* knobs are FAMILY-wide; per-row
  //      or per-station unit overrides are not v1-expressible. Emit a
  //      family unit only when it is UNIFORM across the family's
  //      enabled rows (and differs from the AWN-native default);
  //      otherwise omit, so a downgrade falls back to v1.7 defaults
  //      rather than silently stretching one row's unit over the whole
  //      family. Documented fallback behavior.
  const unitFor = (pred: (r: ConfiguredRow) => boolean): SensorUnit | undefined => {
    const values = new Set<SensorUnit>();
    for (const r of known) {
      if (r.enabled && pred(r) && 'displayUnit' in r && r.displayUnit !== undefined) {
        values.add(r.displayUnit);
      }
    }
    return values.size === 1 ? [...values][0] : undefined;
  };
  // v2-only display units (mmHg, fps, and any future addition) must
  // NOT leak into a 1.7.x rollback config: 1.7's converters predate
  // them, so its wrappers would fall back to the AWN-native conversion
  // while the formatter prints the new unit's name — a silent
  // 25.4x-class display error. Project a family unit only when 1.7
  // actually understands it (V17_LEGAL_LEGACY_UNITS); otherwise omit
  // the key so a downgrade falls back to 1.7's default display unit —
  // a display-only fallback, never accessory loss. Documented in
  // sensor-map.md's downgrade section and pinned by tests.
  const units: NonNullable<LegacyConfig['units']> = {};
  const windUnit = unitFor(r => r.kind === 'motion' && r.measurement === 'wind-speed');
  if (windUnit && windUnit !== 'mph' && V17_LEGAL_LEGACY_UNITS.windSpeed.includes(windUnit)) {
    units.windSpeed = windUnit;
  }
  // v1.7's units.rain is a single in/mm dropdown covering both
  // accumulation and rate; project rate units down to their base.
  const rainUnit = unitFor(r => r.kind === 'motion' && (r.measurement === 'rain-accumulation' || r.measurement === 'rain-rate'));
  if (rainUnit) {
    const base: SensorUnit | undefined =
      rainUnit === 'mm' || rainUnit === 'mm_per_hr' ? 'mm'
        : rainUnit === 'in' || rainUnit === 'in_per_hr' ? 'in'
          : undefined;
    if (base === 'mm') {
      units.rain = base;
    }
  }
  const pressureUnit = unitFor(r => r.kind === 'motion' && r.measurement === 'pressure');
  if (pressureUnit && pressureUnit !== 'inHg' && V17_LEGAL_LEGACY_UNITS.pressure.includes(pressureUnit)) {
    units.pressure = pressureUnit;
  }
  const distanceUnit = unitFor(r => r.kind === 'motion' && r.measurement === 'distance');
  if (distanceUnit && distanceUnit !== 'mi' && V17_LEGAL_LEGACY_UNITS.distance.includes(distanceUnit)) {
    units.distance = distanceUnit;
  }
  if (Object.keys(units).length > 0) {
    mirror.units = units;
  }

  // ---- Embed mode: mirrored only when EVERY enabled motion row embeds.
  const enabledMotion = known.filter(r => r.enabled && r.kind === 'motion');
  if (enabledMotion.length > 0 && enabledMotion.every(r => r.embedName)) {
    mirror.extendedDisplayMode = 'embed';
  }

  return mirror;
}

/**
 * Canonical hash binding the mirror to its SOURCE: SHA-256 over a
 * key-sorted JSON serialization of BOTH the `LEGACY_SENSOR_FIELDS`
 * subset AND the canonical `sensorMap`. The mirror is a projection OF
 * the sensorMap, so editing either side by hand invalidates the pair —
 * a sensorMap-only edit must read as STALE just as loudly as a mirrored-
 * field edit (review round 3, finding 2). Field order in config.json
 * and absent-vs-undefined never change the hash.
 */
export function mirrorHash(config: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const key of LEGACY_SENSOR_FIELDS) {
    if (config[key] !== undefined) {
      subset[key] = config[key];
    }
  }
  const bound = { legacy: subset, sensorMap: config.sensorMap ?? null };
  return createHash('sha256').update(canonicalJson(bound)).digest('hex');
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(canonicalJson).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export type MirrorRecognition =
  | { state: 'absent' }
  | { state: 'recognized' }
  | { state: 'stale'; expectedHash: string; actualHash: string }
  | { state: 'invalid'; reason: string };

/**
 * Classify a config's mirror metadata. `recognized` = `_legacyMirror`
 * present with a hash matching the mirrored legacy fields AND the
 * canonical sensorMap as they stand — detectConfigMode suppresses the
 * ambiguity warning only then. `stale` = well-formed metadata whose
 * pair no longer hash-matches: a hand edit of the sensorMap, of a
 * mirrored field, or the deletion of the mirrored fields entirely.
 * `invalid` = metadata is PRESENT but malformed (non-object, unknown
 * version, non-string hash) — as loud a downgrade-safety signal as
 * stale (review R4-4: `{version: 1, hash: 42}` previously read as
 * `absent` and produced zero warning). Only a truly missing key is
 * `absent`. Callers must run this whenever the metadata is present,
 * independent of whether any legacy keys remain.
 */
export function recognizeMirror(config: Record<string, unknown>): MirrorRecognition {
  const meta = config[LEGACY_MIRROR_KEY];
  if (meta === undefined) {
    return { state: 'absent' };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { state: 'invalid', reason: `metadata is ${describeMetaShape(meta)}, expected an object` };
  }
  const m = meta as Partial<LegacyMirrorMeta>;
  if (m.version !== LEGACY_MIRROR_VERSION) {
    return { state: 'invalid', reason: `unsupported metadata version ${JSON.stringify(m.version)} (this plugin supports ${LEGACY_MIRROR_VERSION})` };
  }
  if (typeof m.hash !== 'string' || m.hash.length === 0) {
    return { state: 'invalid', reason: `hash is ${describeMetaShape(m.hash)}, expected a non-empty string` };
  }
  const actual = mirrorHash(config);
  if (actual === m.hash) {
    return { state: 'recognized' };
  }
  return { state: 'stale', expectedHash: m.hash, actualHash: actual };
}

function describeMetaShape(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'an array';
  }
  return `a ${typeof v}`;
}

/**
 * Compose the migration/save payload for the Stage-8 UI save flow. PURE
 * — the caller performs the writes, in this order:
 *
 *   1. If `snapshot` is non-undefined, `writeLegacySnapshot()` it and
 *      AWAIT success BEFORE touching config.json.
 *   2. Persist `nextConfig` through the Homebridge UI config API.
 *
 * `snapshot` carries the legacy sensor fields currently in the config —
 * but ONLY when the runtime classifies `currentConfig` as LEGACY mode.
 * `detectedMode` MUST be `detectConfigMode(currentConfig).mode`: config-
 * mode detection is the single authority on what counts as a legacy
 * config (review R4-3 — an inlined marker check disagreed with it on
 * hybrids like `{configVersion: 1, sensorMap: [...]}`, where
 * configVersion 1 wins and the config IS legacy, and on malformed
 * shapes). The parameter is explicit rather than computed here because
 * `configMode.ts` imports this module (recognizeMirror) — only the
 * TYPE is imported back, which is erased at runtime.
 *
 * On every subsequent v2 save the legacy fields present are the
 * SYNCHRONIZED MIRROR, not user-authored v1 configuration —
 * snapshotting those would let a deleted snapshot be silently
 * "recreated" from the projection, corrupting the permanent
 * rollback/audit record (review R3-5). For a non-legacy input,
 * `snapshot` is always undefined.
 *
 * Throws on `safe-mode`: the design makes safe mode strictly read-only
 * (UI saves are refused, §5), so composing a save from an
 * uninterpretable config is a caller bug, never a valid operation.
 */
export function composeV2ConfigSave(
  currentConfig: Record<string, unknown>,
  sensorMap: unknown[],
  effectiveMap: EffectiveSensorMap,
  detectedMode: ConfigMode,
): { snapshot: Record<string, unknown> | undefined; nextConfig: Record<string, unknown> } {
  if (detectedMode === 'safe-mode') {
    throw new Error('composeV2ConfigSave: cannot compose a v2 save from a safe-mode configuration (UI saves are refused in safe mode).');
  }
  const isLegacyConversion = detectedMode === 'legacy';

  const legacyPresent: Record<string, unknown> = {};
  let hasLegacy = false;
  for (const key of LEGACY_SENSOR_FIELDS) {
    if (currentConfig[key] !== undefined) {
      legacyPresent[key] = currentConfig[key];
      hasLegacy = true;
    }
  }
  hasLegacy = hasLegacy && isLegacyConversion;

  const mirror = projectLegacyMirror(effectiveMap);
  const next: Record<string, unknown> = { ...currentConfig };
  for (const key of LEGACY_SENSOR_FIELDS) {
    delete next[key];
  }
  Object.assign(next, mirror);
  next.configVersion = 2;
  next.sensorMap = sensorMap;
  // Hash the assembled config (mirrored fields + sensorMap) so BOTH
  // sides are bound — a hand edit to either reads as STALE.
  next[LEGACY_MIRROR_KEY] = {
    version: LEGACY_MIRROR_VERSION,
    hash: mirrorHash(next),
  } satisfies LegacyMirrorMeta;

  return { snapshot: hasLegacy ? legacyPresent : undefined, nextConfig: next };
}

/**
 * Write the first-conversion snapshot — IMMUTABLE: if the file already
 * exists it is left untouched and `'exists'` is returned. Contains only
 * `LEGACY_SENSOR_FIELDS` (never API secrets). Callers MUST await this
 * before mutating config.json.
 *
 * Atomic EXCLUSIVE-create (review R3-5): the payload is fully written
 * to a unique temp file, then `link(2)`ed to the final name — link
 * fails with EEXIST if the snapshot already exists, so concurrent first
 * writes cannot overwrite one another (an access()-then-rename check
 * would race: rename replaces an existing destination). Exactly one
 * writer wins; every other caller gets 'exists' and the winner's
 * payload stays intact.
 */
export async function writeLegacySnapshot(
  persistDir: string,
  legacyFields: Record<string, unknown>,
  log: Logger,
  clock: Clock = REAL_CLOCK,
): Promise<'written' | 'exists'> {
  const file = path.join(persistDir, LEGACY_SNAPSHOT_FILE);
  const subset: Record<string, unknown> = {};
  for (const key of LEGACY_SENSOR_FIELDS) {
    if (legacyFields[key] !== undefined) {
      subset[key] = legacyFields[key];
    }
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    savedAt: clock.iso(),
    legacy: subset,
  }, null, 2);

  await fs.mkdir(persistDir, { recursive: true });
  const tmp = path.join(
    persistDir,
    `${LEGACY_SNAPSHOT_FILE}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`,
  );
  await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o640 });
  try {
    await fs.link(tmp, file);
    log.info(`Legacy config snapshot written to ${file}.`);
    return 'written';
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      // Another writer (or a previous conversion) won — immutable.
      return 'exists';
    }
    log.warn(`Legacy config snapshot write failed: ${err.message}`);
    throw err;
  } finally {
    await fs.unlink(tmp).catch(() => { /* best-effort */ });
  }
}

/**
 * Compare an EXISTING snapshot against the authoritative pre-conversion
 * legacy fields (compose-save boundary, review #67 P1-6). The split
 * compose-then-persist transaction has an unavoidable window: a
 * snapshot can be written, the config save can then fail or the iframe
 * close, the user can change the legacy config, and a LATER conversion
 * would see 'exists' — silently blessing a snapshot that no longer
 * matches what is being removed. The boundary therefore verifies:
 *
 *   - 'absent':   no snapshot on disk (caller should write one);
 *   - 'match':    the stored legacy subset equals the authoritative
 *                 fields (key-order-insensitive) — proceed as 'exists';
 *   - 'mismatch': the stored subset differs — the RECONVERSION case
 *                 (a post-rollback config carries the projected
 *                 mirror form, never the original): the caller must
 *                 durably record the current baseline via
 *                 `journalConversionBaseline` BEFORE proceeding, and
 *                 abort if that fails. The snapshot itself is
 *                 immutable and is never overwritten;
 *   - 'corrupt':  unreadable/unparsable/mis-shaped — REFUSE.
 */
export async function verifyLegacySnapshot(
  persistDir: string,
  authoritativeLegacyFields: Record<string, unknown>,
): Promise<'absent' | 'match' | 'mismatch' | 'corrupt'> {
  const file = path.join(persistDir, LEGACY_SNAPSHOT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    return 'corrupt';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'corrupt';
  }
  // Full envelope validation (review #67 P2-4): an unrecognized schema
  // version — or a missing/invalid savedAt — is a snapshot THIS version
  // does not understand, and must block conversion as corrupt rather
  // than be blessed because its legacy subset happens to compare equal.
  const envelope = parsed as { schemaVersion?: unknown; savedAt?: unknown; legacy?: unknown };
  if (envelope.schemaVersion !== 1) {
    return 'corrupt';
  }
  if (typeof envelope.savedAt !== 'string' || Number.isNaN(Date.parse(envelope.savedAt))) {
    return 'corrupt';
  }
  const legacy = envelope.legacy;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return 'corrupt';
  }
  const subset: Record<string, unknown> = {};
  for (const key of LEGACY_SENSOR_FIELDS) {
    if (authoritativeLegacyFields[key] !== undefined) {
      subset[key] = authoritativeLegacyFields[key];
    }
  }
  return canonicalJson(legacy) === canonicalJson(subset) ? 'match' : 'mismatch';
}

/** One recorded pre-conversion baseline in the conversion journal. */
interface ConversionJournalEntry {
  seq: number;
  savedAt: string;
  legacy: Record<string, unknown>;
}

/**
 * Per-journal-path serialization of the read/deduplicate/append
 * sequence WITHIN this process. This is an efficiency measure (it
 * keeps concurrent in-process appends from burning exclusive-create
 * retries), NOT the correctness mechanism: HB UI X forks a SEPARATE
 * custom-UI server process per client socket (verified in
 * plugins-settings-ui.service — `fork()` inside each client handler),
 * so a module-level lock can never serialize all journal writers
 * (review PR #46 round-3 P1, reproduced with two processes).
 * Cross-process safety comes from the journal's on-disk shape:
 * immutable, independently link(2)-created entry FILES that no writer
 * ever replaces — see `journalConversionBaseline`. The chain is
 * failure-safe: a rejected operation settles its link, so later
 * appends still run.
 */
const journalLocks = new Map<string, Promise<unknown>>();

async function withJournalLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const prev = journalLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn); // prev never rejects (tails settle to undefined)
  const tail = run.then(() => undefined, () => undefined);
  journalLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (journalLocks.get(key) === tail) {
      journalLocks.delete(key);
    }
  }
}

/**
 * Record the pre-conversion legacy baseline of a conversion AFTER the
 * first — the reconversion path: a user who performed the documented
 * current-state rollback holds the projected mirror form, which the
 * immutable snapshot correctly reports as a mismatch, yet their
 * operative legacy state must not be lost when they re-enable v2 and
 * save. The journal is APPEND-ONLY (entries are never rewritten or
 * removed) and holds only `LEGACY_SENSOR_FIELDS` — never API secrets.
 *
 * Returns 'unchanged' without writing when the baseline equals the
 * journal's latest entry (key-order-insensitive), so repeated
 * rollback/reconvert cycles of an unedited map do not grow the
 * journal.
 *
 * Fail-closed contract, same standard as the snapshot: callers MUST
 * await this before mutating config.json, and any throw — an existing
 * journal that cannot be parsed or fails shape validation, a write
 * error, or a read-back that does not match what was written — must
 * abort the save. A corrupt journal is never quarantined or replaced:
 * it is an audit record, and the failure message directs manual
 * inspection instead.
 *
 * CROSS-PROCESS append safety (review PR #46 round-3 P1): HB UI X
 * forks a separate UI server per client socket, so any number of
 * writer processes may append concurrently. The journal is therefore
 * a DIRECTORY of immutable entry files (`entry-000001.json`, …), each
 * committed with the same exclusive-create link(2) idiom as the
 * snapshot: writers never replace shared state, so a lost update is
 * structurally impossible. An append reads the directory, deduplicates
 * against the highest-numbered entry, and tries to link the next
 * sequence number; losing the race (EEXIST) re-reads and re-decides —
 * if the winner recorded the same baseline the retry returns
 * 'unchanged', otherwise it appends under the next number. The
 * in-process `withJournalLock` merely keeps local concurrency from
 * burning retries.
 */
export async function journalConversionBaseline(
  persistDir: string,
  legacyFields: Record<string, unknown>,
  log: Logger,
  clock: Clock = REAL_CLOCK,
): Promise<'appended' | 'unchanged'> {
  const dir = path.join(persistDir, LEGACY_JOURNAL_DIR);
  const subset: Record<string, unknown> = {};
  for (const key of LEGACY_SENSOR_FIELDS) {
    if (legacyFields[key] !== undefined) {
      subset[key] = legacyFields[key];
    }
  }

  return withJournalLock(dir, async () => {
    // Fail closed on a pre-release single-FILE journal (shipped only on
    // unreleased 2.0.0-beta.13 builds): its entries are an audit record
    // this code no longer maintains and must not be silently ignored.
    const legacySingleFile = path.join(persistDir, `${LEGACY_JOURNAL_DIR}.json`);
    if (await fs.stat(legacySingleFile).then(() => true, () => false)) {
      throw new Error(`a pre-release single-file conversion journal exists (${legacySingleFile}). `
        + 'Move its entries into the legacy-conversion-journal directory manually (one entry-NNNNNN.json file '
        + 'per entry, numbered in order) or remove the file after preserving its contents.');
    }

    const maxAttempts = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entries = await readConversionJournal(dir);
      const latest = entries[entries.length - 1];
      if (latest !== undefined && canonicalJson(latest.legacy) === canonicalJson(subset)) {
        return 'unchanged';
      }

      const seq = (latest?.seq ?? 0) + 1;
      const entryFile = path.join(dir, journalEntryFileName(seq));
      const body = JSON.stringify({ schemaVersion: 1, savedAt: clock.iso(), legacy: subset }, null, 2);

      await fs.mkdir(dir, { recursive: true });
      // Temp file lives OUTSIDE the journal directory so readers never
      // see in-flight writes as journal content.
      const tmp = path.join(
        persistDir,
        `${LEGACY_JOURNAL_DIR}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`,
      );
      try {
        await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o640 });
        await fs.link(tmp, entryFile);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          // Another writer (possibly another process) took this
          // sequence number — re-read and re-decide.
          continue;
        }
        throw e;
      } finally {
        await fs.unlink(tmp).catch(() => { /* best-effort */ });
      }

      const readBack = await fs.readFile(entryFile, 'utf8');
      if (readBack !== body) {
        throw new Error(`conversion journal read-back does not match what was written (${entryFile})`);
      }
      log.info(`Conversion journal: pre-conversion legacy baseline appended as ${entryFile}.`);
      return 'appended';
    }
    throw new Error(`conversion journal append gave up after ${maxAttempts} sequence-number collisions (${dir}).`);
  });
}

function journalEntryFileName(seq: number): string {
  return `entry-${String(seq).padStart(6, '0')}.json`;
}

const JOURNAL_ENTRY_PATTERN = /^entry-(\d{6})\.json$/;

const LEGACY_FIELD_SET: ReadonlySet<string> = new Set<string>(LEGACY_SENSOR_FIELDS);

/**
 * Read and strictly validate the journal directory. A missing
 * directory is a fresh journal (empty list); every other failure
 * throws — the caller's save must fail closed rather than risk
 * ignoring or restarting an audit record it cannot interpret.
 * Strictness includes the VOCABULARY (review PR #46 P2, reproduced):
 * every entry's `legacy` key must be in `LEGACY_SENSOR_FIELDS` — a
 * journal carrying anything else (e.g. an injected `apiKey`) is
 * rejected rather than blessed. Unknown entry-file keys and files the
 * pattern does not recognize are rejected for the same reason: this
 * version cannot vouch for content it does not understand. Dotfiles
 * (`.DS_Store` and friends) are ignored — OS metadata must not brick
 * the journal.
 */
async function readConversionJournal(dir: string): Promise<ConversionJournalEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(`conversion journal is unreadable (${dir}): ${(e as Error).message}. Inspect it manually; it is never rewritten.`);
  }
  const shapeError = (detail: string): Error =>
    new Error(`conversion journal has an unrecognized shape (${detail}) (${dir}). Inspect it manually; it is never rewritten.`);

  const entries: ConversionJournalEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) {
      continue;
    }
    const match = JOURNAL_ENTRY_PATTERN.exec(name);
    if (!match) {
      throw shapeError(`unexpected file '${name}'`);
    }
    const seq = Number(match[1]);
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new Error(`conversion journal entry is not valid JSON (${file}). Inspect it manually; it is never rewritten.`);
    }
    const e = parsed as { schemaVersion?: unknown; savedAt?: unknown; legacy?: unknown };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || e.schemaVersion !== 1
      || typeof e.savedAt !== 'string' || Number.isNaN(Date.parse(e.savedAt))
      || !e.legacy || typeof e.legacy !== 'object' || Array.isArray(e.legacy)) {
      throw shapeError(`entry '${name}'`);
    }
    for (const key of Object.keys(parsed)) {
      if (key !== 'schemaVersion' && key !== 'savedAt' && key !== 'legacy') {
        throw shapeError(`unknown entry key '${key}' in '${name}'`);
      }
    }
    for (const key of Object.keys(e.legacy)) {
      if (!LEGACY_FIELD_SET.has(key)) {
        throw shapeError(`field '${key}' in '${name}' is outside the legacy sensor-configuration vocabulary`);
      }
    }
    entries.push({ seq, savedAt: e.savedAt, legacy: e.legacy as Record<string, unknown> });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

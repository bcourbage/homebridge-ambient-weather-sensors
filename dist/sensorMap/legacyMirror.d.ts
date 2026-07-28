/**
 * Legacy mirror + immutable snapshot — the downgrade-safety package for
 * the v2 config migration (finding-#4 Stage 4, review finding 5).
 *
 * THE PROBLEM: once the UI migration saves `configVersion: 2` and
 * removes the legacy toggles, a plugin downgraded to v1.7 reads every
 * category toggle as false, produces an empty device set, and
 * unregisters the entire accessory cache on its FIRST boot — before any
 * human can restore a backup. Room placement and automations die at
 * that moment and are not recoverable by re-registering the same UUIDs.
 *
 * THE PACKAGE (three layers, each independent):
 *
 *   1. IMMUTABLE SNAPSHOT (permanent). At the first v2 conversion —
 *      BEFORE config.json is mutated — the UI save flow writes the
 *      legacy sensor-configuration fields it is about to remove to
 *      `legacy-config-snapshot.json` in the plugin persist dir, via the
 *      atomic persistence helper. Never overwritten; never contains API
 *      secrets (only `LEGACY_SENSOR_FIELDS`). Provenance + the manual
 *      late-rollback procedure's source of truth.
 *
 *   2. SYNCHRONIZED MIRROR (time-boxed). Every automated v2 UI save
 *      re-emits legacy sensor fields ALONGSIDE `configVersion: 2` +
 *      `sensorMap`, projected from the effective v2 map by
 *      `projectLegacyMirror`. A downgraded v1.7 reads those fields
 *      directly — zero restore step, no race. Marked with
 *      `_legacyMirror: { version, hash }` so `detectConfigMode`
 *      suppresses its both-shapes-present ambiguity warning ONLY for a
 *      recognized, hash-matching mirror; a manual `sensorMap` edit that
 *      staleness the mirror is detectable (hash mismatch) and warned.
 *      The runtime plugin never rewrites config — mirror maintenance is
 *      exclusively the UI server's save path (`composeV2ConfigSave`).
 *
 *   3. The v1.7.1 guard backport (separate release) freezes instead of
 *      reconciling when it sees a v2 config — the safety net for a
 *      downgrade that lands on a config whose mirror was dropped.
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
import type { LegacyConfig } from './compat.js';
import type { EffectiveSensorMap } from './types.js';
import { type Clock, type Logger } from './persistence/atomicWrite.js';
/** Metadata key stamped into config.json next to the mirrored fields. */
export declare const LEGACY_MIRROR_KEY = "_legacyMirror";
/** Persist-dir filename of the immutable first-conversion snapshot. */
export declare const LEGACY_SNAPSHOT_FILE = "legacy-config-snapshot.json";
export declare const LEGACY_MIRROR_VERSION = 1;
/**
 * The legacy sensor-configuration vocabulary the snapshot preserves and
 * the mirror maintains. Deliberately excludes API credentials
 * (apiKey/applicationKey), platform identity, and mode-independent
 * fields (stationFilter, dataSource, embedNameUpdateMinIntervalMinutes)
 * — those stay live, unmirrored fields in both config shapes. Matches
 * configMode.ts's LEGACY_TOGGLE_KEYS.
 */
export declare const LEGACY_SENSOR_FIELDS: readonly ["temperatureSensors", "humiditySensors", "solarRadiationSensors", "co2Sensors", "airQualitySensors", "extendedSensors", "windSensors", "rainSensors", "pressureSensors", "uvSensors", "lightningSensors", "extendedDisplayMode", "thresholds", "units", "excludeSensors", "includeOnly"];
export interface LegacyMirrorMeta {
    version: number;
    /** Canonical hash of the mirrored legacy fields at save time. */
    hash: string;
}
/**
 * Reverse projection: effective v2 map → sparse v1.7 legacy fields.
 * PURE. See the module header for the contract.
 */
export declare function projectLegacyMirror(effectiveMap: EffectiveSensorMap): LegacyConfig;
/**
 * Canonical hash binding the mirror to its SOURCE: SHA-256 over a
 * key-sorted JSON serialization of BOTH the `LEGACY_SENSOR_FIELDS`
 * subset AND the canonical `sensorMap`. The mirror is a projection OF
 * the sensorMap, so editing either side by hand invalidates the pair —
 * a sensorMap-only edit must read as STALE just as loudly as a mirrored-
 * field edit (review round 3, finding 2). Field order in config.json
 * and absent-vs-undefined never change the hash.
 */
export declare function mirrorHash(config: Record<string, unknown>): string;
export type MirrorRecognition = {
    state: 'absent';
} | {
    state: 'recognized';
} | {
    state: 'stale';
    expectedHash: string;
    actualHash: string;
};
/**
 * Classify a config's mirror metadata. `recognized` = `_legacyMirror`
 * present with a hash matching the mirrored legacy fields AND the
 * canonical sensorMap as they stand — detectConfigMode suppresses the
 * ambiguity warning only then. `stale` = metadata present but the pair
 * no longer hash-matches: a hand edit of the sensorMap, of a mirrored
 * field, or the deletion of the mirrored fields entirely. The hashes
 * are surfaced for diagnosis. Callers must run this whenever the
 * metadata is present, independent of whether any legacy keys remain.
 */
export declare function recognizeMirror(config: Record<string, unknown>): MirrorRecognition;
/**
 * Compose the migration/save payload for the Stage-8 UI save flow. PURE
 * — the caller performs the writes, in this order:
 *
 *   1. If `snapshot` is non-undefined, `writeLegacySnapshot()` it and
 *      AWAIT success BEFORE touching config.json.
 *   2. Persist `nextConfig` through the Homebridge UI config API.
 *
 * `snapshot` carries the legacy sensor fields currently in the config —
 * but ONLY when `currentConfig` is a TRUE legacy-mode config (no
 * `configVersion: 2+`, no `sensorMap`, no mirror metadata). On every
 * subsequent v2 save the legacy fields present are the SYNCHRONIZED
 * MIRROR, not user-authored v1 configuration — snapshotting those would
 * let a deleted snapshot be silently "recreated" from the projection,
 * corrupting the permanent rollback/audit record (review R3-5). For a
 * non-legacy input, `snapshot` is always undefined.
 */
export declare function composeV2ConfigSave(currentConfig: Record<string, unknown>, sensorMap: unknown[], effectiveMap: EffectiveSensorMap): {
    snapshot: Record<string, unknown> | undefined;
    nextConfig: Record<string, unknown>;
};
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
export declare function writeLegacySnapshot(persistDir: string, legacyFields: Record<string, unknown>, log: Logger, clock?: Clock): Promise<'written' | 'exists'>;
//# sourceMappingURL=legacyMirror.d.ts.map
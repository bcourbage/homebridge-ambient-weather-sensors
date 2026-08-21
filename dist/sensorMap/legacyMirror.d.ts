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
import type { LegacyConfig } from './compat.js';
import type { ConfigMode } from './configMode.js';
import type { EffectiveSensorMap } from './types.js';
import { type Clock, type Logger } from './persistence/atomicWrite.js';
/** Metadata key stamped into config.json next to the mirrored fields. */
export declare const LEGACY_MIRROR_KEY = "_legacyMirror";
/** Persist-dir filename of the immutable first-conversion snapshot. */
export declare const LEGACY_SNAPSHOT_FILE = "legacy-config-snapshot.json";
/** Persist-dir DIRECTORY of the append-only conversion journal that
 * records the pre-conversion legacy baseline of every conversion AFTER
 * the first (reconversion following a current-state rollback). One
 * immutable `entry-NNNNNN.json` file per baseline — a directory of
 * exclusive-created files rather than one mutable file, so concurrent
 * writer PROCESSES can never overwrite each other's entries. */
export declare const LEGACY_JOURNAL_DIR = "legacy-conversion-journal";
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
    /**
     * Canonical hash binding BOTH the mirrored legacy fields AND the
     * canonical `sensorMap` at save time — editing either side by hand
     * reads as STALE. See `mirrorHash`.
     */
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
} | {
    state: 'invalid';
    reason: string;
};
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
export declare function composeV2ConfigSave(currentConfig: Record<string, unknown>, sensorMap: unknown[], effectiveMap: EffectiveSensorMap, detectedMode: ConfigMode): {
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
export declare function verifyLegacySnapshot(persistDir: string, authoritativeLegacyFields: Record<string, unknown>): Promise<'absent' | 'match' | 'mismatch' | 'corrupt'>;
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
export declare function journalConversionBaseline(persistDir: string, legacyFields: Record<string, unknown>, log: Logger, clock?: Clock): Promise<'appended' | 'unchanged'>;
//# sourceMappingURL=legacyMirror.d.ts.map
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
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { defaultRowFor } from './defaultMap.js';
import { writeJsonStore, REAL_CLOCK, } from './persistence/atomicWrite.js';
/** Metadata key stamped into config.json next to the mirrored fields. */
export const LEGACY_MIRROR_KEY = '_legacyMirror';
/** Persist-dir filename of the immutable first-conversion snapshot. */
export const LEGACY_SNAPSHOT_FILE = 'legacy-config-snapshot.json';
export const LEGACY_MIRROR_VERSION = 1;
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
];
/**
 * Reverse projection: effective v2 map → sparse v1.7 legacy fields.
 * PURE. See the module header for the contract.
 */
export function projectLegacyMirror(effectiveMap) {
    const known = [];
    const custom = [];
    for (const row of effectiveMap.rows) {
        if (row.kind === 'unrecognized') {
            continue;
        }
        if (defaultRowFor(row.dataPoint)) {
            known.push(row);
        }
        else {
            custom.push(row);
        }
    }
    const mirror = {};
    // ---- Category toggles: ON iff any row of the family is enabled.
    const anyEnabled = (pred) => known.some(r => r.enabled && pred(r));
    mirror.temperatureSensors = anyEnabled(r => r.kind === 'temperature');
    mirror.humiditySensors = anyEnabled(r => r.kind === 'humidity');
    mirror.solarRadiationSensors = anyEnabled(r => r.kind === 'light');
    mirror.co2Sensors = anyEnabled(r => r.kind === 'co2');
    mirror.airQualitySensors = anyEnabled(r => r.kind === 'air-quality-pm25' || r.kind === 'air-quality-pm10');
    const motionFamily = (r) => {
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
    const excludeSensors = [];
    const byDataPoint = new Map();
    for (const r of known) {
        const list = byDataPoint.get(r.dataPoint) ?? [];
        list.push(r);
        byDataPoint.set(r.dataPoint, list);
    }
    const categoryOn = (r) => {
        switch (r.kind) {
            case 'temperature': return mirror.temperatureSensors === true;
            case 'humidity': return mirror.humiditySensors === true;
            case 'light': return mirror.solarRadiationSensors === true;
            case 'co2': return mirror.co2Sensors === true;
            case 'air-quality-pm25':
            case 'air-quality-pm10': return mirror.airQualitySensors === true;
            case 'motion': {
                if (mirror.extendedSensors !== true) {
                    return false;
                }
                switch (motionFamily(r)) {
                    case 'wind': return mirror.windSensors === true;
                    case 'rain': return mirror.rainSensors === true;
                    case 'pressure': return mirror.pressureSensors === true;
                    case 'uv': return mirror.uvSensors === true;
                    case 'lightning': return mirror.lightningSensors === true;
                    default: return false;
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
        }
        else {
            for (const r of disabled) {
                excludeSensors.push(`${r.stationMac}-${dataPoint}`);
            }
        }
    }
    // ---- Custom rows: the explicit downgrade-loss boundary. Exclude by
    //      station-scoped uniqueId AND bare dataPoint so v1.7's broad
    //      includes() matchers can never misclassify one into a wrong
    //      wrapper (on any station, present or future).
    const customDataPoints = new Set();
    for (const r of custom) {
        excludeSensors.push(`${r.stationMac}-${r.dataPoint}`);
        customDataPoints.add(r.dataPoint);
    }
    // While the resolution table is empty (pre-table-restore), custom
    // declarations surface as `no-wrapper` ERRORS instead of rows — cover
    // both sources so the mirror is correct in either state.
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
    const suppressedFields = new Set();
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
    const thresholdFor = (dataPoint) => {
        const rows = (byDataPoint.get(dataPoint) ?? [])
            .filter(r => r.enabled)
            .sort((a, b) => a.stationMac.localeCompare(b.stationMac));
        return rows[0]?.threshold;
    };
    const thresholds = {};
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
    const unitFor = (pred) => {
        const values = new Set();
        for (const r of known) {
            if (r.enabled && pred(r) && 'displayUnit' in r && r.displayUnit !== undefined) {
                values.add(r.displayUnit);
            }
        }
        return values.size === 1 ? [...values][0] : undefined;
    };
    const units = {};
    const windUnit = unitFor(r => r.kind === 'motion' && r.measurement === 'wind-speed');
    if (windUnit && windUnit !== 'mph') {
        units.windSpeed = windUnit;
    }
    // v1.7's units.rain is a single in/mm dropdown covering both
    // accumulation and rate; project rate units down to their base.
    const rainUnit = unitFor(r => r.kind === 'motion' && (r.measurement === 'rain-accumulation' || r.measurement === 'rain-rate'));
    if (rainUnit) {
        const base = rainUnit === 'mm' || rainUnit === 'mm_per_hr' ? 'mm'
            : rainUnit === 'in' || rainUnit === 'in_per_hr' ? 'in'
                : undefined;
        if (base === 'mm') {
            units.rain = base;
        }
    }
    const pressureUnit = unitFor(r => r.kind === 'motion' && r.measurement === 'pressure');
    if (pressureUnit && pressureUnit !== 'inHg') {
        units.pressure = pressureUnit;
    }
    const distanceUnit = unitFor(r => r.kind === 'motion' && r.measurement === 'distance');
    if (distanceUnit && distanceUnit !== 'mi') {
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
export function mirrorHash(config) {
    const subset = {};
    for (const key of LEGACY_SENSOR_FIELDS) {
        if (config[key] !== undefined) {
            subset[key] = config[key];
        }
    }
    const bound = { legacy: subset, sensorMap: config.sensorMap ?? null };
    return createHash('sha256').update(canonicalJson(bound)).digest('hex');
}
function canonicalJson(v) {
    if (Array.isArray(v)) {
        return `[${v.map(canonicalJson).join(',')}]`;
    }
    if (v && typeof v === 'object') {
        const keys = Object.keys(v).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
}
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
export function recognizeMirror(config) {
    const meta = config[LEGACY_MIRROR_KEY];
    if (!meta || typeof meta !== 'object') {
        return { state: 'absent' };
    }
    const m = meta;
    if (m.version !== LEGACY_MIRROR_VERSION || typeof m.hash !== 'string') {
        return { state: 'absent' };
    }
    const actual = mirrorHash(config);
    if (actual === m.hash) {
        return { state: 'recognized' };
    }
    return { state: 'stale', expectedHash: m.hash, actualHash: actual };
}
/**
 * Compose the migration/save payload for the Stage-8 UI save flow. PURE
 * — the caller performs the writes, in this order:
 *
 *   1. If `snapshot` is non-undefined, `writeLegacySnapshot()` it and
 *      AWAIT success BEFORE touching config.json.
 *   2. Persist `nextConfig` through the Homebridge UI config API.
 *
 * `snapshot` carries the legacy sensor fields currently in the config
 * (the ones migration removes) — undefined when none are present (an
 * already-migrated config; the immutable snapshot from the first
 * conversion still exists on disk).
 */
export function composeV2ConfigSave(currentConfig, sensorMap, effectiveMap) {
    const legacyPresent = {};
    let hasLegacy = false;
    for (const key of LEGACY_SENSOR_FIELDS) {
        if (currentConfig[key] !== undefined) {
            legacyPresent[key] = currentConfig[key];
            hasLegacy = true;
        }
    }
    const mirror = projectLegacyMirror(effectiveMap);
    const next = { ...currentConfig };
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
    };
    return { snapshot: hasLegacy ? legacyPresent : undefined, nextConfig: next };
}
/**
 * Write the first-conversion snapshot — IMMUTABLE: if the file already
 * exists it is left untouched and `'exists'` is returned. Contains only
 * `LEGACY_SENSOR_FIELDS` (never API secrets). Uses the atomic
 * persistence helper. Callers MUST await this before mutating
 * config.json.
 */
export async function writeLegacySnapshot(persistDir, legacyFields, log, clock = REAL_CLOCK) {
    const file = path.join(persistDir, LEGACY_SNAPSHOT_FILE);
    try {
        await fs.access(file);
        return 'exists';
    }
    catch {
        // Not present — first conversion.
    }
    const subset = {};
    for (const key of LEGACY_SENSOR_FIELDS) {
        if (legacyFields[key] !== undefined) {
            subset[key] = legacyFields[key];
        }
    }
    await writeJsonStore(file, {
        schemaVersion: 1,
        savedAt: clock.iso(),
        legacy: subset,
    }, log);
    return 'written';
}
//# sourceMappingURL=legacyMirror.js.map
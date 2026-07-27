/**
 * Compat layer — translate a v1.6.0 (legacy) config into synthetic
 * global SensorMapOverride entries, deterministically and one-shot.
 *
 * See docs/future/sensor-map.md §6. The layer's contract:
 *   - Reads a LegacyConfig (whatever fields the user has set)
 *   - Emits a SensorMapOverride[] with `stationMac` absent (all global)
 *   - buildEffectiveSensorMap consumes them like any other override
 *   - Nothing written back to config.json; the projection is
 *     recomputed every boot
 *
 * The layer runs ONLY when configMode === 'legacy' (Stage 5). If the
 * user has a `sensorMap` field defined, v2 mode wins and this layer
 * is skipped entirely.
 *
 * Behavioral invariant: for any 1.6.0 config, the effective map
 * produced by (defaults + compatOverrides) MUST produce the same
 * HAP service graph as v1.6.0's determineSensorType-based pipeline.
 * Tested by the migration-equivalence property tests (§12.7),
 * scheduled for Stage 9.
 */
import { batteryFieldForSensor } from '../batteryFields.js';
import { friendlySensorName, sensorKeyByFriendlyName } from '../sensorNames.js';
import { DEFAULT_SENSOR_MAP } from './defaultMap.js';
// AWN battery field names that can appear directly in excludeSensors
// (form 3 of the `-batt` matchers — see platform.buildSuppressedBatteries).
const BATTERY_FIELD_REGEX = /^(?:battout|battin|batt(?:[1-9]|10)|batt_co2|batt_lightning)$/;
/**
 * Public entry point. Emits synthetic sensor-map overrides from a
 * v1.6.0 legacy config. Result is stable across calls with equal
 * input; safe to cache but cheap enough to recompute each boot.
 *
 * `stations` is the current station inventory (from AWN device list
 * or the accessory cache). If empty, the layer falls back to
 * global-only match forms (`dataPoint`, `friendlyName`) — good enough
 * for boot-before-fetch scenarios but does NOT preserve full v1
 * semantics.
 *
 * Full v1 semantics require the inventory: v1's include/exclude
 * matchers compare against SEVEN candidate forms per accessory —
 * `uniqueId` (`MAC-sensorKey`), current displayName, prefixed form
 * (`hapClean(stationName + friendlyName)`), sensorKey, friendly
 * name, station MAC, station name — and the last five are
 * station-specific. Without stations, entries like
 * `excludeSensors: ["AA:BB:CC:DD:EE:01-tempf"]` or `"Backyard"`
 * would be silently ignored (review finding #2 pre-fix).
 *
 * With inventory, the layer emits station-scoped overrides
 * (`stationMac` set) for every (station, row) pair the include/
 * exclude machinery would have disabled in v1; row-level knobs that
 * don't depend on station (threshold, displayUnit, category
 * toggles, embed mode) still flow through as global overrides.
 */
export function compatToOverrides(legacy, stations = []) {
    const overrides = [];
    const excludeSet = toMatcherSet(legacy.excludeSensors);
    const includeSet = toMatcherSet(legacy.includeOnly);
    const suppressedBatteries = buildSuppressedBatteries(legacy.excludeSensors);
    const hasStations = stations.length > 0;
    for (const row of DEFAULT_SENSOR_MAP) {
        if (!hasStations) {
            // Boot-before-fetch fallback. Preserve the pre-station-aware
            // behavior: include/exclude matching against global forms
            // (sensorKey + friendly name) only. Correct for entries in
            // those forms; incorrect for station-scoped entries, but
            // there's nothing to bind them to yet. Once the platform
            // hands us an inventory on the next tick, we take the branch
            // below and get full v1 parity.
            const ov = compatRowOverride(row, legacy, excludeSet, includeSet, suppressedBatteries);
            if (ov) {
                overrides.push(ov);
            }
            continue;
        }
        // Step 1: global-scope projection — category enable, threshold,
        // displayUnit, embed, battery suppression. Include/exclude are
        // handled per-station below and MUST be excluded here so a
        // station-scoped-only match (like `MAC-tempf`) doesn't get
        // promoted into a global disable that hides the row on
        // stations where the user actually wanted it kept.
        const globalOv = compatRowOverride(row, legacy, EMPTY_SET, EMPTY_SET, suppressedBatteries);
        if (globalOv) {
            overrides.push(globalOv);
        }
        // Step 2: station-scoped include/exclude. Skip if the row is
        // already globally disabled by category/threshold — no accessory
        // left to further scope down.
        if (globalOv && globalOv.enabled === false) {
            continue;
        }
        if (excludeSet.size === 0 && includeSet.size === 0) {
            continue;
        }
        // For each (station, row) pair, build the full seven-candidate
        // match list and re-evaluate. Emit a station-scoped `enabled:
        // false` override for anything v1 would have dropped.
        for (const station of stations) {
            if (shouldStationScopeDisable(row, station, excludeSet, includeSet)) {
                overrides.push({
                    dataPoint: row.dataPoint,
                    stationMac: station.macAddress.toUpperCase(),
                    enabled: false,
                });
            }
        }
    }
    return overrides;
}
// Sentinel for the with-stations branch — passed to compatRowOverride
// to bypass its global-form include/exclude logic (which per-station
// evaluation below replaces).
const EMPTY_SET = new Set();
// ---- Per-row projection --------------------------------------------
function compatRowOverride(row, legacy, excludeSet, includeSet, suppressedBatteries) {
    const parts = { dataPoint: row.dataPoint };
    let touched = false;
    // ---- Category-toggle → enabled.
    const catEnabled = isCategoryEnabled(row, legacy);
    if (!catEnabled) {
        parts.enabled = false;
        touched = true;
    }
    // ---- Extended per-threshold enable checkboxes.
    const perThresholdEnabled = isPerThresholdEnabled(row, legacy);
    if (!perThresholdEnabled) {
        parts.enabled = false;
        touched = true;
    }
    // ---- Threshold value.
    const threshold = thresholdFor(row, legacy);
    if (threshold !== undefined) {
        parts.threshold = threshold;
        touched = true;
    }
    // ---- Display unit.
    const displayUnit = displayUnitFor(row, legacy);
    if (displayUnit !== undefined) {
        parts.displayUnit = displayUnit;
        touched = true;
    }
    // ---- Embed mode (motion kinds only).
    if (row.kind === 'motion' && legacy.extendedDisplayMode === 'embed') {
        parts.embedName = true;
        touched = true;
    }
    // ---- Exclude / include lists.
    if (isExcluded(row, excludeSet)) {
        parts.enabled = false;
        touched = true;
    }
    if (includeSet.size > 0 && !isIncluded(row, includeSet)) {
        parts.enabled = false;
        touched = true;
    }
    // ---- -batt suffix or raw battery-field name → suppress battery.
    if (row.batteryField && suppressedBatteries.has(row.batteryField)) {
        parts.batteryField = null;
        touched = true;
    }
    return touched ? parts : undefined;
}
// ---- Category / sub-toggle logic -----------------------------------
function isCategoryEnabled(row, legacy) {
    // Value-tile kinds map 1:1 to a top-level toggle.
    switch (row.kind) {
        case 'temperature':
            return legacy.temperatureSensors === true;
        case 'humidity':
            return legacy.humiditySensors === true;
        case 'light':
            return legacy.solarRadiationSensors === true;
        case 'co2':
            return legacy.co2Sensors === true;
        case 'air-quality-pm25':
        case 'air-quality-pm10':
            return legacy.airQualitySensors === true;
        default:
            break;
    }
    // Motion kinds — gated by master extendedSensors + measurement-family sub-toggle.
    if (row.kind === 'motion') {
        if (legacy.extendedSensors !== true) {
            return false;
        }
        switch (row.measurement) {
            case 'wind-speed':
            case 'direction':
                return legacy.windSensors === true;
            case 'rain-rate':
            case 'rain-accumulation':
                return legacy.rainSensors === true;
            case 'pressure':
                return legacy.pressureSensors === true;
            case 'uv-index':
                return legacy.uvSensors === true;
            case 'count':
            case 'distance':
                return legacy.lightningSensors === true;
            case 'timestamp':
                // Only two timestamp rows exist: `lastRain` (rain family) and
                // `lightning_time` (lightning family).
                if (row.dataPoint === 'lastRain') {
                    return legacy.rainSensors === true;
                }
                if (row.dataPoint === 'lightning_time') {
                    return legacy.lightningSensors === true;
                }
                return false;
            default:
                return false;
        }
    }
    // Kinds without a legacy toggle: co, leak, contact, occupancy —
    // none appear in DEFAULT_SENSOR_MAP today; belt-and-suspenders false.
    return false;
}
/**
 * The v1.6.0 form has per-threshold enable checkboxes. Missing key
 * defaults to true (matches v1.6.0's `enabled = v !== false` semantics).
 */
function isPerThresholdEnabled(row, legacy) {
    const t = legacy.thresholds ?? {};
    const enabled = (v) => v !== false;
    switch (row.dataPoint) {
        case 'windspeedmph': return enabled(t.windSpeedEnabled);
        case 'windgustmph': // Wind Gust and Max Daily Gust share windGustEnabled.
        case 'maxdailygust': return enabled(t.windGustEnabled);
        case 'hourlyrainin': return enabled(t.rainRateEnabled);
        case 'uv': return enabled(t.uvEnabled);
        case 'lightning_distance': return enabled(t.lightningDistanceEnabled);
        case 'baromrelin': // Both pressure accessories share pressureEnabled.
        case 'baromabsin': return enabled(t.pressureEnabled);
        default: return true;
    }
}
function thresholdFor(row, legacy) {
    const t = legacy.thresholds ?? {};
    switch (row.dataPoint) {
        case 'windspeedmph': return t.windSpeedMph;
        case 'windgustmph':
        case 'maxdailygust': return t.windGustMph;
        case 'hourlyrainin': return t.rainRateInHr;
        case 'uv': return t.uv;
        case 'lightning_distance': return t.lightningDistanceMi;
        case 'baromrelin':
        case 'baromabsin': return t.pressureInHg;
        default: return undefined;
    }
}
function displayUnitFor(row, legacy) {
    const u = legacy.units ?? {};
    const m = row.measurement;
    if (m === 'wind-speed' && u.windSpeed && u.windSpeed !== row.displayUnit) {
        return u.windSpeed;
    }
    if ((m === 'rain-rate' || m === 'rain-accumulation') && u.rain) {
        // `units.rain` in v1.6.0 was a single dropdown implying inches vs.
        // millimeters. Map 'in' → 'in' for accumulation, 'in_per_hr' for
        // rate; 'mm' → 'mm' for accumulation, 'mm_per_hr' for rate.
        if (m === 'rain-accumulation') {
            if (u.rain === 'in' || u.rain === 'mm') {
                return u.rain === row.displayUnit ? undefined : u.rain;
            }
        }
        else {
            if (u.rain === 'in') {
                return row.displayUnit === 'in_per_hr' ? undefined : 'in_per_hr';
            }
            if (u.rain === 'mm') {
                return row.displayUnit === 'mm_per_hr' ? undefined : 'mm_per_hr';
            }
        }
    }
    if (m === 'pressure' && u.pressure && u.pressure !== row.displayUnit) {
        return u.pressure;
    }
    if (m === 'distance' && u.distance && u.distance !== row.displayUnit) {
        return u.distance;
    }
    return undefined;
}
// ---- Exclude / include matchers ------------------------------------
function normalizeMatchKey(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : '';
}
function toMatcherSet(raw) {
    const out = new Set();
    if (!Array.isArray(raw)) {
        return out;
    }
    for (const entry of raw) {
        const k = normalizeMatchKey(entry);
        if (k.length > 0) {
            out.add(k);
        }
    }
    return out;
}
/**
 * Row matches an exclude/include set if any of its match forms
 * (sensorKey, friendly name) is present. Anything with a `-batt`
 * suffix or raw battery-field-name form is handled by the battery
 * suppression path, not here — those entries won't match a sensor
 * accessory.
 */
function isExcluded(row, excludeSet) {
    if (excludeSet.size === 0) {
        return false;
    }
    return matchesRow(row, excludeSet);
}
function isIncluded(row, includeSet) {
    return matchesRow(row, includeSet);
}
function matchesRow(row, matchers) {
    const forms = [row.dataPoint, friendlySensorName(row.dataPoint)].map(normalizeMatchKey);
    for (const f of forms) {
        if (f && matchers.has(f)) {
            return true;
        }
    }
    return false;
}
/**
 * Compat-side mirror of the v1 hapClean function (`src/platform.ts`).
 * Kept inline instead of imported so this module has no dependency
 * back into platform.ts, which imports from other sensor-map modules
 * — a cycle we don't want. If either implementation changes, the
 * migration-equivalence test suite will catch drift.
 */
function hapCleanCompat(input) {
    return input
        .replace(/[^A-Za-z0-9 ']/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[^A-Za-z0-9]+/, '')
        .replace(/[^A-Za-z0-9]+$/, '')
        .trim();
}
/**
 * Full v1 match-form list for a (row, station) pair — the same seven
 * candidates `platform.ts:661` builds at accessory-decision time.
 * Every candidate is normalized (trimmed + lowercased) so the caller
 * can do plain set membership checks.
 */
function stationScopedMatchForms(row, station) {
    const sensorKey = row.dataPoint;
    const friendly = friendlySensorName(sensorKey);
    const stationName = station.name;
    const prefixedForm = stationName ? hapCleanCompat(`${stationName} ${friendly}`) : '';
    const uniqueId = `${station.macAddress}-${sensorKey}`;
    // v1 also checks the current `displayName`, which is either the
    // clean short form (single-station setups) or the prefixed form
    // (multi-station). We approximate the multi-station displayName
    // with `prefixedForm` — same source recipe — and the single-station
    // short form with `friendly`. Users targeting the current display
    // name will therefore hit either the `friendly` or `prefixedForm`
    // candidate, both of which are already in the list.
    return [
        uniqueId,
        prefixedForm,
        sensorKey,
        friendly,
        station.macAddress,
        stationName,
    ].map(normalizeMatchKey).filter((s) => s.length > 0);
}
/**
 * True iff the (row, station) pair should be disabled by v1's
 * include/exclude semantics — mirrored from `platform.ts:671-692`.
 * Include-only (if non-empty) requires at least one match against
 * the full candidate list; exclude drops the pair on any match.
 * A pair that both included and excluded is dropped, matching v1.
 */
function shouldStationScopeDisable(row, station, excludeSet, includeSet) {
    const forms = stationScopedMatchForms(row, station);
    if (includeSet.size > 0 && !forms.some((c) => includeSet.has(c))) {
        return true;
    }
    if (excludeSet.size > 0 && forms.some((c) => excludeSet.has(c))) {
        return true;
    }
    return false;
}
/**
 * Resolve `-batt` suffix + raw battery-field entries from excludeSensors
 * into a set of battery field names to suppress. Mirrors the runtime
 * logic in platform.buildSuppressedBatteries so compat produces the
 * same effect.
 */
function buildSuppressedBatteries(excludeRaw) {
    const suppressed = new Set();
    if (!Array.isArray(excludeRaw)) {
        return suppressed;
    }
    for (const rawEntry of excludeRaw) {
        if (typeof rawEntry !== 'string') {
            continue;
        }
        const normalized = rawEntry.trim().toLowerCase();
        if (normalized.length === 0) {
            continue;
        }
        if (BATTERY_FIELD_REGEX.test(normalized)) {
            suppressed.add(normalized);
            continue;
        }
        if (normalized.endsWith('-batt')) {
            const stem = normalized.slice(0, -'-batt'.length).trim();
            let field = batteryFieldForSensor(stem);
            if (!field) {
                const key = sensorKeyByFriendlyName(stem);
                if (key) {
                    field = batteryFieldForSensor(key);
                }
            }
            if (field) {
                suppressed.add(field);
            }
        }
    }
    return suppressed;
}
//# sourceMappingURL=compat.js.map
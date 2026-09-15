/**
 * Station/sensor matcher normalization — the ONE implementation the
 * runtime (stationFilter, excludeSensors, includeOnly) and the
 * editor's save pipeline share, so a station the runtime would filter
 * is filtered identically when the preview computes consequences
 * (PR #60 review F1). Extracted from platform.ts at beta.17;
 * platform.ts re-exports for compatibility.
 */
import type { StationInventory } from './types.js';

/**
 * Normalize a config-supplied string for matching against sensor
 * identifiers. Trims whitespace and lowercases. Empty / non-string
 * values normalize to the empty string, which the caller is expected
 * to filter out.
 */
export function normalizeMatchKey(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/**
 * Build a Set of normalized matchers from a config-supplied array.
 * Used for `stationFilter`, `excludeSensors`, and `includeOnly`; the
 * same matching rules apply to all (case-insensitive,
 * whitespace-trimmed, non-string and blank entries dropped).
 */
export function toMatcherSet(raw: unknown): Set<string> {
  const out = new Set<string>();
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
 * Apply a stationFilter to a station INVENTORY with the runtime's
 * matching rules (station name OR MAC, case-insensitive,
 * whitespace-trimmed). An empty or absent filter passes everything —
 * exactly applyStationFilterV2's semantics, minus the logging.
 */
export function filterStationInventory(inventory: StationInventory, stationFilter: unknown): StationInventory {
  const matchers = toMatcherSet(stationFilter);
  if (matchers.size === 0) {
    return inventory;
  }
  return inventory.filter(s =>
    (normalizeMatchKey(s.name).length > 0 && matchers.has(normalizeMatchKey(s.name)))
    || (normalizeMatchKey(s.macAddress).length > 0 && matchers.has(normalizeMatchKey(s.macAddress))));
}

/** MAC-shaped matcher entry (the always-determinate filter form). */
const MAC_FORM = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/**
 * Stations whose membership under `stationFilter` is INDETERMINATE at
 * editor time (PR #60 round 3 P1): the filter carries name-form
 * entries, and the station's name is unknown in the assembled
 * inventory (cached-accessory or override-derived stations carry no
 * name) — the runtime will evaluate the same filter AFTER fetching,
 * with the real name. Interpreting the unknown name as a non-match
 * could hide structural consequences from the preview, so callers
 * refuse instead. A station a MAC-form entry matches is determinate
 * (included) regardless of its name; a filter with only MAC-form
 * entries is always determinate.
 */
export function indeterminateFilterStations(inventory: StationInventory, stationFilter: unknown): StationInventory {
  const matchers = toMatcherSet(stationFilter);
  if (matchers.size === 0) {
    return [];
  }
  const hasNameForm = [...matchers].some(m => !MAC_FORM.test(m));
  if (!hasNameForm) {
    return [];
  }
  return inventory.filter(s =>
    normalizeMatchKey(s.name).length === 0
    && !matchers.has(normalizeMatchKey(s.macAddress)));
}

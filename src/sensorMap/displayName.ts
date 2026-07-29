/**
 * HAP display-name utilities — shared by the v1.6.0 code path
 * (`platform.parseDevices` / `platform.composeDisplayName`) and the
 * compat layer (`compatToOverrides`).
 *
 * Extracted so v1 and v2's include/exclude machinery agree on
 * EXACTLY the same displayName string when matching user config
 * entries. Any drift here silently breaks user filters after
 * migration — see review finding #2 (P0).
 *
 * The three concerns:
 *
 *   - `hapClean`     — HAP 2.x's Name-characteristic sanitizer
 *                      (alphanumeric + space + apostrophe, must
 *                      start/end alphanumeric).
 *   - `HAP_NAME_MAX` — HAP 2.x's 64-char truncation limit for the
 *                      Name characteristic.
 *   - `composeDisplayName` — v1's full recipe: single-station keeps
 *                      the bare sensor label; multi-station prefixes
 *                      with the station name (or the colon-stripped
 *                      MAC if the station has no name) and truncates
 *                      to `HAP_NAME_MAX` from the right.
 */

import { friendlySensorName } from '../sensorNames.js';

/** HAP 2.x Name-characteristic sanitizer. */
export function hapClean(input: string): string {
  return input
    .replace(/[^A-Za-z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .trim();
}

/** HAP 2.x Name-characteristic max length. */
export const HAP_NAME_MAX = 64;

/**
 * Compute the HAP accessory displayName for a (station, dataPoint)
 * pair using v1's recipe. Match forms include this in v1's
 * seven-candidate exclude/include list, so compat must be able to
 * reproduce it byte-for-byte for migration parity.
 */
export function composeDisplayName(
  station: { macAddress: string; name: string },
  sensorKey: string,
  isMultiStation: boolean,
): string {
  return composeRowDisplayName(station, friendlySensorName(sensorKey), isMultiStation);
}

/**
 * Row-driven variant (finding-#4 Stage 4, review P1-1): identical
 * station-prefix / MAC-fallback / truncation recipe, but the sensor
 * label comes from the effective row's `name` instead of the static
 * `friendlySensorName` table — so a user's `{ dataPoint: "tempf",
 * name: "Patio" }` override actually renames the accessory tile, and
 * the platform displayName agrees with the extended wrappers' service
 * labels (which already read `row.name`).
 *
 * For every DEFAULT_SENSOR_MAP row, `hapClean(row.name)` equals
 * `hapClean(friendlySensorName(row.dataPoint))` — asserted by a parity
 * test — so flag-on with no rename override produces byte-identical
 * display names to the v1.7 recipe (no rename storm on upgrade).
 */
export function composeRowDisplayName(
  station: { macAddress: string; name: string },
  rowName: string,
  isMultiStation: boolean,
): string {
  // Defense-in-depth (review R3-6): validation already warn-strips name
  // overrides that sanitize to empty, but this is the last HAP sink —
  // never emit an empty or over-length Name regardless of input. The
  // 'Sensor' fallback is unreachable through validated rows; it guards
  // direct callers.
  const label = hapClean(rowName) || 'Sensor';
  if (!isMultiStation) {
    return truncateHapName(label);
  }
  const stationName = hapClean(station.name);
  const macFallback = station.macAddress.replaceAll(':', '');
  const baseName = stationName || macFallback;
  return truncateHapName(hapClean(`${baseName} ${label}`));
}

/**
 * Right-truncate to HAP 2.x's 64-char (UTF-16 code unit) Name limit.
 * Exported (review R4-2) so EVERY HAP string sink shares the one policy
 * — the extended sensors' service names (`composeStaticName` /
 * `composeEmbeddedName`) and the `AccessoryInformation.Model`
 * assignment, not just the accessory displayName. Deliberately does NOT
 * sanitize: Model keeps characters like parentheses that tile names
 * strip.
 *
 * R5-2 hardening: leading/trailing whitespace is trimmed BEFORE
 * truncation (70 spaces + a name previously truncated to all-spaces →
 * empty), and the cut is code-point-aware — a naive UTF-16 slice at the
 * limit can split a surrogate pair and leave an unpaired high surrogate
 * at an emoji boundary. The result always fits the 64-code-unit limit.
 */
export function truncateHapName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= HAP_NAME_MAX) {
    return trimmed;
  }
  let cut = trimmed.slice(0, HAP_NAME_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    // Unpaired high surrogate: the slice split a code point. Drop it.
    cut = cut.slice(0, -1);
  }
  return cut.trim();
}

/**
 * Normalize a string for HAP's `AccessoryInformation.Model`
 * characteristic (review R5-2). Model shares the 64-unit ceiling but
 * ALSO has a floor: HAP-NodeJS rejects values shorter than 2 characters
 * and silently keeps "Default-Model". Validation accepts a
 * one-character row name ("X") — legal as a tile name — so the Model
 * sink needs its own fallback chain: the truncated label if it still
 * has ≥ 2 characters, else the fallback (the row's dataPoint / AWN key,
 * always ≥ 2 in the AWN vocabulary), else a generic constant. Never
 * sanitized — parentheses etc. are Model-legal.
 */
export function hapModelValue(label: string, fallback: string): string {
  const primary = truncateHapName(label);
  if (primary.length >= 2) {
    return primary;
  }
  const secondary = truncateHapName(fallback);
  return secondary.length >= 2 ? secondary : 'Ambient Weather Sensor';
}

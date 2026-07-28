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
/** HAP 2.x Name-characteristic sanitizer. */
export declare function hapClean(input: string): string;
/** HAP 2.x Name-characteristic max length. */
export declare const HAP_NAME_MAX = 64;
/**
 * Compute the HAP accessory displayName for a (station, dataPoint)
 * pair using v1's recipe. Match forms include this in v1's
 * seven-candidate exclude/include list, so compat must be able to
 * reproduce it byte-for-byte for migration parity.
 */
export declare function composeDisplayName(station: {
    macAddress: string;
    name: string;
}, sensorKey: string, isMultiStation: boolean): string;
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
export declare function composeRowDisplayName(station: {
    macAddress: string;
    name: string;
}, rowName: string, isMultiStation: boolean): string;
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
export declare function truncateHapName(name: string): string;
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
export declare function hapModelValue(label: string, fallback: string): string;
//# sourceMappingURL=displayName.d.ts.map
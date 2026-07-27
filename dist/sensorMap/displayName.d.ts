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
//# sourceMappingURL=displayName.d.ts.map
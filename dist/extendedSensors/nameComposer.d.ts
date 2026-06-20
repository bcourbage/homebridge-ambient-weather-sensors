/**
 * Tile-name composition for extended sensors. Apple Home displays the
 * `ConfiguredName` characteristic as the tile label; in "static"
 * display mode we set it to a fixed sensor name (e.g. "Wind Speed")
 * and never update it, while in "embed" mode we append the live
 * value (e.g. "Wind Speed 14 mph") and refresh it on every reading.
 *
 * HAP 2.x's Name validator rejects characters outside a fairly tight
 * set — alphanumeric, space, apostrophe, hyphen, and period are
 * generally safe; colons, modifier letters, and most punctuation
 * trigger a Homebridge log warning. The `sanitizeForTileName` helper
 * collapses anything outside the safe set so the embed mode produces
 * a name the validator accepts without complaint.
 *
 * The rhockenbury Ecowitt plugin uses the modifier triangular colon
 * "ː" (U+02D0) in its embedded labels ("Wind Speedː 12.3 mph"), which
 * is what surfaces the warnings in their issues #82 and #88. We
 * deliberately avoid that by using a plain space as the separator.
 */
/**
 * Run a string through Apple Home's naming-rule sanitizer. Collapses
 * any disallowed character to a space and squashes runs of
 * whitespace into a single space. Preserves capitalization.
 */
export declare function sanitizeForTileName(input: string): string;
/**
 * Compose a tile name in "static" mode — the sensor label, sanitized.
 * No value is appended; the user gets a stable tile they can rename
 * in Apple Home without it being overwritten.
 */
export declare function composeStaticName(sensorLabel: string): string;
/**
 * Compose a tile name in "embed" mode — sensor label + sanitized
 * value. The value string typically includes a unit (e.g. "14 mph",
 * "0.12 in/hr"); the sanitizer will pass alphanumerics + spaces +
 * period through unchanged but strip any exotic punctuation.
 *
 * Output examples:
 *   composeEmbeddedName("Wind Speed", "14 mph")        → "Wind Speed 14 mph"
 *   composeEmbeddedName("Wind Direction", "315° (NW)") → "Wind Direction 315 NW"
 *   composeEmbeddedName("Rain Rate", "0.12 in/hr")     → "Rain Rate 0.12 in hr"
 *
 * Note the third example: the slash in "in/hr" is dropped (it's
 * outside the safe set). That's a deliberate trade-off — keeping
 * the slash would trigger a HAP Name validator warning. Users who
 * want the exact "0.12 in/hr" rendering should use Eve or Controller
 * for HomeKit, which read the `Value` characteristic directly and
 * aren't constrained by tile-name validation.
 */
export declare function composeEmbeddedName(sensorLabel: string, valueStr: string): string;
/**
 * Detect whether the user has manually renamed the tile in Apple
 * Home since we last set the name. Used by embed-mode updates to
 * stop overwriting a user customization.
 *
 * "User renamed" = the current ConfiguredName on the service differs
 * from the last value we wrote. Empty / undefined `currentName`
 * means HAP hasn't reported back yet (likely just after a restart)
 * — treat as not-renamed so the first update can proceed.
 */
export declare function isUserRenamed(currentName: string | undefined, lastSetName: string | undefined): boolean;
//# sourceMappingURL=nameComposer.d.ts.map
export declare function friendlySensorName(key: string): string;
/**
 * Inverse of `friendlySensorName`: map a friendly-name string back to
 * its AWN sensorKey. Used by the platform layer to resolve user-typed
 * config entries like `"Lightning Strikes Today-batt"` into the
 * corresponding battery field via `batteryFieldForSensor()`.
 *
 * Matching is case-insensitive and whitespace-trimmed, same as the
 * forward-direction matchers in parseDevices. Returns undefined when
 * the friendly name doesn't correspond to any known sensor — caller
 * should treat that as "user typed something we don't recognize" and
 * fall through to whatever default behavior fits.
 *
 * Also handles the numbered-probe friendly-name patterns
 * (`Temperature 3`, `Humidity 2`, `Feels Like 1`, `Dew Point 4`) by
 * reconstructing the corresponding numbered sensorKey.
 */
export declare function sensorKeyByFriendlyName(friendly: string): string | undefined;
//# sourceMappingURL=sensorNames.d.ts.map
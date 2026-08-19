/**
 * Unit conversion helpers for the extended-sensor accessories.
 *
 * AWN reports US/imperial units regardless of station location:
 *   wind:    mph
 *   rain:    inches (and inches/hour for rate)
 *   pressure: inHg
 *   distance: miles (lightning_distance)
 *
 * Users in metric-using regions can configure a different display
 * unit; conversions happen at the per-sensor formatter layer.
 *
 * Thresholds are NOT display-unit values: v2 thresholds are stored in
 * the row's `sourceUnit`, and the wrapper base converts BOTH the raw
 * reading and the threshold to the family's canonical unit before
 * comparing. `displayUnit` is presentation-only (it affects the
 * formatted Value string, never trigger behavior). The v1 legacy
 * threshold knobs are AWN-native by construction — their config field
 * names carry the unit (windSpeedMph, pressureInHg, rainRateInHr).
 */
/**
 * Exact feet-per-second per mile-per-hour: 5280 ft / 3600 s = 22/15.
 * MUST stay the exact ratio — a rounded constant (1.46667) lands
 * canonical values just below exact Beaufort boundaries (22/15 ft/sec
 * is exactly 1 mph = 'Light air'; rounded, it converts to 0.9999977
 * mph = 'Calm'). Shared by both conversion layers.
 */
export const FPS_PER_MPH = 22 / 15;
export function convertSpeed(mph, target) {
    switch (target) {
        case 'mph': return mph;
        case 'fps': return mph * FPS_PER_MPH;
        case 'kph': return mph * 1.60934;
        case 'mps': return mph * 0.44704;
        case 'kts': return mph * 0.86898;
    }
}
export function convertRain(inches, target) {
    return target === 'mm' ? inches * 25.4 : inches;
}
export function convertPressure(inHg, target) {
    switch (target) {
        case 'inHg': return inHg;
        case 'mmHg': return inHg * 25.4; // mmHg = inHg * 25.4; inHg = mmHg / 25.4
        case 'hPa': return inHg * 33.8639;
    }
}
export function convertDistance(miles, target) {
    switch (target) {
        case 'mi': return miles;
        case 'km': return miles * 1.60934;
        case 'nm': return miles * 0.868976; // 1 statute mile = 0.868976 nautical miles
    }
}
//# sourceMappingURL=unitConversions.js.map
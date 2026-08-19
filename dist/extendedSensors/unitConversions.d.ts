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
export declare const FPS_PER_MPH: number;
export type SpeedUnit = 'mph' | 'fps' | 'kph' | 'mps' | 'kts';
export type RainUnit = 'in' | 'mm';
export type PressureUnit = 'inHg' | 'mmHg' | 'hPa';
export type DistanceUnit = 'mi' | 'km' | 'nm';
export declare function convertSpeed(mph: number, target: SpeedUnit): number;
export declare function convertRain(inches: number, target: RainUnit): number;
export declare function convertPressure(inHg: number, target: PressureUnit): number;
export declare function convertDistance(miles: number, target: DistanceUnit): number;
//# sourceMappingURL=unitConversions.d.ts.map
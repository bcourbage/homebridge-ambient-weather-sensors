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
 * unit; conversions happen at the per-sensor formatter layer, with
 * thresholds always interpreted in the *display* unit so a "wind
 * speed threshold of 25" means 25 of whatever the user picked.
 */
export type SpeedUnit = 'mph' | 'kph' | 'mps' | 'kts';
export type RainUnit = 'in' | 'mm';
export type PressureUnit = 'inHg' | 'hPa';
export type DistanceUnit = 'mi' | 'km' | 'nm';
export declare function convertSpeed(mph: number, target: SpeedUnit): number;
export declare function convertRain(inches: number, target: RainUnit): number;
export declare function convertPressure(inHg: number, target: PressureUnit): number;
export declare function convertDistance(miles: number, target: DistanceUnit): number;
//# sourceMappingURL=unitConversions.d.ts.map
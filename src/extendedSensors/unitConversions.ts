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
export type DistanceUnit = 'mi' | 'km';

export function convertSpeed(mph: number, target: SpeedUnit): number {
  switch (target) {
    case 'mph': return mph;
    case 'kph': return mph * 1.60934;
    case 'mps': return mph * 0.44704;
    case 'kts': return mph * 0.86898;
  }
}

export function convertRain(inches: number, target: RainUnit): number {
  return target === 'mm' ? inches * 25.4 : inches;
}

export function convertPressure(inHg: number, target: PressureUnit): number {
  return target === 'hPa' ? inHg * 33.8639 : inHg;
}

export function convertDistance(miles: number, target: DistanceUnit): number {
  return target === 'km' ? miles * 1.60934 : miles;
}

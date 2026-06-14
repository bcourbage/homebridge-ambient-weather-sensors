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
export function convertSpeed(mph, target) {
    switch (target) {
        case 'mph': return mph;
        case 'kph': return mph * 1.60934;
        case 'mps': return mph * 0.44704;
        case 'kts': return mph * 0.86898;
    }
}
export function convertRain(inches, target) {
    return target === 'mm' ? inches * 25.4 : inches;
}
export function convertPressure(inHg, target) {
    return target === 'hPa' ? inHg * 33.8639 : inHg;
}
export function convertDistance(miles, target) {
    switch (target) {
        case 'mi': return miles;
        case 'km': return miles * 1.60934;
        case 'nm': return miles * 0.868976; // 1 statute mile = 0.868976 nautical miles
    }
}
//# sourceMappingURL=unitConversions.js.map
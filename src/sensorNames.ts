/**
 * Friendly display names for the raw sensor keys returned in the AWN API
 * `lastData` object. Keys not listed here fall back to either:
 *   - a `Temperature N` / `Humidity N` form for the numbered extra-probe
 *     keys (temp1f..temp10f, humidity1..humidity10), or
 *   - the raw key, so unknown sensors still surface with *some* name.
 */
const friendlyNames: Record<string, string> = {
  tempf: 'Outdoor Temperature',
  tempinf: 'Indoor Temperature',
  humidity: 'Outdoor Humidity',
  humidityin: 'Indoor Humidity',
  solarradiation: 'Solar Radiation',
};

const numberedSensorRegex = /^(temp|humidity)(\d+)f?$/;

export function friendlySensorName(key: string): string {
  if (friendlyNames[key]) {
    return friendlyNames[key];
  }
  const match = key.match(numberedSensorRegex);
  if (match) {
    const [, kind, num] = match;
    if (kind === 'temp') {
      return `Temperature ${num}`;
    }
    if (kind === 'humidity') {
      return `Humidity ${num}`;
    }
  }
  return key;
}

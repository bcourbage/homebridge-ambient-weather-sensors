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
  // CO2 — AWN exposes the standalone "co2" field and the AQIN family.
  co2: 'CO2',
  co2_in: 'Indoor CO2',
  co2_in_aqin: 'Indoor CO2',
  co2_in_24h_aqin: 'Indoor CO2 24h Average',
  // PM2.5 — outdoor uses "pm25"; indoor AQIN uses "pm25_in_aqin".
  pm25: 'Outdoor PM2.5',
  pm25_24h: 'Outdoor PM2.5 24h Average',
  pm25_in: 'Indoor PM2.5',
  pm25_in_aqin: 'Indoor PM2.5',
  pm25_in_24h_aqin: 'Indoor PM2.5 24h Average',
  // PM10 — AQIN only as of this writing.
  pm10_in_aqin: 'Indoor PM10',
  pm10_in_24h_aqin: 'Indoor PM10 24h Average',
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

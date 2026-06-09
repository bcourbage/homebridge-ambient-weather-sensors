/**
 * Friendly display names for the raw sensor keys returned in the AWN API
 * `lastData` object. Keys not listed here fall back to either:
 *   - a `Temperature N` / `Humidity N` / `Feels Like N` / `Dew Point N`
 *     form for the numbered extra-probe keys
 *     (temp1f..temp10f, humidity1..humidity10, feelsLike1..4, dewPoint1..4),
 *     or
 *   - the raw key, so unknown sensors still surface with *some* name.
 */
const friendlyNames: Record<string, string> = {
  tempf: 'Outdoor Temperature',
  tempinf: 'Indoor Temperature',
  humidity: 'Outdoor Humidity',
  humidityin: 'Indoor Humidity',
  solarradiation: 'Solar Radiation',
  // Feels-like (heat index / wind chill) — AWN pre-calculates per probe.
  feelsLike: 'Outdoor Feels Like',
  feelsLikein: 'Indoor Feels Like',
  // Dew point — AWN pre-calculates per probe.
  dewPoint: 'Outdoor Dew Point',
  dewPointin: 'Indoor Dew Point',
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
  // Extended sensors (v1.5.0) — non-native HomeKit types exposed via
  // MotionSensor + custom characteristics.
  windspeedmph: 'Wind Speed',
  windgustmph: 'Wind Gust',
  maxdailygust: 'Max Daily Gust',
  winddir: 'Wind Direction',
  winddir_avg10m: 'Wind Direction 10m Avg',
  hourlyrainin: 'Rain Rate',
  eventrainin: 'Rain Event',
  dailyrainin: 'Rain Daily',
  weeklyrainin: 'Rain Weekly',
  monthlyrainin: 'Rain Monthly',
  yearlyrainin: 'Rain Yearly',
  lastRain: 'Last Rain',
  baromrelin: 'Pressure Sea Level',
  baromabsin: 'Pressure Station',
  uv: 'UV Index',
  lightning_day: 'Lightning Strikes Today',
  lightning_hour: 'Lightning Strikes This Hour',
  lightning_distance: 'Lightning Distance',
  lightning_time: 'Last Lightning Strike',
};

const numberedSensorRegex = /^(temp|humidity|feelsLike|dewPoint)(\d+)f?$/;

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
    if (kind === 'feelsLike') {
      return `Feels Like ${num}`;
    }
    if (kind === 'dewPoint') {
      return `Dew Point ${num}`;
    }
  }
  return key;
}

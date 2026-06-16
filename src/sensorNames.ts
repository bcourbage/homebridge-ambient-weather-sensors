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
  // AQIN module's own internal temperature/humidity sensors — useful
  // for sensor drift detection. Distinct from the room indoor sensors.
  pm_in_temp_aqin: 'AQIN Temperature',
  pm_in_humidity_aqin: 'AQIN Humidity',
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
export function sensorKeyByFriendlyName(friendly: string): string | undefined {
  const normalized = friendly.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  for (const [key, name] of Object.entries(friendlyNames)) {
    if (name.toLowerCase() === normalized) {
      return key;
    }
  }
  // Numbered probes: "temperature 3" → "temp3f", "humidity 2" → "humidity2", etc.
  const numMatch = normalized.match(/^(temperature|humidity|feels like|dew point)\s+(\d+)$/);
  if (numMatch) {
    const [, kind, num] = numMatch;
    if (kind === 'temperature') {
      return `temp${num}f`;
    }
    if (kind === 'humidity') {
      return `humidity${num}`;
    }
    if (kind === 'feels like') {
      return `feelsLike${num}`;
    }
    if (kind === 'dew point') {
      return `dewPoint${num}`;
    }
  }
  return undefined;
}

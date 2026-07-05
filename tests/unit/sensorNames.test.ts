import { describe, expect, it } from 'vitest';

import { friendlySensorName, sensorKeyByFriendlyName } from '../../src/sensorNames';

describe('friendlySensorName', () => {
  describe('exact-match lookups', () => {
    it.each([
      ['tempf', 'Outdoor Temperature'],
      ['tempinf', 'Indoor Temperature'],
      ['humidity', 'Outdoor Humidity'],
      ['humidityin', 'Indoor Humidity'],
      ['solarradiation', 'Solar Radiation'],
      ['feelsLike', 'Outdoor Feels Like'],
      ['feelsLikein', 'Indoor Feels Like'],
      ['dewPoint', 'Outdoor Dew Point'],
      ['dewPointin', 'Indoor Dew Point'],
      ['co2', 'CO2'],
      ['co2_in_aqin', 'Indoor CO2'],
      ['pm25', 'Outdoor PM2.5'],
      ['pm25_in_aqin', 'Indoor PM2.5'],
      ['pm10_in_aqin', 'Indoor PM10'],
      ['pm_in_temp_aqin', 'AQIN Temperature'],
      ['pm_in_humidity_aqin', 'AQIN Humidity'],
    ])('maps %s → %s', (key, expected) => {
      expect(friendlySensorName(key)).toBe(expected);
    });

    it('maps extended-sensor keys correctly', () => {
      expect(friendlySensorName('windspeedmph')).toBe('Wind Speed');
      expect(friendlySensorName('windgustmph')).toBe('Wind Gust');
      expect(friendlySensorName('maxdailygust')).toBe('Max Daily Gust');
      expect(friendlySensorName('winddir')).toBe('Wind Direction');
      expect(friendlySensorName('winddir_avg10m')).toBe('Wind Direction 10m Avg');
      expect(friendlySensorName('hourlyrainin')).toBe('Rain Rate');
      expect(friendlySensorName('eventrainin')).toBe('Rain Event');
      expect(friendlySensorName('dailyrainin')).toBe('Rain Daily');
      expect(friendlySensorName('weeklyrainin')).toBe('Rain Weekly');
      expect(friendlySensorName('monthlyrainin')).toBe('Rain Monthly');
      expect(friendlySensorName('yearlyrainin')).toBe('Rain Yearly');
      expect(friendlySensorName('lastRain')).toBe('Last Rain');
      expect(friendlySensorName('baromrelin')).toBe('Pressure Sea Level');
      expect(friendlySensorName('baromabsin')).toBe('Pressure Station');
      expect(friendlySensorName('uv')).toBe('UV Index');
      expect(friendlySensorName('lightning_day')).toBe('Lightning Strikes Today');
      expect(friendlySensorName('lightning_hour')).toBe('Lightning Strikes This Hour');
      expect(friendlySensorName('lightning_distance')).toBe('Lightning Distance');
      expect(friendlySensorName('lightning_time')).toBe('Last Lightning Strike');
    });
  });

  describe('numbered probe patterns', () => {
    it.each([
      ['temp1f', 'Temperature 1'],
      ['temp2f', 'Temperature 2'],
      ['temp10f', 'Temperature 10'],
      ['humidity1', 'Humidity 1'],
      ['humidity4', 'Humidity 4'],
      ['humidity10', 'Humidity 10'],
      ['feelsLike1', 'Feels Like 1'],
      ['feelsLike4', 'Feels Like 4'],
      ['dewPoint2', 'Dew Point 2'],
      ['dewPoint3', 'Dew Point 3'],
    ])('maps %s → %s', (key, expected) => {
      expect(friendlySensorName(key)).toBe(expected);
    });
  });

  describe('fallback for unknown keys', () => {
    it('returns the raw key when no mapping matches', () => {
      expect(friendlySensorName('unknownField')).toBe('unknownField');
      expect(friendlySensorName('someRandomKey')).toBe('someRandomKey');
      expect(friendlySensorName('')).toBe('');
    });

    it('does NOT numbered-match keys that only look numbered', () => {
      // The regex requires the whole key be `<kind>NUMf?`. Anything
      // else falls through to the raw-key fallback.
      expect(friendlySensorName('temp1abc')).toBe('temp1abc');
      expect(friendlySensorName('humid1')).toBe('humid1');
    });
  });
});

describe('sensorKeyByFriendlyName (reverse lookup)', () => {
  describe('reverses friendlySensorName cleanly for standard mappings', () => {
    it.each([
      ['Outdoor Temperature', 'tempf'],
      ['Indoor Temperature', 'tempinf'],
      ['Outdoor Humidity', 'humidity'],
      ['Wind Speed', 'windspeedmph'],
      ['Lightning Strikes Today', 'lightning_day'],
      ['Lightning Distance', 'lightning_distance'],
      ['AQIN Temperature', 'pm_in_temp_aqin'],
      ['AQIN Humidity', 'pm_in_humidity_aqin'],
    ])('reverses "%s" → %s', (friendly, key) => {
      expect(sensorKeyByFriendlyName(friendly)).toBe(key);
    });
  });

  describe('case-insensitive and whitespace-trimmed', () => {
    it('handles lowercase', () => {
      expect(sensorKeyByFriendlyName('outdoor temperature')).toBe('tempf');
    });
    it('handles uppercase', () => {
      expect(sensorKeyByFriendlyName('OUTDOOR TEMPERATURE')).toBe('tempf');
    });
    it('handles mixed case', () => {
      expect(sensorKeyByFriendlyName('Outdoor TEMPERATURE')).toBe('tempf');
    });
    it('trims leading/trailing whitespace', () => {
      expect(sensorKeyByFriendlyName('  Wind Speed  ')).toBe('windspeedmph');
      expect(sensorKeyByFriendlyName('\tWind Speed\n')).toBe('windspeedmph');
    });
  });

  describe('numbered-probe reverse lookups', () => {
    it.each([
      ['Temperature 1', 'temp1f'],
      ['Temperature 5', 'temp5f'],
      ['Humidity 3', 'humidity3'],
      ['Humidity 10', 'humidity10'],
      ['Feels Like 2', 'feelsLike2'],
      ['Dew Point 4', 'dewPoint4'],
    ])('reverses "%s" → %s', (friendly, key) => {
      expect(sensorKeyByFriendlyName(friendly)).toBe(key);
    });

    it('handles case-insensitive numbered probes', () => {
      expect(sensorKeyByFriendlyName('temperature 3')).toBe('temp3f');
      expect(sensorKeyByFriendlyName('FEELS LIKE 4')).toBe('feelsLike4');
    });
  });

  describe('returns undefined for unresolvable inputs', () => {
    it.each([
      '',
      '   ',
      'nonexistent sensor',
      'temperature',      // no number
      'humidity abc',     // non-numeric suffix
      'wind directional', // close but not a real friendly name
    ])('returns undefined for "%s"', (input) => {
      expect(sensorKeyByFriendlyName(input)).toBeUndefined();
    });
  });
});

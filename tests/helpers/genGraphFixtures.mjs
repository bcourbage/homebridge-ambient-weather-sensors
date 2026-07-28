/**
 * Golden graph-fixture generator (finding-#4 review, P1-C).
 *
 * Constructs every wrapper (2-arg legacy form) from a given dist tree
 * against the real-HAP harness and writes a normalized graph snapshot
 * per (wrapperId, battery:0|1) to a JSON file. Run against the v1.7.0
 * worktree's committed dist to produce the golden the migration gate
 * compares HEAD against:
 *
 *   node tests/helpers/genGraphFixtures.mjs <distDir> <outFile>
 *
 * The output is committed as tests/fixtures/graph/v1.7.0.json and only
 * ever regenerated deliberately (a diff there is a cache-migration event
 * that needs a structuralSignature plan).
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { makeHapPlatform, makeHapAccessory, serializeHapGraph, contextFor } from './hapGraph.mjs';

// wrapperId → { module (relative to distDir), export, type? } — the file
// layout is stable across v1.7.0 → HEAD.
const MANIFEST = [
  ['temperature',           'temperatureAccessory.js',            'TemperatureAccessory'],
  ['humidity',              'humidityAccessory.js',               'HumidityAccessory'],
  ['solar-radiation',       'solarRadiationAccessory.js',         'SolarRadiationAccessory'],
  ['co2',                   'co2Accessory.js',                    'Co2Accessory'],
  ['air-quality-pm25',      'airQualityAccessory.js',             'AirQualityAccessory', 'PM25'],
  ['air-quality-pm10',      'airQualityAccessory.js',             'AirQualityAccessory', 'PM10'],
  ['uv',                    'extendedSensors/uvAccessory.js',     'UvAccessory'],
  ['wind-speed',            'extendedSensors/windAccessory.js',   'WindSpeedAccessory'],
  ['wind-gust',             'extendedSensors/windAccessory.js',   'WindGustAccessory'],
  ['wind-max-daily-gust',   'extendedSensors/windAccessory.js',   'WindMaxDailyGustAccessory'],
  ['wind-direction',        'extendedSensors/windAccessory.js',   'WindDirectionAccessory'],
  ['wind-direction-10m',    'extendedSensors/windAccessory.js',   'WindDirection10mAccessory'],
  ['pressure-relative',     'extendedSensors/pressureAccessory.js', 'PressureRelativeAccessory'],
  ['pressure-absolute',     'extendedSensors/pressureAccessory.js', 'PressureAbsoluteAccessory'],
  ['rain-rate',             'extendedSensors/rainAccessory.js',   'RainRateAccessory'],
  ['rain-event',            'extendedSensors/rainAccessory.js',   'RainEventAccessory'],
  ['rain-daily',            'extendedSensors/rainAccessory.js',   'RainDailyAccessory'],
  ['rain-weekly',           'extendedSensors/rainAccessory.js',   'RainWeeklyAccessory'],
  ['rain-monthly',          'extendedSensors/rainAccessory.js',   'RainMonthlyAccessory'],
  ['rain-yearly',           'extendedSensors/rainAccessory.js',   'RainYearlyAccessory'],
  ['last-rain',             'extendedSensors/rainAccessory.js',   'LastRainAccessory'],
  ['lightning-day',         'extendedSensors/lightningAccessory.js', 'LightningDayAccessory'],
  ['lightning-hour',        'extendedSensors/lightningAccessory.js', 'LightningHourAccessory'],
  ['lightning-distance',    'extendedSensors/lightningAccessory.js', 'LightningDistanceAccessory'],
  ['lightning-last-strike', 'extendedSensors/lightningAccessory.js', 'LightningLastStrikeAccessory'],
];

const distDir = process.argv[2];
const outFile = process.argv[3];
if (!distDir || !outFile) {
  console.error('usage: node genGraphFixtures.mjs <distDir> <outFile>');
  process.exit(1);
}

const golden = {};
for (const [wrapperId, mod, exportName, type] of MANIFEST) {
  const modUrl = pathToFileURL(path.resolve(distDir, mod)).href;
  const Ctor = (await import(modUrl))[exportName];
  golden[wrapperId] = {};
  for (const battery of [0, 1]) {
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory(contextFor(wrapperId, { battery: battery === 1, type }));
    new Ctor(platform, accessory);
    golden[wrapperId][battery] = serializeHapGraph(accessory);
  }
}

writeFileSync(outFile, JSON.stringify(golden, null, 2) + '\n');
console.error(`wrote ${Object.keys(golden).length} wrapperIds × 2 battery variants → ${outFile}`);

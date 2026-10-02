/**
 * One-time generator for the catalog-3 wrapper graph golden
 * (tests/fixtures/graph/catalog3-v1.json) — sensor-map.md §19.7.
 *
 * Unlike the v1.7.0 golden (generated from the v1.7.0 tag's dist),
 * this baseline is generated from the CURRENT dist at the moment the
 * catalog-3 wrappers first ship: it pins their HAP graphs from that
 * point forward, so any later change to a §19 wrapper's service graph
 * is a cache-migration event caught by catalog3GraphParity.test.ts
 * (which also byte-hashes this file — regenerate ONLY with a
 * conscious migration plan and update the hash there).
 *
 * Run from the repo root AFTER `npm run build:plugin`:
 *   node tests/helpers/genCatalog3Graph.mjs
 */
import { writeFileSync } from 'node:fs';
import { makeHapPlatform, makeHapAccessory, serializeHapGraph } from './hapGraph.mjs';
import { instantiateWrapper } from '../../dist/sensorMap/wrapperFactories.js';

/** Representative effective rows per catalog-3 wrapper id (§19.5). */
export function catalog3Rows() {
  const numeric = (wrapperId, dataPoint, measurement, unit, batteryField) => ({
    dataPoint, stationMac: 'AA:BB:CC:DD:EE:01', name: `Golden ${wrapperId}`,
    kind: 'motion', measurement, sourceUnit: unit, displayUnit: unit,
    triggerEnabled: true, triggerDirection: 'above',
    batteryField, hasBatterySubService: false, embedName: false, enabled: true,
    structuralSignature: '', wrapperId,
  });
  const boolean = (wrapperId, dataPoint, kind, batteryField) => ({
    dataPoint, stationMac: 'AA:BB:CC:DD:EE:01', name: `Golden ${wrapperId}`,
    kind, measurement: 'boolean',
    triggerEnabled: false, triggerDirection: 'above',
    batteryField, hasBatterySubService: false, embedName: false, enabled: true,
    structuralSignature: '', wrapperId,
  });
  return {
    'leak':               boolean('leak', 'leak1', 'leak', 'batleak1'),
    'contact':            boolean('contact', 'test_contact', 'contact', 'battout'),
    'occupancy':          boolean('occupancy', 'test_occupancy', 'occupancy', 'battout'),
    'smoke':              boolean('smoke', 'test_smoke', 'smoke', 'battout'),
    'motion-boolean':     boolean('motion-boolean', 'test_motion_bool', 'motion', 'battout'),
    'soil-moisture':      numeric('soil-moisture', 'soilhum1', 'soil-moisture', 'percent', 'battsm1'),
    'leaf-wetness':       numeric('leaf-wetness', 'leafwetness1', 'leaf-wetness', 'percent', 'battout'),
    'soil-tension':       numeric('soil-tension', 'soiltens1', 'soil-tension', 'cb', 'battout'),
    'evapotranspiration': numeric('evapotranspiration', 'etos', 'evapotranspiration', 'in_per_day', 'battout'),
    'aqi':                numeric('aqi', 'aqi_pm25_aqin', 'aqi', 'index', 'batt_co2'),
  };
}

/** Benign seed per wrapper family (boolean rows must seed in-contract). */
export function seedFor(wrapperId) {
  return ['leak', 'contact', 'occupancy', 'smoke', 'motion-boolean'].includes(wrapperId) ? 0 : 50;
}

export function generate() {
  const golden = {};
  for (const [wrapperId, baseRow] of Object.entries(catalog3Rows())) {
    golden[wrapperId] = {};
    for (const battery of [0, 1]) {
      const row = { ...baseRow, hasBatterySubService: battery === 1 };
      const platform = makeHapPlatform();
      const accessory = makeHapAccessory({
        uniqueId: `MAC-${row.dataPoint}`,
        displayName: 'Parity Sensor',
        value: seedFor(wrapperId),
        batteryLow: battery ? false : undefined,
      });
      instantiateWrapper(platform, accessory, row);
      golden[wrapperId][battery] = serializeHapGraph(accessory);
    }
  }
  return golden;
}

const isMain = process.argv[1] && process.argv[1].endsWith('genCatalog3Graph.mjs');
if (isMain) {
  const golden = generate();
  writeFileSync(new URL('../fixtures/graph/catalog3-v1.json', import.meta.url), JSON.stringify(golden, null, 1));
  console.log(`catalog3-v1.json written (${Object.keys(golden).length} wrapper ids)`);
}

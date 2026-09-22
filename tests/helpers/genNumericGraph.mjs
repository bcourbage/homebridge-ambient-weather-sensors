/**
 * One-time generator for the catalog-4 generic-numeric wrapper graph
 * golden (tests/fixtures/graph/numeric-v1.json) — sensor-map.md §19.9.
 *
 * Follows the catalog-3 pattern (genCatalog3Graph.mjs): pin the
 * `numeric` wrapper's HAP service graph from the moment it first ships,
 * so any later change to its graph is a cache-migration event caught by
 * numericGraphParity.test.ts (which also byte-hashes this file —
 * regenerate ONLY with a conscious migration plan and update the hash
 * there). The catalog-3 golden stays frozen and untouched.
 *
 * Run from the repo root AFTER `npm run build:plugin`:
 *   node tests/helpers/genNumericGraph.mjs
 */
import { writeFileSync } from 'node:fs';
import { makeHapPlatform, makeHapAccessory, serializeHapGraph } from './hapGraph.mjs';
import { instantiateWrapper } from '../../dist/sensorMap/wrapperFactories.js';

/** The representative effective numeric row (§19.9). */
export function numericRow() {
  return {
    dataPoint: 'flow1', stationMac: 'AA:BB:CC:DD:EE:01', name: 'Golden Numeric',
    kind: 'motion', measurement: 'numeric', sourceUnit: 'raw', displayUnit: 'raw',
    unitLabel: 'L/min', triggerEnabled: true, triggerDirection: 'above',
    batteryField: 'battout', hasBatterySubService: false, embedName: false,
    enabled: true, structuralSignature: '', wrapperId: 'numeric',
  };
}

/** A finite mid-range seed; the graph shape is value-independent. */
export const NUMERIC_SEED = 50;

export function generate() {
  const golden = {};
  golden.numeric = {};
  for (const battery of [0, 1]) {
    const row = { ...numericRow(), hasBatterySubService: battery === 1 };
    const platform = makeHapPlatform();
    const accessory = makeHapAccessory({
      uniqueId: `MAC-${row.dataPoint}`,
      displayName: 'Parity Sensor',
      value: NUMERIC_SEED,
      batteryLow: battery ? false : undefined,
    });
    instantiateWrapper(platform, accessory, row);
    golden.numeric[battery] = serializeHapGraph(accessory);
  }
  return golden;
}

const isMain = process.argv[1] && process.argv[1].endsWith('genNumericGraph.mjs');
if (isMain) {
  const golden = generate();
  writeFileSync(new URL('../fixtures/graph/numeric-v1.json', import.meta.url), JSON.stringify(golden, null, 1));
  console.log(`numeric-v1.json written (${Object.keys(golden).length} wrapper id)`);
}

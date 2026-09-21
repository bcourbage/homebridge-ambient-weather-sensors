/**
 * Kind-column capability vocabulary (issue #50).
 *
 * Typed exhaustively against the engine's `SensorKind` union — a
 * type-only import, so no runtime code crosses the DTO boundary.
 * Adding or removing a kind fails this file's compile until the
 * header copy's vocabulary follows, and kindSupport.test.ts pins
 * every `supported` flag to the runtime wrapper table
 * (WRAPPER_FOR_KIND_AND_MEASUREMENT), so a kind gaining or losing a
 * concrete wrapper breaks CI instead of leaving the help copy stale.
 */
import type { SensorKind } from '../../src/sensorMap/types.js';

export interface KindSupportEntry {
  /** User-facing label (initialism casing where applicable). */
  label: string;
  /**
   * True when the runtime has a concrete wrapper for the kind. A
   * custom row declaring an unsupported kind fails with `no-wrapper`
   * and creates no Apple Home accessory.
   */
  supported: boolean;
}

export const KIND_SUPPORT: Readonly<Record<Exclude<SensorKind, 'unrecognized'>, KindSupportEntry>> = {
  'temperature':      { label: 'temperature', supported: true },
  'humidity':         { label: 'humidity',    supported: true },
  'light':            { label: 'light',       supported: true },
  'motion':           { label: 'motion',      supported: true },
  'co2':              { label: 'CO₂',         supported: true },
  'air-quality-pm25': { label: 'PM2.5',       supported: true },
  'air-quality-pm10': { label: 'PM10',        supported: true },
  'co':               { label: 'CO',          supported: false },
  'leak':             { label: 'leak',        supported: true },
  'contact':          { label: 'contact',     supported: true },
  'occupancy':        { label: 'occupancy',   supported: true },
  'smoke':            { label: 'smoke',       supported: true },
};

function listJoin(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const entries = Object.values(KIND_SUPPORT);

/**
 * Kind header help copy, derived so it cannot drift from the table.
 * `supported` means a concrete wrapper EXISTS; catalog-versioned kinds
 * additionally require the configuration to have adopted the catalog
 * that introduced them (§19.2) before an assignment resolves.
 */
const unsupportedLabels = entries.filter(e => !e.supported).map(e => e.label);
export const KIND_HELP =
  'Kind is the Apple Home accessory type created for this row. Currently '
  + `supported kinds are ${listJoin(entries.filter(e => e.supported).map(e => e.label))}. `
  + (unsupportedLabels.length > 0
    ? `${listJoin(unsupportedLabels)} are reserved for future support. `
    : '')
  + 'Some newer kinds require adopting the current sensor catalog before '
  + 'they can be assigned; a later plugin version guides that from this page. '
  + 'Rows marked ? are unrecognized and do not create an accessory.';

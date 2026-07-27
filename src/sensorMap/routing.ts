/**
 * Value distribution routing MECHANISM (finding-#4 Stage 3).
 *
 * IMPORTANT (review): this module is NOT yet wired into the platform. It
 * is a mechanism-only, UNIT-tested stage. `platform.ts` still constructs
 * and distributes via the v1.6.0 `createSensorWrapper` path; there is no
 * v2 construction branch yet, and shadow mode registers nothing. The
 * flag-gated v2 lifecycle — building this routing map, registering the
 * wrappers, and distributing through it — is wired as the FIRST commit of
 * the Stage 4 PR, BEFORE the resolution table is restored. Do not assume
 * the lifecycle boundary already exists.
 *
 * When it goes live it is the load-bearing wire that makes a row's
 * wrapper actually receive readings. v1.6.0's `distribute` matched AWN
 * payload keys to wrappers by a `MAC-sensorKey` uniqueId built from the
 * built-in AWN vocabulary — a custom `dataPoint` (`my_barn_wind`) would
 * never match and its value was dropped. The row-driven router instead
 * builds its `(mac, dataPoint) → wrapper` map straight from the effective
 * sensor map, so any row (known or custom) that resolved a wrapper
 * receives its value; `coerceValue` handles the non-numeric (timestamp /
 * boolean) fields at the boundary.
 *
 * The unit tests in `tests/unit/sensorMap/routing.test.ts` exercise these
 * functions in isolation (not the platform lifecycle).
 */

import type { Logger, PlatformAccessory } from 'homebridge';

import type { AmbientWeatherSensorsPlatform, SensorAccessory } from '../platform.js';
import { coerceValue } from './coerceValue.js';
import type { EffectiveSensorMap, EffectiveSensorRow } from './types.js';
import { instantiateWrapper } from './wrapperFactories.js';

export interface RoutingEntry {
  wrapper: SensorAccessory;
  row: EffectiveSensorRow;
}

/** Uppercased `${stationMac}|${dataPoint}` — the routing map key. */
export function routingKey(stationMac: string, dataPoint: string): string {
  return `${stationMac.toUpperCase()}|${dataPoint}`;
}

/**
 * Build the `(mac, dataPoint) → wrapper` routing map from an effective
 * map. Each enabled configured row is instantiated via
 * `instantiateWrapper`; a constructor (or dispatch) that throws is
 * isolated — the error is logged naming the row and that one wrapper is
 * dropped from the map, so a single bad row can't abort registration of
 * the rest.
 */
export function buildWrapperRouting(
  platform: AmbientWeatherSensorsPlatform,
  effectiveMap: EffectiveSensorMap,
  accessoryForUid: (uid: string) => PlatformAccessory | undefined,
  log: Logger = platform.log,
): Map<string, RoutingEntry> {
  const routing = new Map<string, RoutingEntry>();
  for (const row of effectiveMap.rows) {
    if (row.kind === 'unrecognized' || !row.enabled) {
      continue;
    }
    const uid = `${row.stationMac}-${row.dataPoint}`;
    const accessory = accessoryForUid(uid);
    if (!accessory) {
      log.debug(`[routing] no accessory for ${uid}; skipping row.`);
      continue;
    }
    try {
      const wrapper = instantiateWrapper(platform, accessory, row);
      routing.set(routingKey(row.stationMac, row.dataPoint), { wrapper, row });
    } catch (err) {
      // Registration-time throw isolated to this row (design's
      // defense-in-depth): log and continue registering the rest.
      log.error(
        `[routing] failed to instantiate wrapper for ${row.stationMac}|${row.dataPoint} `
        + `(${row.wrapperId}): ${(err as Error).message}`,
      );
    }
  }
  return routing;
}

/** A station's raw payload — only the fields the router touches. */
export interface StationPayload {
  macAddress: string;
  lastData: Record<string, unknown>;
}

/**
 * Fan a batch of station payloads through the routing map. For every
 * `(mac, dataPoint)` present in both the payload and the map, coerce the
 * raw value (drop the tick on a malformed timestamp / non-numeric) and
 * push it to the wrapper's `setValue`.
 */
export function distributeViaRouting(
  platform: AmbientWeatherSensorsPlatform,
  routing: Map<string, RoutingEntry>,
  stations: ReadonlyArray<StationPayload>,
): void {
  for (const station of stations) {
    for (const [dataPoint, raw] of Object.entries(station.lastData)) {
      const entry = routing.get(routingKey(station.macAddress, dataPoint));
      if (!entry) {
        continue;
      }
      const value = coerceValue(entry.row, raw);
      if (value === undefined) {
        platform.log.debug(
          `[routing] dropped ${station.macAddress}|${dataPoint}: `
          + `un-coercible ${typeof raw} value for measurement `
          + `${entry.row.kind === 'unrecognized' ? 'n/a' : entry.row.measurement}.`,
        );
        continue;
      }
      entry.wrapper.setValue(value);
    }
  }
}

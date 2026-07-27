/**
 * Typed wrapper-factory registry (finding-#4 wrapper parameterization).
 *
 * The plugin needs to turn a resolved `EffectiveSensorRow` into the
 * concrete accessory-wrapper instance named by its `wrapperId`. Doing
 * that with a `switch (row.wrapperId)` loses the compile-time link
 * between an id and the row shape its wrapper actually accepts, so a
 * wind factory could be handed a temperature row and nobody would
 * notice until runtime.
 *
 * Instead:
 *
 *   - `WRAPPER_SPEC` is the SINGLE source of truth mapping each
 *     `WrapperId` to the `(kind, measurement)` its wrapper handles.
 *   - `RowForWrapperId` derives the compile-time row narrowing FROM
 *     `WRAPPER_SPEC`, so a factory typed against a broader row shape
 *     than its wrapper declares fails to compile.
 *   - `assertRowMatchesWrapperId` is the runtime twin, re-checked at
 *     the dispatch boundary where the `<K, RowForWrapperId[K]>`
 *     correlation has been erased down to a bare `EffectiveSensorRow`.
 *
 * ── Staged rollout ────────────────────────────────────────────────
 * This is Stage 1 of the rollout described in
 * `docs/future/wrapper-parameterization.md`. Each `FACTORIES` entry is
 * currently an ADAPTER that accepts the row and DISCARDS it, then
 * invokes the wrapper's existing two-argument `(platform, accessory)`
 * constructor. That keeps every existing test and the shipping value
 * path green while giving the platform a single row-aware entry point
 * to call. `instantiateWrapper` is exercised by its own unit tests
 * here; `platform.ts` starts routing through it in Stage 3. The
 * row-consuming constructor forms land family-by-family in Stage 2,
 * at which point each adapter is replaced by its row-aware `(p, a, r)`
 * form. The resolution table stays empty until Stage 4, so no CUSTOM
 * row reaches this registry yet — only known-dataPoint rows do, and
 * those already carry a correct `wrapperId` from the default map.
 */

import type { PlatformAccessory } from 'homebridge';

import type { AmbientWeatherSensorsPlatform, SensorAccessory } from '../platform.js';
import type {
  EffectiveSensorRow,
  Measurement,
  SensorKind,
  WrapperId,
} from './types.js';

import { TemperatureAccessory } from '../temperatureAccessory.js';
import { HumidityAccessory } from '../humidityAccessory.js';
import { SolarRadiationAccessory } from '../solarRadiationAccessory.js';
import { Co2Accessory } from '../co2Accessory.js';
import { AirQualityAccessory } from '../airQualityAccessory.js';
import { UvAccessory } from '../extendedSensors/uvAccessory.js';
import {
  WindSpeedAccessory,
  WindGustAccessory,
  WindMaxDailyGustAccessory,
  WindDirectionAccessory,
  WindDirection10mAccessory,
} from '../extendedSensors/windAccessory.js';
import {
  PressureRelativeAccessory,
  PressureAbsoluteAccessory,
} from '../extendedSensors/pressureAccessory.js';
import {
  RainRateAccessory,
  RainEventAccessory,
  RainDailyAccessory,
  RainWeeklyAccessory,
  RainMonthlyAccessory,
  RainYearlyAccessory,
  LastRainAccessory,
} from '../extendedSensors/rainAccessory.js';
import {
  LightningDayAccessory,
  LightningHourAccessory,
  LightningDistanceAccessory,
  LightningLastStrikeAccessory,
} from '../extendedSensors/lightningAccessory.js';

/**
 * The SINGLE source of truth for `WrapperId → (kind, measurement)`.
 * Both `RowForWrapperId` (compile-time factory-parameter narrowing)
 * and `assertRowMatchesWrapperId` (runtime dispatch check) derive from
 * this object, so a drift between the two is a compile error rather
 * than a bug that ships.
 *
 * `air-quality-pm25` and `air-quality-pm10` share the same wrapper
 * CLASS but have distinct ids and distinct measurements — the factory
 * names the variant explicitly rather than the wrapper sniffing it
 * from `accessory.context`.
 *
 * The `satisfies` clause forces every key to be a real `WrapperId` and
 * every value to be a real `(SensorKind, Measurement)` pair WITHOUT
 * widening the literal types, so `WRAPPER_SPEC[id].kind` stays a
 * narrow literal the mapped type below can consume.
 */
export const WRAPPER_SPEC = {
  'temperature':           { kind: 'temperature',      measurement: 'temperature'       },
  'humidity':              { kind: 'humidity',         measurement: 'humidity'          },
  'solar-radiation':       { kind: 'light',            measurement: 'illuminance'       },
  'co2':                   { kind: 'co2',              measurement: 'co2'               },
  'air-quality-pm25':      { kind: 'air-quality-pm25', measurement: 'pm25'              },
  'air-quality-pm10':      { kind: 'air-quality-pm10', measurement: 'pm10'              },
  'uv':                    { kind: 'motion',           measurement: 'uv-index'          },
  'wind-speed':            { kind: 'motion',           measurement: 'wind-speed'        },
  'wind-gust':             { kind: 'motion',           measurement: 'wind-speed'        },
  'wind-max-daily-gust':   { kind: 'motion',           measurement: 'wind-speed'        },
  'wind-direction':        { kind: 'motion',           measurement: 'direction'         },
  'wind-direction-10m':    { kind: 'motion',           measurement: 'direction'         },
  'pressure-relative':     { kind: 'motion',           measurement: 'pressure'          },
  'pressure-absolute':     { kind: 'motion',           measurement: 'pressure'          },
  'rain-rate':             { kind: 'motion',           measurement: 'rain-rate'         },
  'rain-event':            { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-daily':            { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-weekly':           { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-monthly':          { kind: 'motion',           measurement: 'rain-accumulation' },
  'rain-yearly':           { kind: 'motion',           measurement: 'rain-accumulation' },
  'last-rain':             { kind: 'motion',           measurement: 'timestamp'         },
  'lightning-day':         { kind: 'motion',           measurement: 'count'             },
  'lightning-hour':        { kind: 'motion',           measurement: 'count'             },
  'lightning-distance':    { kind: 'motion',           measurement: 'distance'          },
  'lightning-last-strike': { kind: 'motion',           measurement: 'timestamp'         },
} as const satisfies Record<WrapperId, { kind: SensorKind; measurement: Measurement }>;

/**
 * Compile-time factory-parameter narrowing, derived from
 * `WRAPPER_SPEC`. TypeScript rejects any factory whose row parameter
 * is broader than its wrapper's declared `(kind, measurement)`.
 */
export type RowForWrapperId = {
  [K in WrapperId]: EffectiveSensorRow & {
    kind: typeof WRAPPER_SPEC[K]['kind'];
    measurement: typeof WRAPPER_SPEC[K]['measurement'];
  };
};

type Factory<R> = (
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  row: R,
) => SensorAccessory;

/**
 * The typed factory registry — a MAPPED type, so TypeScript enforces
 * that EVERY `WrapperId` has exactly one entry (a missing or extra key
 * fails to compile). Each entry is obligated to accept exactly the row
 * shape `RowForWrapperId[K]` declares.
 *
 * STAGE 1: every entry is an ADAPTER — it ignores the row and calls the
 * wrapper's existing `(platform, accessory)` constructor. A 2-arg arrow
 * is assignable to the 3-arg `Factory` type (excess parameters are
 * allowed), so the row is simply never bound. Stage 2 replaces each
 * adapter with its row-consuming `(p, a, r) => new X(p, a, r)` form as
 * that family's constructor is migrated.
 */
export const FACTORIES: { [K in WrapperId]: Factory<RowForWrapperId[K]> } = {
  'temperature':           (p, a) => new TemperatureAccessory(p, a),
  'humidity':              (p, a) => new HumidityAccessory(p, a),
  'solar-radiation':       (p, a) => new SolarRadiationAccessory(p, a),
  'co2':                   (p, a) => new Co2Accessory(p, a),
  'air-quality-pm25':      (p, a) => new AirQualityAccessory(p, a),
  'air-quality-pm10':      (p, a) => new AirQualityAccessory(p, a),
  'uv':                    (p, a) => new UvAccessory(p, a),
  'wind-speed':            (p, a) => new WindSpeedAccessory(p, a),
  'wind-gust':             (p, a) => new WindGustAccessory(p, a),
  'wind-max-daily-gust':   (p, a) => new WindMaxDailyGustAccessory(p, a),
  'wind-direction':        (p, a) => new WindDirectionAccessory(p, a),
  'wind-direction-10m':    (p, a) => new WindDirection10mAccessory(p, a),
  'pressure-relative':     (p, a) => new PressureRelativeAccessory(p, a),
  'pressure-absolute':     (p, a) => new PressureAbsoluteAccessory(p, a),
  'rain-rate':             (p, a) => new RainRateAccessory(p, a),
  'rain-event':            (p, a) => new RainEventAccessory(p, a),
  'rain-daily':            (p, a) => new RainDailyAccessory(p, a),
  'rain-weekly':           (p, a) => new RainWeeklyAccessory(p, a),
  'rain-monthly':          (p, a) => new RainMonthlyAccessory(p, a),
  'rain-yearly':           (p, a) => new RainYearlyAccessory(p, a),
  'last-rain':             (p, a) => new LastRainAccessory(p, a),
  'lightning-day':         (p, a) => new LightningDayAccessory(p, a),
  'lightning-hour':        (p, a) => new LightningHourAccessory(p, a),
  'lightning-distance':    (p, a) => new LightningDistanceAccessory(p, a),
  'lightning-last-strike': (p, a) => new LightningLastStrikeAccessory(p, a),
};

/**
 * Runtime twin of `RowForWrapperId`, checked at the dispatch boundary
 * where the compile-time `<K, RowForWrapperId[K]>` correlation has been
 * erased down to a bare `EffectiveSensorRow`. Throws if the row's
 * `wrapperId` disagrees with its `(kind, measurement)`.
 *
 * `kind` is checked in ADDITION to `measurement` because two rows can
 * share a measurement while differing in kind (e.g. a `(motion,
 * timestamp)` row vs an `unrecognized` row) and must not both route to
 * the same timestamp factory. Unrecognized rows have no wrapper and
 * return early — callers reject them before this point.
 */
export function assertRowMatchesWrapperId(row: EffectiveSensorRow): void {
  if (row.kind === 'unrecognized') {
    return;
  }
  const spec = WRAPPER_SPEC[row.wrapperId];
  if (row.kind !== spec.kind || row.measurement !== spec.measurement) {
    throw new Error(
      `Wrapper '${row.wrapperId}' expects (${spec.kind}, ${spec.measurement}); `
      + `row for ${row.stationMac}|${row.dataPoint} has (${row.kind}, ${row.measurement}).`,
    );
  }
}

/**
 * Turn a resolved row into its concrete wrapper instance. The single
 * row-aware entry point the platform calls (Stage 3 onward).
 *
 * Unrecognized rows have no wrapper — the caller must not reach here
 * with one; we throw rather than silently no-op so the bug surfaces.
 * `assertRowMatchesWrapperId` is the defense-in-depth re-check: if
 * `buildEffectiveSensorMap` did its job the row is already consistent,
 * but a mismatch here (a default-map bug, say) throws so the platform's
 * per-row registration guard can isolate it instead of registering a
 * mis-typed accessory.
 */
export function instantiateWrapper(
  platform: AmbientWeatherSensorsPlatform,
  accessory: PlatformAccessory,
  row: EffectiveSensorRow,
): SensorAccessory {
  if (row.kind === 'unrecognized') {
    throw new Error(`Cannot instantiate a wrapper for unrecognized row '${row.dataPoint}'.`);
  }
  assertRowMatchesWrapperId(row);
  const factory = FACTORIES[row.wrapperId] as Factory<EffectiveSensorRow>;
  return factory(platform, accessory, row);
}

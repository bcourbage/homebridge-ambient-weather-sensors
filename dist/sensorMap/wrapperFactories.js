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
 * See `docs/future/wrapper-parameterization.md`. As of Stage 2 every
 * `FACTORIES` entry is the row-consuming `(p, a, r) => new X(p, a, r)`
 * form — the wrapper reads its runtime knobs (threshold, units,
 * battery, trigger direction) from the row (Stage 1's adapter form,
 * which discarded the row and called the legacy two-argument
 * constructor, is gone). `instantiateWrapper` is exercised by its own
 * unit tests here and by the routing mechanism; `platform.ts` does NOT
 * yet route through it — the flag-gated v2 construction path is wired in
 * Stage 4's first commit (Stage 3 is mechanism-only, unit-tested). The
 * resolution table stays empty until Stage 4, so no CUSTOM row reaches
 * this registry yet — only known-dataPoint rows do, and those already
 * carry a correct `wrapperId` from the default map.
 */
import { TemperatureAccessory } from '../temperatureAccessory.js';
import { HumidityAccessory } from '../humidityAccessory.js';
import { SolarRadiationAccessory } from '../solarRadiationAccessory.js';
import { Co2Accessory } from '../co2Accessory.js';
import { AirQualityAccessory } from '../airQualityAccessory.js';
import { UvAccessory } from '../extendedSensors/uvAccessory.js';
import { WindSpeedAccessory, WindGustAccessory, WindMaxDailyGustAccessory, WindDirectionAccessory, WindDirection10mAccessory, } from '../extendedSensors/windAccessory.js';
import { PressureRelativeAccessory, PressureAbsoluteAccessory, } from '../extendedSensors/pressureAccessory.js';
import { RainRateAccessory, RainEventAccessory, RainDailyAccessory, RainWeeklyAccessory, RainMonthlyAccessory, RainYearlyAccessory, LastRainAccessory, } from '../extendedSensors/rainAccessory.js';
import { LightningDayAccessory, LightningHourAccessory, LightningDistanceAccessory, LightningLastStrikeAccessory, } from '../extendedSensors/lightningAccessory.js';
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
    'temperature': { kind: 'temperature', measurement: 'temperature' },
    'humidity': { kind: 'humidity', measurement: 'humidity' },
    'solar-radiation': { kind: 'light', measurement: 'illuminance' },
    'co2': { kind: 'co2', measurement: 'co2' },
    'air-quality-pm25': { kind: 'air-quality-pm25', measurement: 'pm25' },
    'air-quality-pm10': { kind: 'air-quality-pm10', measurement: 'pm10' },
    'uv': { kind: 'motion', measurement: 'uv-index' },
    'wind-speed': { kind: 'motion', measurement: 'wind-speed' },
    'wind-gust': { kind: 'motion', measurement: 'wind-speed' },
    'wind-max-daily-gust': { kind: 'motion', measurement: 'wind-speed' },
    'wind-direction': { kind: 'motion', measurement: 'direction' },
    'wind-direction-10m': { kind: 'motion', measurement: 'direction' },
    'pressure-relative': { kind: 'motion', measurement: 'pressure' },
    'pressure-absolute': { kind: 'motion', measurement: 'pressure' },
    'rain-rate': { kind: 'motion', measurement: 'rain-rate' },
    'rain-event': { kind: 'motion', measurement: 'rain-accumulation' },
    'rain-daily': { kind: 'motion', measurement: 'rain-accumulation' },
    'rain-weekly': { kind: 'motion', measurement: 'rain-accumulation' },
    'rain-monthly': { kind: 'motion', measurement: 'rain-accumulation' },
    'rain-yearly': { kind: 'motion', measurement: 'rain-accumulation' },
    'last-rain': { kind: 'motion', measurement: 'timestamp' },
    'lightning-day': { kind: 'motion', measurement: 'count' },
    'lightning-hour': { kind: 'motion', measurement: 'count' },
    'lightning-distance': { kind: 'motion', measurement: 'distance' },
    'lightning-last-strike': { kind: 'motion', measurement: 'timestamp' },
};
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
export const FACTORIES = {
    'temperature': (p, a, r) => new TemperatureAccessory(p, a, r),
    'humidity': (p, a, r) => new HumidityAccessory(p, a, r),
    'solar-radiation': (p, a, r) => new SolarRadiationAccessory(p, a, r),
    'co2': (p, a, r) => new Co2Accessory(p, a, r),
    'air-quality-pm25': (p, a, r) => new AirQualityAccessory(p, a, r),
    'air-quality-pm10': (p, a, r) => new AirQualityAccessory(p, a, r),
    'uv': (p, a, r) => new UvAccessory(p, a, r),
    'wind-speed': (p, a, r) => new WindSpeedAccessory(p, a, r),
    'wind-gust': (p, a, r) => new WindGustAccessory(p, a, r),
    'wind-max-daily-gust': (p, a, r) => new WindMaxDailyGustAccessory(p, a, r),
    'wind-direction': (p, a, r) => new WindDirectionAccessory(p, a, r),
    'wind-direction-10m': (p, a, r) => new WindDirection10mAccessory(p, a, r),
    'pressure-relative': (p, a, r) => new PressureRelativeAccessory(p, a, r),
    'pressure-absolute': (p, a, r) => new PressureAbsoluteAccessory(p, a, r),
    'rain-rate': (p, a, r) => new RainRateAccessory(p, a, r),
    'rain-event': (p, a, r) => new RainEventAccessory(p, a, r),
    'rain-daily': (p, a, r) => new RainDailyAccessory(p, a, r),
    'rain-weekly': (p, a, r) => new RainWeeklyAccessory(p, a, r),
    'rain-monthly': (p, a, r) => new RainMonthlyAccessory(p, a, r),
    'rain-yearly': (p, a, r) => new RainYearlyAccessory(p, a, r),
    'last-rain': (p, a, r) => new LastRainAccessory(p, a, r),
    'lightning-day': (p, a, r) => new LightningDayAccessory(p, a, r),
    'lightning-hour': (p, a, r) => new LightningHourAccessory(p, a, r),
    'lightning-distance': (p, a, r) => new LightningDistanceAccessory(p, a, r),
    'lightning-last-strike': (p, a, r) => new LightningLastStrikeAccessory(p, a, r),
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
export function assertRowMatchesWrapperId(row) {
    if (!rowMatchesWrapperId(row)) {
        const spec = WRAPPER_SPEC[row.wrapperId];
        throw new Error(`Wrapper '${row.wrapperId}' expects (${spec.kind}, ${spec.measurement}); `
            + `row for ${row.stationMac}|${row.dataPoint} has (${row.kind}, `
            + `${row.measurement}).`);
    }
}
/**
 * Non-throwing twin of `assertRowMatchesWrapperId`, used by
 * `buildEffectiveSensorMap` to DROP a mismatched row (and push a
 * `wrapper-mismatch` note) at map-construction time rather than throwing
 * at registration. Unrecognized rows have no wrapper and vacuously match.
 */
export function rowMatchesWrapperId(row) {
    if (row.kind === 'unrecognized') {
        return true;
    }
    const spec = WRAPPER_SPEC[row.wrapperId];
    return row.kind === spec.kind && row.measurement === spec.measurement;
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
export function instantiateWrapper(platform, accessory, row) {
    if (row.kind === 'unrecognized') {
        throw new Error(`Cannot instantiate a wrapper for unrecognized row '${row.dataPoint}'.`);
    }
    assertRowMatchesWrapperId(row);
    const factory = FACTORIES[row.wrapperId];
    return factory(platform, accessory, row);
}
//# sourceMappingURL=wrapperFactories.js.map
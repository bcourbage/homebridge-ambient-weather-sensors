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
 * unit tests here, by the routing mechanism, and by the LIVE flag-gated
 * v2 construction path (`platform.ts`'s `discoverDevicesV2`, wired in
 * Stage 4). With the resolution table restored (Stage 4's
 * table-restoration commit), CUSTOM rows reach this registry too —
 * their `wrapperId` comes from `WRAPPER_FOR_KIND_AND_MEASUREMENT`,
 * known-dataPoint rows' from the default map; both are spec-checked at
 * map construction and re-asserted here at dispatch.
 */
import type { PlatformAccessory } from 'homebridge';
import type { AmbientWeatherSensorsPlatform, SensorAccessory } from '../platform.js';
import type { EffectiveSensorRow, WrapperId } from './types.js';
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
export declare const WRAPPER_SPEC: {
    readonly temperature: {
        readonly kind: "temperature";
        readonly measurement: "temperature";
    };
    readonly humidity: {
        readonly kind: "humidity";
        readonly measurement: "humidity";
    };
    readonly 'solar-radiation': {
        readonly kind: "light";
        readonly measurement: "illuminance";
    };
    readonly co2: {
        readonly kind: "co2";
        readonly measurement: "co2";
    };
    readonly 'air-quality-pm25': {
        readonly kind: "air-quality-pm25";
        readonly measurement: "pm25";
    };
    readonly 'air-quality-pm10': {
        readonly kind: "air-quality-pm10";
        readonly measurement: "pm10";
    };
    readonly uv: {
        readonly kind: "motion";
        readonly measurement: "uv-index";
    };
    readonly 'wind-speed': {
        readonly kind: "motion";
        readonly measurement: "wind-speed";
    };
    readonly 'wind-gust': {
        readonly kind: "motion";
        readonly measurement: "wind-speed";
    };
    readonly 'wind-max-daily-gust': {
        readonly kind: "motion";
        readonly measurement: "wind-speed";
    };
    readonly 'wind-direction': {
        readonly kind: "motion";
        readonly measurement: "direction";
    };
    readonly 'wind-direction-10m': {
        readonly kind: "motion";
        readonly measurement: "direction";
    };
    readonly 'pressure-relative': {
        readonly kind: "motion";
        readonly measurement: "pressure";
    };
    readonly 'pressure-absolute': {
        readonly kind: "motion";
        readonly measurement: "pressure";
    };
    readonly 'rain-rate': {
        readonly kind: "motion";
        readonly measurement: "rain-rate";
    };
    readonly 'rain-event': {
        readonly kind: "motion";
        readonly measurement: "rain-accumulation";
    };
    readonly 'rain-daily': {
        readonly kind: "motion";
        readonly measurement: "rain-accumulation";
    };
    readonly 'rain-weekly': {
        readonly kind: "motion";
        readonly measurement: "rain-accumulation";
    };
    readonly 'rain-monthly': {
        readonly kind: "motion";
        readonly measurement: "rain-accumulation";
    };
    readonly 'rain-yearly': {
        readonly kind: "motion";
        readonly measurement: "rain-accumulation";
    };
    readonly 'last-rain': {
        readonly kind: "motion";
        readonly measurement: "timestamp";
    };
    readonly 'lightning-day': {
        readonly kind: "motion";
        readonly measurement: "count";
    };
    readonly 'lightning-hour': {
        readonly kind: "motion";
        readonly measurement: "count";
    };
    readonly 'lightning-distance': {
        readonly kind: "motion";
        readonly measurement: "distance";
    };
    readonly 'lightning-last-strike': {
        readonly kind: "motion";
        readonly measurement: "timestamp";
    };
};
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
type Factory<R> = (platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: R) => SensorAccessory;
/**
 * The typed factory registry — a MAPPED type, so TypeScript enforces
 * that EVERY `WrapperId` has exactly one entry (a missing or extra key
 * fails to compile). Each entry is obligated to accept exactly the row
 * shape `RowForWrapperId[K]` declares.
 *
 * Every entry is the row-consuming `(p, a, r) => new X(p, a, r)` form:
 * the constructor reads its runtime knobs (name, threshold, trigger
 * direction, units, battery ownership, embed mode) from the row. The
 * row parameter is OPTIONAL on the constructors because the flag-off
 * v1 path still constructs wrappers without one — with `row`
 * undefined, each constructor falls back to the legacy
 * `platform.config.*` reads, which is what keeps flag-off behavior
 * identical to v1.7.0. (The interim "Stage 1 adapter" form, which
 * discarded the row entirely, was retired when the constructors were
 * migrated in Stage 2.)
 */
export declare const FACTORIES: {
    [K in WrapperId]: Factory<RowForWrapperId[K]>;
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
export declare function assertRowMatchesWrapperId(row: EffectiveSensorRow): void;
/**
 * Non-throwing twin of `assertRowMatchesWrapperId`, used by
 * `buildEffectiveSensorMap` to DROP a mismatched row (and push a
 * `wrapper-mismatch` note) at map-construction time rather than throwing
 * at registration. Unrecognized rows have no wrapper and vacuously match.
 */
export declare function rowMatchesWrapperId(row: EffectiveSensorRow): boolean;
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
export declare function instantiateWrapper(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: EffectiveSensorRow): SensorAccessory;
export {};
//# sourceMappingURL=wrapperFactories.d.ts.map
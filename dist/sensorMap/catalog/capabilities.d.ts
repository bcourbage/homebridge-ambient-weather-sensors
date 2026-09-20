/**
 * The output-capability specification (issue #63, package P1): which
 * native HomeKit sensor representations exist, which the plugin
 * actually implements, and where the extended (threshold-shell)
 * representation stands in. The INPUT side (what an AWN field means)
 * lives in awnCatalog.ts; whether an installation exposes a row is the
 * exposure policy (sensor-map.md §18). Design-checkpoint data,
 * consumed by tests only — the runtime's single authority on
 * implemented pairs remains WRAPPER_FOR_KIND_AND_MEASUREMENT, and the
 * coverage suite cross-checks this specification against it so the two
 * cannot drift.
 *
 * Native HAP support is not a promise that Apple's Home app renders a
 * characteristic as a tile; Apple Home versus other HomeKit clients is
 * documented separately (plugin-ui.md / README), not promised here.
 */
export type NativeServiceStatus = 
/** A plugin kind produces this service today. */
'implemented'
/** Implemented for specific measurements only; not a general mapping. */
 | 'implemented-narrow'
/** The plugin reserves a kind, but no wrapper exists yet. */
 | 'reserved-no-wrapper'
/** The native service exists; the plugin vocabulary has no kind for it. */
 | 'absent-from-vocabulary';
export interface NativeServiceSpec {
    /** HAP service family (sensor-only scope). */
    service: string;
    /** The plugin kinds that map to it, where any exist. */
    kinds?: string[];
    status: NativeServiceStatus;
    /** Honest statement of scope and limits. */
    scope: string;
}
/**
 * The 11 native sensor service families the installed HAP library
 * declares — the sensor-only scope, not every HomeKit actuator,
 * camera, or bridge service.
 */
export declare const NATIVE_SENSOR_SERVICES: ReadonlyArray<NativeServiceSpec>;
//# sourceMappingURL=capabilities.d.ts.map
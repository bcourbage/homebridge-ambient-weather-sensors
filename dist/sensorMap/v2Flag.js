/**
 * The v2-construction gate, post-flip (GA task #65).
 *
 * From 2.0.0-beta.17 the row-driven v2 construction path is the
 * DEFAULT. The gate keeps two explicit opt-outs, precedence env over
 * config over default:
 *
 *   - env `SENSOR_MAP_V2=0` (or `false`) forces the v1.6.0 path — the
 *     operator's rollback lever, no config edit needed;
 *   - env `SENSOR_MAP_V2=1` (or `true`) forces v2 even over a config
 *     opt-out (the pre-flip opt-in keeps its meaning);
 *   - config `_sensorMapV2: false` (or 'false' / 0 — HB UI X sometimes
 *     yields JSON-string booleans) opts a single install out.
 *
 * `_sensorMapV2` is no longer exposed anywhere in the UI or schema; a
 * hand-authored opt-out is honored but undocumented, and the field is
 * scheduled for removal at 2.2.0 with the rest of the rollback
 * affordances.
 *
 * This replaces shadowModeEnabled(): the compare-only shadow observer
 * was retired at the flip, so the flag now gates exactly one thing —
 * which construction pipeline discoverDevices runs.
 */
export function v2ConstructionEnabled(opts) {
    const env = opts.env ?? process.env;
    if (env.SENSOR_MAP_V2 === '1' || env.SENSOR_MAP_V2 === 'true') {
        return true;
    }
    if (env.SENSOR_MAP_V2 === '0' || env.SENSOR_MAP_V2 === 'false') {
        return false;
    }
    const cfgVal = opts.config?._sensorMapV2;
    if (cfgVal === false || cfgVal === 'false' || cfgVal === 0) {
        return false;
    }
    return true;
}
//# sourceMappingURL=v2Flag.js.map
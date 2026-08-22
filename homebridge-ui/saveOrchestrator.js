/**
 * Client-side save orchestration for the compose-save boundary (GA
 * task #67 / finding 5). This module is the ONE way the editor (#69,
 * its first caller) persists a sensor map:
 *
 *   /compose-save  →  await response  →  updatePluginConfig(...)  →  savePluginConfig()
 *
 * Homebridge provides no server-side config-write API — persistence is
 * client-side by platform design — so the ordering guarantee lives in
 * this sequence: the composed config that could mutate config.json is
 * not handed to HB UI X until the server has made the pre-conversion
 * legacy record durable — the immutable snapshot on a first
 * conversion; an appended conversion-journal baseline on a
 * reconversion. Any compose refusal or failure produces ZERO
 * update/save calls.
 *
 * Framework-free and dependency-injected so the integration suite can
 * drive it against the REAL handler with an event-logging fake of the
 * HB UI X client API. Only type imports reference server code (erased
 * at compile time; safe in the browser).
 */
export async function composeAndPersist(deps, args) {
    const cfgArray = await deps.getPluginConfig();
    const blocks = cfgArray.filter(b => b && b.platform === 'AmbientWeatherSensors');
    const digestSession = args.baseDigest !== undefined;
    if (digestSession && (typeof args.baseDigest !== 'string' || args.baseDigest.length === 0
        || !Number.isInteger(args.blockIndex) || args.blockIndex < 0
        || args.blockIndex >= cfgArray.length)) {
        return {
            ok: false,
            error: {
                code: 'stale-base',
                message: 'The editor session token no longer matches the plugin config layout; reload and retry.',
            },
        };
    }
    let base = args.base;
    if (!digestSession && base === undefined) {
        if (blocks.length !== 1) {
            return {
                ok: false,
                error: {
                    code: 'ambiguous-platform-block',
                    message: `${blocks.length} AmbientWeatherSensors blocks in the plugin config; pass the block being edited.`,
                },
            };
        }
        base = blocks[0];
    }
    let cachedAccessoryUniqueIds;
    if (deps.getCachedAccessories) {
        try {
            const cached = await deps.getCachedAccessories();
            cachedAccessoryUniqueIds = cached
                .map(a => a?.context?.device?.uniqueId)
                .filter((u) => typeof u === 'string');
        }
        catch {
            cachedAccessoryUniqueIds = undefined; // inventory source is best-effort
        }
    }
    // Locate where the composed block will be WRITTEN BACK in the
    // getPluginConfig() array. In a digest session the position is the
    // /editor-state blockIndex (the array only serves as the write
    // vehicle — its CONTENT is form-mutated and untrustworthy, which is
    // exactly why the digest exists; the server does the real staleness
    // check against disk). In the legacy base flow the block is located
    // by deep equality (review #67 P1-3): a separately deserialized
    // base is never reference-equal, and indexOf would silently APPEND
    // the composed block as a duplicate.
    let index;
    if (digestSession) {
        index = args.blockIndex;
    }
    else {
        const matchIndexes = cfgArray
            .map((b, i) => (deepJson(b) === deepJson(base) ? i : -1))
            .filter(i => i >= 0);
        if (matchIndexes.length !== 1) {
            return {
                ok: false,
                error: {
                    code: matchIndexes.length === 0 ? 'stale-base' : 'ambiguous-platform-block',
                    message: matchIndexes.length === 0
                        ? 'The block being edited no longer matches the current plugin config; reload and retry.'
                        : `${matchIndexes.length} identical blocks match the base; cannot determine which to replace.`,
                },
            };
        }
        index = matchIndexes[0];
    }
    const result = await deps.request('/compose-save', {
        base: digestSession ? undefined : base,
        baseDigest: digestSession ? args.baseDigest : undefined,
        proposal: args.proposal,
        cachedAccessoryUniqueIds,
        liveStations: args.liveStations,
        confirmDigest: args.confirmDigest,
    });
    if (!result || result.ok !== true) {
        // Refusal or malformed response: NO update, NO save.
        return result ?? { ok: false, error: { code: 'invalid-proposal', message: 'Empty response from /compose-save.' } };
    }
    const nextArray = cfgArray.map((b, i) => (i === index ? result.nextConfig : b));
    // Post-compose persistence failures are INDETERMINATE (review #45
    // P1-2): HB UI X may have taken effect and then rejected, or lost
    // the response. Never tell the user "nothing was written" here —
    // report the failed stage and direct them to reload and inspect
    // before retrying. (The legacy snapshot is already durable either
    // way; a retry re-verifies it.)
    try {
        // HB UI X applies updatePluginConfig by MERGING each submitted
        // block into its in-memory copy (Object.assign), so a key the
        // composed config REMOVED — a legacy field the mirror omits, or a
        // schema default the settings form materialized — would silently
        // survive into the persisted file, and a resurrected mirrored
        // field makes the freshly written mirror hash STALE on arrival
        // (caught by the harness receipt check). The same code path
        // TRUNCATES its copy to the submitted array length and assigns
        // submitted blocks directly into empty slots, so an empty update
        // followed by the real one is a verbatim replacement under every
        // transport. The clear is in-memory only; nothing reaches disk
        // before savePluginConfig.
        await deps.updatePluginConfig([]);
        await deps.updatePluginConfig(nextArray);
    }
    catch (e) {
        return {
            ok: false,
            error: {
                code: 'persistence-indeterminate',
                stage: 'updatePluginConfig',
                message: `updatePluginConfig failed after the save was composed: ${e.message}. The staged `
                    + 'configuration state is uncertain — reload the plugin settings and inspect the configuration before '
                    + 'retrying. The legacy snapshot (when applicable) was already written and is verified on retry.',
            },
        };
    }
    try {
        await deps.savePluginConfig();
    }
    catch (e) {
        return {
            ok: false,
            error: {
                code: 'persistence-indeterminate',
                stage: 'savePluginConfig',
                message: `savePluginConfig failed after the configuration was staged: ${e.message}. The save `
                    + 'MAY have been applied — reload the plugin settings and inspect the configuration before retrying.',
            },
        };
    }
    return result;
}
/** Deterministic deep JSON (sorted keys) for block matching. */
function deepJson(v) {
    if (Array.isArray(v)) {
        return `[${v.map(deepJson).join(',')}]`;
    }
    if (v && typeof v === 'object') {
        const entries = Object.entries(v)
            .filter(([, val]) => val !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1));
        return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${deepJson(val)}`).join(',')}}`;
    }
    return JSON.stringify(v);
}

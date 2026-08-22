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
    // The settings form and HB UI X's Save button are a SECOND writer of
    // the same config; frozen for the whole operation so no form edit
    // can land between the formBlock sample and the clear-then-set
    // persistence (review #47 round 3, P1). Unfrozen on every exit.
    await deps.freezeSettingsForm();
    try {
        return await composeAndPersistFrozen(deps, args);
    }
    finally {
        await deps.unfreezeSettingsForm();
    }
}
async function composeAndPersistFrozen(deps, args) {
    const cfgArray = await deps.getPluginConfig();
    const blocks = cfgArray.filter(b => b && b.platform === 'AmbientWeatherSensors');
    const digestSession = args.baseDigest !== undefined;
    if (digestSession) {
        if (typeof args.baseDigest !== 'string' || args.baseDigest.length === 0) {
            return {
                ok: false,
                error: {
                    code: 'stale-base',
                    message: 'The editor session token is missing or malformed; reload and retry.',
                },
            };
        }
        // Exactly-one-block invariant (review #47 P1-2): the token
        // identifies a block by CONTENT while this array is replaced by
        // POSITION — with more than one block those can disagree, and a
        // wrong position would overwrite another Home's configuration.
        // The server refuses multi-block configs too; this is the
        // client-side half, checked before any request is made.
        if (blocks.length !== 1) {
            return {
                ok: false,
                error: {
                    code: 'ambiguous-platform-block',
                    message: `${blocks.length} AmbientWeatherSensors platform blocks exist (a multi-Home setup; see MultiHome.md). `
                        + 'The sensor-map editor supports exactly one block, so it is read-only here. Edit sensorMap in the '
                        + 'JSON config editor instead.',
                },
            };
        }
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
    // getPluginConfig() array. In a digest session the position is
    // DERIVED here — the single plugin block's index — never taken from
    // the client-supplied blockIndex (review #47 P1-2: a forged or
    // drifted index would compose one block and replace another); the
    // supplied value is only cross-checked and refused on disagreement.
    // The array's CONTENT is form-mutated and untrustworthy — the
    // server does the real staleness check against disk via the digest.
    // In the legacy base flow the block is located by deep equality
    // (review #67 P1-3): a separately deserialized base is never
    // reference-equal, and indexOf would silently APPEND the composed
    // block as a duplicate.
    let index;
    if (digestSession) {
        index = cfgArray.findIndex(b => b && b.platform === 'AmbientWeatherSensors');
        if (args.blockIndex !== undefined && args.blockIndex !== index) {
            return {
                ok: false,
                error: {
                    code: 'stale-base',
                    message: 'The editor session token no longer matches the plugin config layout; reload and retry.',
                },
            };
        }
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
        // The in-memory block, so the server can refuse when the settings
        // form holds UNSAVED user changes this save would discard
        // (review #47 P1-1).
        formBlock: digestSession ? cfgArray[index] : undefined,
        proposal: args.proposal,
        cachedAccessoryUniqueIds,
        liveStations: args.liveStations,
        confirmDigest: args.confirmDigest,
    });
    if (!result || result.ok !== true) {
        // Refusal or malformed response: NO update, NO save.
        return result ?? { ok: false, error: { code: 'invalid-proposal', message: 'Empty response from /compose-save.' } };
    }
    // Defense-in-depth behind the client-cooperative freeze: re-read the
    // in-memory config and refuse if ANYTHING changed while the compose
    // ran — an edit that raced the save would otherwise be erased by the
    // clear-then-set below, with a clean-looking receipt.
    const recheck = await deps.getPluginConfig();
    if (deepJson(recheck) !== deepJson(cfgArray)) {
        return {
            ok: false,
            error: {
                code: 'unsaved-settings-changes',
                message: 'The plugin settings changed while the save was running. Review the settings form and retry; '
                    + 'nothing was written.',
            },
        };
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

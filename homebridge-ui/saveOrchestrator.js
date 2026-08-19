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
 * not handed to HB UI X until the server has durably written (or
 * verified) the immutable legacy snapshot. Any compose refusal or
 * failure produces ZERO update/save calls.
 *
 * Framework-free and dependency-injected so the integration suite can
 * drive it against the REAL handler with an event-logging fake of the
 * HB UI X client API. Only type imports reference server code (erased
 * at compile time; safe in the browser).
 */
export async function composeAndPersist(deps, args) {
    const cfgArray = await deps.getPluginConfig();
    const blocks = cfgArray.filter(b => b && b.platform === 'AmbientWeatherSensors');
    let base = args.base;
    if (base === undefined) {
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
    const result = await deps.request('/compose-save', {
        base,
        proposal: args.proposal,
        cachedAccessoryUniqueIds,
        liveStations: args.liveStations,
    });
    if (!result || result.ok !== true) {
        // Refusal or malformed response: NO update, NO save.
        return result ?? { ok: false, error: { code: 'invalid-proposal', message: 'Empty response from /compose-save.' } };
    }
    // Replace the edited block with the composed config, positionally.
    const index = cfgArray.indexOf(base);
    const nextArray = index >= 0
        ? cfgArray.map((b, i) => (i === index ? result.nextConfig : b))
        : [...cfgArray.filter(b => b !== base), result.nextConfig];
    await deps.updatePluginConfig(nextArray);
    await deps.savePluginConfig();
    return result;
}

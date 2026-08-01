import { loadConfig } from "./loadConfig.js";
import type { DaemonSettings, LoadConfigOptions, PartialRigConfig } from "./types.js";
import { updateRuntimeConfig } from "./updateRuntimeConfig.js";

export async function writeDaemonSettings(
    settings: Pick<DaemonSettings, "codexStreamMaxRetries" | "durableGlobalEventQueue">,
    options: LoadConfigOptions = {},
): Promise<void> {
    const loaded = await loadConfig(options);
    await updateRuntimeConfig(loaded.paths.runtime, async () => {
        const runtime = (await loadConfig(options)).sources.runtime.values;
        return {
            ...(runtime.defaults === undefined ? {} : { defaults: runtime.defaults }),
            ...(runtime.presence === undefined ? {} : { presence: runtime.presence }),
            ...(runtime.providerDefaultEnable === undefined
                ? {}
                : { providerDefaultEnable: runtime.providerDefaultEnable }),
            ...(runtime.providers === undefined ? {} : { providers: runtime.providers }),
            ...(runtime.theme === undefined ? {} : { theme: runtime.theme }),
            settings: {
                ...runtime.settings,
                codexStreamMaxRetries: settings.codexStreamMaxRetries,
                durableGlobalEventQueue: settings.durableGlobalEventQueue,
            },
        } satisfies PartialRigConfig;
    });
}

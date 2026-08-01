import { loadConfig } from "./loadConfig.js";
import type { LoadConfigOptions, PartialConfigPresence, PartialRigConfig } from "./types.js";
import { updateRuntimeConfig } from "./updateRuntimeConfig.js";

export interface PresenceSelectionToWrite {
    fallbackPresenceId?: string;
    presenceId: string;
    until?: number;
}

/** Remembers which presence the user chose, so a daemon restart does not put them back Online. */
export async function writePresenceSelection(
    selection: PresenceSelectionToWrite,
    options: LoadConfigOptions = {},
): Promise<void> {
    const loaded = await loadConfig(options);
    await updateRuntimeConfig(loaded.paths.runtime, async () => {
        const runtime = (await loadConfig(options)).sources.runtime.values;
        const presence: PartialConfigPresence = {
            current: selection.presenceId,
            ...(selection.fallbackPresenceId === undefined
                ? {}
                : { fallback: selection.fallbackPresenceId }),
            ...(runtime.presence?.states === undefined ? {} : { states: runtime.presence.states }),
            ...(selection.until === undefined ? {} : { until: selection.until }),
        };
        return { ...runtime, presence } satisfies PartialRigConfig;
    });
}

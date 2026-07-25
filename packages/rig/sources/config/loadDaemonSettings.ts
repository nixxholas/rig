import { loadConfig } from "./loadConfig.js";
import type { DaemonSettings, LoadConfigOptions } from "./types.js";

export async function loadDaemonSettings(options: LoadConfigOptions = {}): Promise<DaemonSettings> {
    const loaded = await loadConfig(options);
    return {
        daemonHeapSnapshots: loaded.config.settings.daemonHeapSnapshots,
        durableGlobalEventQueue: loaded.config.settings.durableGlobalEventQueue,
    };
}

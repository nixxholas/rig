import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { errorToMessage } from "../errorToMessage.js";
import { readPluginManifest } from "./readPluginManifest.js";
import type { PluginDiscovery } from "./types.js";

const MAX_INSTALLED_PLUGINS = 64;

export async function discoverPlugins(directory: string): Promise<PluginDiscovery> {
    await mkdir(directory, { mode: 0o755, recursive: true });
    const installed = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name));
    const entries = installed.slice(0, MAX_INSTALLED_PLUGINS);
    const overflowFailures = installed.slice(MAX_INSTALLED_PLUGINS).map((entry) => ({
        directory: join(directory, entry.name),
        error: `Rig loads at most ${String(MAX_INSTALLED_PLUGINS)} installed plugins.`,
        folderName: entry.name,
    }));
    const settled = await Promise.all(
        entries.map(async (entry) => {
            const pluginDirectory = join(directory, entry.name);
            try {
                return { plugin: await readPluginManifest(pluginDirectory) } as const;
            } catch (error) {
                return {
                    failure: {
                        directory: pluginDirectory,
                        error: errorToMessage(error),
                        folderName: entry.name,
                    },
                } as const;
            }
        }),
    );
    return {
        plugins: settled.flatMap((entry) => ("plugin" in entry ? [entry.plugin] : [])),
        failures: [
            ...settled.flatMap((entry) => ("failure" in entry ? [entry.failure] : [])),
            ...overflowFailures,
        ],
    };
}

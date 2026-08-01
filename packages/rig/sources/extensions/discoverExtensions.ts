import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { errorToMessage } from "../errorToMessage.js";
import { readExtensionManifest } from "./readExtensionManifest.js";
import type { ExtensionDiscovery } from "./types.js";

const MAX_INSTALLED_EXTENSIONS = 64;

export async function discoverExtensions(directory: string): Promise<ExtensionDiscovery> {
    await mkdir(directory, { mode: 0o755, recursive: true });
    const installed = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name));
    const entries = installed.slice(0, MAX_INSTALLED_EXTENSIONS);
    const overflowFailures = installed.slice(MAX_INSTALLED_EXTENSIONS).map((entry) => ({
        directory: join(directory, entry.name),
        error: `Rig loads at most ${String(MAX_INSTALLED_EXTENSIONS)} installed extensions.`,
        folderName: entry.name,
    }));
    const settled = await Promise.all(
        entries.map(async (entry) => {
            const extensionDirectory = join(directory, entry.name);
            try {
                return { extension: await readExtensionManifest(extensionDirectory) } as const;
            } catch (error) {
                return {
                    failure: {
                        directory: extensionDirectory,
                        error: errorToMessage(error),
                        folderName: entry.name,
                    },
                } as const;
            }
        }),
    );
    return {
        extensions: settled.flatMap((entry) => ("extension" in entry ? [entry.extension] : [])),
        failures: [
            ...settled.flatMap((entry) => ("failure" in entry ? [entry.failure] : [])),
            ...overflowFailures,
        ],
    };
}

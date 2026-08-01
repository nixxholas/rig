import { open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { createPrivateConfigurationDirectory } from "./createPrivateConfigurationDirectory.js";
import { getDefaultGlobalConfigPath } from "./getDefaultGlobalConfigPath.js";
import { getGlobalAgentsMdPath } from "./getGlobalAgentsMdPath.js";

export async function ensureUserConfigurationFiles(
    options: {
        agentsPath?: string;
        configPath?: string;
    } = {},
): Promise<void> {
    const configPath = options.configPath ?? getDefaultGlobalConfigPath();
    const agentsPath = options.agentsPath ?? getGlobalAgentsMdPath();
    const directories = [...new Set([dirname(configPath), dirname(agentsPath)])];

    await Promise.all(
        directories.map((directory) => createPrivateConfigurationDirectory(directory)),
    );
    await Promise.all([
        writeFileIfMissing(configPath, () =>
            readFile(new URL("./happy.template.toml", import.meta.url), "utf8"),
        ),
        writeFileIfMissing(agentsPath, () => Promise.resolve("")),
    ]);
}

async function writeFileIfMissing(
    path: string,
    loadContents: () => Promise<string>,
): Promise<void> {
    let file;
    try {
        file = await open(path, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
    }

    try {
        await file.writeFile(await loadContents(), { encoding: "utf8" });
    } catch (error) {
        await file.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
    }
    try {
        await file.close();
    } catch (error) {
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
    }
}

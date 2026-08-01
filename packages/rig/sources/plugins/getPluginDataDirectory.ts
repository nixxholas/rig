import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The writable folder a plugin owns. Plugin code is installed out of sight, so this is the one
 * place a person opens to see what a plugin keeps.
 */
export function getPluginDataDirectory(
    folderName: string,
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    return join(getPluginDataRoot(environment, homeDirectory, platform), folderName);
}

export function getPluginDataRoot(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configured = environment.HAPPY_PLUGIN_DATA_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("HAPPY_PLUGIN_DATA_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Plugins")
        : join(homeDirectory, "happy", "plugins");
}

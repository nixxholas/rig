import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function getExtensionsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configured = environment.RIG_EXTENSIONS_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("RIG_EXTENSIONS_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    const configuredRigHome = environment.RIG_HOME?.trim();
    if (configuredRigHome) {
        if (!isAbsolute(configuredRigHome)) {
            throw new Error("RIG_HOME must be an absolute path.");
        }
        return join(
            dirname(resolve(configuredRigHome)),
            platform === "darwin" ? "Extensions" : "extensions",
        );
    }
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Extensions")
        : join(homeDirectory, "happy", "extensions");
}

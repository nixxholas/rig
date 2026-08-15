import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The user-visible folder agent-created applets live in. Each applet is one kebab-case-named
 * folder of static files inside it.
 */
export function getAppletsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configured = environment.HAPPY_APPLETS_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("HAPPY_APPLETS_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Applets")
        : join(homeDirectory, "happy", "applets");
}

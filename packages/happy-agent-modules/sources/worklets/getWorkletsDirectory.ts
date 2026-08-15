import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The user-visible folder installed worklets live in. Each worklet is one
 * kebab-case-named folder holding its icon, its durable `Data`, and one folder
 * per version (`v1`, `v2`, ...).
 *
 * The location mirrors the applet folder: `~/Happy/Worklets` on macOS and
 * `~/happy/worklets` everywhere else, overridable with
 * `HAPPY_WORKLETS_DIRECTORY` for hosts that place user data elsewhere.
 */
export function getWorkletsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configured = environment.HAPPY_WORKLETS_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("HAPPY_WORKLETS_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Worklets")
        : join(homeDirectory, "happy", "worklets");
}

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The user-visible folder installed worklets live in. Each worklet is one kebab-case-named folder
 * holding its icon, its imported `v1`, `v2`, ... versions, and the `Data` folder it writes into.
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

/** The one folder a worklet may write into. It survives every version change. */
export function getWorkletDataDirectory(
    name: string,
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return join(getWorkletsDirectory(environment), name, "Data");
}

/** Where one imported version of a worklet's code lives. */
export function getWorkletVersionDirectory(
    name: string,
    version: number,
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return join(getWorkletsDirectory(environment), name, `v${String(version)}`);
}

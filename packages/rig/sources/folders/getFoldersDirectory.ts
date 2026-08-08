import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The user-visible folder holding every folder's files. Storage is flat: each folder in the tree
 * owns one directory named after its opaque id inside this one.
 */
export function getFoldersDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configured = environment.HAPPY_FOLDERS_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("HAPPY_FOLDERS_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Folders")
        : join(homeDirectory, "happy", "folders");
}

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** User-visible storage shared by generated images and attachment previews. */
export function getGeneratedDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configured = environment.HAPPY_GENERATED_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("HAPPY_GENERATED_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Generated")
        : join(homeDirectory, "happy", "generated");
}

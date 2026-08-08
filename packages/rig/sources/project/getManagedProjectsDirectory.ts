import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function getManagedProjectsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configuredDirectory = environment.RIG_PROJECTS_DIRECTORY?.trim();
    if (configuredDirectory) {
        if (!isAbsolute(configuredDirectory)) {
            throw new Error("RIG_PROJECTS_DIRECTORY must be an absolute path.");
        }
        return resolve(configuredDirectory);
    }
    return join(homeDirectory, "Projects");
}

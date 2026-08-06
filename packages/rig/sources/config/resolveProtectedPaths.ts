import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseConfigToml } from "./parseConfigToml.js";
import { PROJECT_CONFIG_FILE_NAMES } from "./projectConfigFileNames.js";

export function resolveProtectedPaths(
    cwd: string,
    machineProtectedPaths: readonly string[],
): readonly string[] {
    const paths = new Set(machineProtectedPaths);
    const values = readProjectConfigValues(cwd);
    for (const path of values?.permissions?.protectedPaths ?? []) {
        paths.add(path);
    }
    // A protected sync file stays read-only in the workspace it was replicated into.
    for (const path of values?.workspace?.protectedSync ?? []) {
        paths.add(path);
    }
    return [...paths].filter((path) => existsSync(resolve(cwd, path)));
}

/** Reads the first project configuration file present, matching `readProjectConfigFile`. */
function readProjectConfigValues(cwd: string): ReturnType<typeof parseConfigToml> | undefined {
    for (const name of PROJECT_CONFIG_FILE_NAMES) {
        try {
            return parseConfigToml(readFileSync(join(cwd, name), "utf8"));
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
            ) {
                continue;
            }
            throw error;
        }
    }
    return undefined;
}

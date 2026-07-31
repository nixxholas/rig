import { resolve } from "node:path";

import { PROJECT_CONFIG_FILE_NAMES } from "../../config/projectConfigFileNames.js";

export function isProtectedProjectConfigPath(cwd: string, targetPath: string): boolean {
    const requestedPath = resolve(targetPath);
    return PROJECT_CONFIG_FILE_NAMES.some((name) => requestedPath === resolve(cwd, name));
}

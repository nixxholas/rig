import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { getRigHome } from "../config/getRigHome.js";

/** The managed root that holds every installed plugin's code and generated build state. */
export function getPluginsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configured = environment.HAPPY_PLUGINS_DIRECTORY?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new Error("HAPPY_PLUGINS_DIRECTORY must be an absolute path.");
        }
        return resolve(configured);
    }
    return join(getRigHome(environment, homeDirectory), "plugins");
}

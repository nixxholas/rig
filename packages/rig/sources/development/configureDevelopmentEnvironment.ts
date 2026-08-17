import { join } from "node:path";

import { getDevelopmentBuildId } from "./getDevelopmentBuildId.js";

export async function configureDevelopmentEnvironment(options: {
    environment?: NodeJS.ProcessEnv;
    repositoryRoot: string;
}): Promise<void> {
    const environment = options.environment ?? process.env;
    const developmentDirectory = join(options.repositoryRoot, ".rig-dev");
    // A terminal opened by Rig may inherit the running daemon's home. Development must replace
    // that coordinate or it can mistake the global daemon for this checkout's stale daemon and
    // shut it down. The Happy home derives every daemon-owned path, including its database.
    environment.HAPPY_HOME_DIR = join(developmentDirectory, ".happy");
    environment.RIG_DEVELOPMENT_BUILD_ID ??= await getDevelopmentBuildId(options.repositoryRoot);
}

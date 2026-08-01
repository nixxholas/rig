import { join } from "node:path";

import { getHappyConfigDirectory } from "./getHappyConfigDirectory.js";

/** The user's own AGENTS.md, kept beside the rest of Rig's configuration. */
export function getGlobalAgentsMdPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getHappyConfigDirectory(env, homeDirectory), "AGENTS.md");
}

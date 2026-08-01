import { join } from "node:path";

import { getRigHome } from "./getRigHome.js";

/** The user's own AGENTS.md, kept beside the rest of Rig's configuration. */
export function getGlobalAgentsMdPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getRigHome(env, homeDirectory), "AGENTS.md");
}

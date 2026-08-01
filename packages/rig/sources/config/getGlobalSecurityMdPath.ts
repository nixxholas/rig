import { join } from "node:path";

import { getHappyConfigDirectory } from "./getHappyConfigDirectory.js";

/** The user's permission-review policy, kept beside the rest of Rig's configuration. */
export function getGlobalSecurityMdPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getHappyConfigDirectory(env, homeDirectory), "SECURITY.md");
}

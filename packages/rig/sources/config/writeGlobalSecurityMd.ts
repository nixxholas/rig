import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createPrivateConfigurationDirectory } from "./createPrivateConfigurationDirectory.js";
import { getGlobalSecurityMdPath } from "./getGlobalSecurityMdPath.js";
import { GLOBAL_SECURITY_MD_MAX_BYTES } from "./globalSecurityMdMaxBytes.js";

/**
 * Replaces the user's global SECURITY.md. Blank text leaves an empty file, which restores the
 * bundled permission-review policy.
 */
export async function writeGlobalSecurityMd(
    policy: string,
    path: string = getGlobalSecurityMdPath(),
): Promise<void> {
    if (Buffer.byteLength(policy, "utf8") > GLOBAL_SECURITY_MD_MAX_BYTES) {
        throw new Error(
            `Global security policy must be smaller than ${GLOBAL_SECURITY_MD_MAX_BYTES / 1024} KB.`,
        );
    }

    await createPrivateConfigurationDirectory(dirname(path));
    await writeFile(path, policy.trim().length === 0 ? "" : policy, {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(path, 0o600);
}

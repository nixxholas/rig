import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createPrivateConfigurationDirectory } from "./createPrivateConfigurationDirectory.js";
import { getGlobalAgentsMdPath } from "./getGlobalAgentsMdPath.js";
import { GLOBAL_AGENTS_MD_MAX_BYTES } from "./globalAgentsMdMaxBytes.js";

/**
 * Replaces the user's global AGENTS.md. Blank instructions leave an empty file, which the reader
 * treats as no global instructions.
 */
export async function writeGlobalAgentsMd(
    instructions: string,
    path: string = getGlobalAgentsMdPath(),
): Promise<void> {
    if (Buffer.byteLength(instructions, "utf8") > GLOBAL_AGENTS_MD_MAX_BYTES) {
        throw new Error(
            `Global instructions must be smaller than ${GLOBAL_AGENTS_MD_MAX_BYTES / 1024} KB.`,
        );
    }

    const directory = dirname(path);
    await createPrivateConfigurationDirectory(directory);
    await writeFile(path, instructions.trim().length === 0 ? "" : instructions, {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(path, 0o600);
}

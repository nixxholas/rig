import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getGlobalAgentsMdPath } from "./getGlobalAgentsMdPath.js";
import { GLOBAL_AGENTS_MD_MAX_BYTES } from "./globalAgentsMdMaxBytes.js";

/**
 * Replaces the user's global AGENTS.md. Blank instructions remove the file, so clearing the text
 * is how a user says they no longer have global instructions.
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

    if (instructions.trim().length === 0) {
        await rm(path, { force: true });
        return;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, instructions, "utf8");
}

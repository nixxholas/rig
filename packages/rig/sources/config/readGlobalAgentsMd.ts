import { readFile } from "node:fs/promises";

import { getGlobalAgentsMdPath } from "./getGlobalAgentsMdPath.js";
import { GLOBAL_AGENTS_MD_MAX_BYTES } from "./globalAgentsMdMaxBytes.js";

/**
 * Reads the user's global AGENTS.md. It is read again before every turn, so an edit made while a
 * session is open reaches the model without restarting anything. A missing or blank file simply
 * means the user has no global instructions.
 */
export async function readGlobalAgentsMd(
    path: string = getGlobalAgentsMdPath(),
): Promise<string | undefined> {
    let buffer: Buffer;
    try {
        buffer = await readFile(path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
        throw error;
    }

    const truncated =
        buffer.byteLength > GLOBAL_AGENTS_MD_MAX_BYTES
            ? buffer.subarray(0, GLOBAL_AGENTS_MD_MAX_BYTES)
            : buffer;
    const text = truncated.toString("utf8");

    return text.trim().length > 0 ? text : undefined;
}

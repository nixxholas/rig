import { readFile } from "node:fs/promises";

import { getGlobalSecurityMdPath } from "./getGlobalSecurityMdPath.js";
import { GLOBAL_SECURITY_MD_MAX_BYTES } from "./globalSecurityMdMaxBytes.js";

/**
 * Reads the user's global SECURITY.md. It is read again before every permission review, so an edit
 * made while a session is open takes effect without restarting the session.
 */
export async function readGlobalSecurityMd(
    path: string = getGlobalSecurityMdPath(),
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
        buffer.byteLength > GLOBAL_SECURITY_MD_MAX_BYTES
            ? buffer.subarray(0, GLOBAL_SECURITY_MD_MAX_BYTES)
            : buffer;
    const text = truncated.toString("utf8");

    return text.trim().length > 0 ? text : undefined;
}

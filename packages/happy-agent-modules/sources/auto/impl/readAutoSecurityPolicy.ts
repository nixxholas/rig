import { Buffer } from "node:buffer";

/**
 * Assembles the user's security policy for one review, ported from Rig v1's
 * `createCodingAssistantAgent.ts` reviewer `readSecurityPolicy`. The global `SECURITY.md` and the
 * project-root `AGENTS_SECURITY.md` are read again before every review, so an edit made while a
 * session is open takes effect on the next review without restarting anything.
 *
 * Each file is bounded to 32 KiB and dropped when blank, matching v1's `readGlobalSecurityMd` and
 * `readProjectSecurityMd`. A missing file, or a path that turns out not to be a readable file, is
 * treated as absent; any other read error is left to propagate so the caller can make the review
 * unavailable rather than review against a partial policy. The two present files are joined under
 * the exact v1 headings, and the combined text becomes the "user security policy" section the
 * guardian prompt appends after its built-in policy.
 */

/** Keeps each configured security file within a predictable prompt budget, as in v1. */
export const AUTO_SECURITY_MD_MAX_BYTES = 32 * 1024;

export const GLOBAL_SECURITY_HEADING = "## Global SECURITY.md";
export const PROJECT_SECURITY_HEADING = "## Project AGENTS_SECURITY.md";

/** Filesystem errors that mean the security file is simply not there, rather than unreadable. */
export const SECURITY_MISSING_FILE_CODES: readonly string[] = ["ENOENT", "ENOTDIR", "EISDIR"];

/**
 * Applies the 32 KiB bound and drops blank content. Returns the decoded text, or `undefined` when
 * the file has no non-whitespace content, matching v1's file readers byte-for-byte.
 */
export function boundSecurityFileText(buffer: Uint8Array): string | undefined {
    const truncated =
        buffer.byteLength > AUTO_SECURITY_MD_MAX_BYTES
            ? buffer.subarray(0, AUTO_SECURITY_MD_MAX_BYTES)
            : buffer;
    const text = Buffer.from(truncated).toString("utf8");
    return text.trim().length > 0 ? text : undefined;
}

/** Whether a caught read error means the security file is absent rather than genuinely unreadable. */
export function isMissingSecurityFileError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code !== undefined && SECURITY_MISSING_FILE_CODES.includes(code);
}

export async function readAutoSecurityPolicy(readers: {
    /** Reads and bounds the global `SECURITY.md`, or resolves `undefined` when it is absent. */
    readGlobalSecurity: () => Promise<string | undefined>;
    /** Reads and bounds the project-root `AGENTS_SECURITY.md`, or `undefined` when absent. */
    readProjectSecurity: () => Promise<string | undefined>;
}): Promise<string | undefined> {
    const [globalPolicy, projectPolicy] = await Promise.all([
        readers.readGlobalSecurity(),
        readers.readProjectSecurity(),
    ]);
    const policies = [
        ...(globalPolicy === undefined ? [] : [`${GLOBAL_SECURITY_HEADING}\n\n${globalPolicy}`]),
        ...(projectPolicy === undefined
            ? []
            : [`${PROJECT_SECURITY_HEADING}\n\n${projectPolicy}`]),
    ];
    return policies.length === 0 ? undefined : policies.join("\n\n");
}

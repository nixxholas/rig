import { AGENTS_MD_REMOVAL_NOTICE, AGENTS_MD_REPLACEMENT_NOTICE } from "./agentsMdNotices.js";
import { createAgentsMdFingerprint } from "./createAgentsMdFingerprint.js";
import type { UserMessage } from "./types.js";

/**
 * Builds the durable record that supersedes project instructions the model was given earlier.
 * Earlier records are never rewritten, so the original instructions stay readable in history.
 */
export function createAgentsMdReplacementMessage(options: {
    id: string;
    instructions?: string;
}): UserMessage {
    const text =
        options.instructions === undefined
            ? AGENTS_MD_REMOVAL_NOTICE
            : `${AGENTS_MD_REPLACEMENT_NOTICE}\n\n${options.instructions}`;

    return {
        agentsMd: {
            fingerprint:
                options.instructions === undefined
                    ? null
                    : createAgentsMdFingerprint(options.instructions),
        },
        blocks: [{ type: "text", text }],
        id: options.id,
        internal: true,
        role: "user",
    };
}

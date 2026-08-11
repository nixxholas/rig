import { createAgentsMdFingerprint } from "./createAgentsMdFingerprint.js";
import { createAgentsMdMessage } from "./createAgentsMdMessage.js";
import { createAgentsMdReplacementMessage } from "./createAgentsMdReplacementMessage.js";
import type { FileSystemContext } from "../context/FileSystemContext.js";
import { findLatestAgentsMdRecord } from "./findLatestAgentsMdRecord.js";
import { loadAgentsMdInstructions } from "./loadAgentsMdInstructions.js";
import type { Message } from "../types.js";

/**
 * Keeps the model's view of the user's global and the project's instructions current.
 *
 * The first record leads the conversation so the instructions arrive before anything the user
 * asked for, and stays byte-identical while the file is unchanged so the cached prefix survives.
 * Later edits are recorded as superseding records ahead of the turn the user is waiting on, so
 * the request stays the last thing the model reads; nothing already recorded is rewritten.
 */
export async function reconcileAgentsMdMessages(options: {
    fs: FileSystemContext;
    /** The user's global AGENTS.md, read fresh for this turn. */
    globalInstructions?: string;
    idFactory: () => string;
    messages: readonly Message[];
}): Promise<readonly Message[]> {
    const instructions = await loadAgentsMdInstructions(options.fs, {
        ...(options.globalInstructions === undefined
            ? {}
            : { globalInstructions: options.globalInstructions }),
    });
    const fingerprint = instructions === undefined ? null : createAgentsMdFingerprint(instructions);
    const record = findLatestAgentsMdRecord(options.messages);

    if (record === undefined) {
        if (instructions === undefined) return options.messages;

        return [
            createAgentsMdMessage({ id: options.idFactory(), instructions }),
            ...options.messages,
        ];
    }

    if (record.agentsMd.fingerprint === fingerprint) return options.messages;

    const pending = pendingRequestIndex(options.messages);

    return [
        ...options.messages.slice(0, pending),
        createAgentsMdReplacementMessage({
            id: options.idFactory(),
            ...(instructions === undefined ? {} : { instructions }),
        }),
        ...options.messages.slice(pending),
    ];
}

/**
 * Finds where the unanswered user messages of this turn begin. Recording the new instructions
 * after them would leave the model looking at project instructions as the newest thing said,
 * which reads as a turn with nothing asked of it.
 */
function pendingRequestIndex(messages: readonly Message[]): number {
    let index = messages.length;
    while (index > 0) {
        const message = messages[index - 1];
        if (message?.role !== "user" || message.internal === true) break;
        index -= 1;
    }

    return index;
}

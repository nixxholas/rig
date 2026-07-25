import { createAgentsMdFingerprint } from "./createAgentsMdFingerprint.js";
import { createAgentsMdMessage } from "./createAgentsMdMessage.js";
import { createAgentsMdReplacementMessage } from "./createAgentsMdReplacementMessage.js";
import type { FileSystemContext } from "./context/FileSystemContext.js";
import { findLatestAgentsMdRecord } from "./findLatestAgentsMdRecord.js";
import { loadAgentsMdInstructions } from "./loadAgentsMdInstructions.js";
import type { Message } from "./types.js";

/**
 * Keeps the model's view of the project instructions current.
 *
 * The first record leads the conversation so the instructions arrive before anything the user
 * asked for, and stays byte-identical while the file is unchanged so the cached prefix survives.
 * Later edits are appended as superseding records; nothing already recorded is rewritten.
 */
export async function reconcileAgentsMdMessages(options: {
    fs: FileSystemContext;
    idFactory: () => string;
    messages: readonly Message[];
}): Promise<readonly Message[]> {
    const instructions = await loadAgentsMdInstructions(options.fs);
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

    return [
        ...options.messages,
        createAgentsMdReplacementMessage({
            id: options.idFactory(),
            ...(instructions === undefined ? {} : { instructions }),
        }),
    ];
}

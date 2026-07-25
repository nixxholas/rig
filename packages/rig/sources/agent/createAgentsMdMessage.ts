import { createAgentsMdFingerprint } from "./createAgentsMdFingerprint.js";
import type { UserMessage } from "./types.js";

/** Builds the durable record that first hands the project instructions to the model. */
export function createAgentsMdMessage(options: { id: string; instructions: string }): UserMessage {
    return {
        agentsMd: { fingerprint: createAgentsMdFingerprint(options.instructions) },
        blocks: [{ type: "text", text: options.instructions }],
        id: options.id,
        internal: true,
        role: "user",
    };
}

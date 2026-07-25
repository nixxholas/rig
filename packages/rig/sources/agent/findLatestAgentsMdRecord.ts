import type { Message, UserMessage } from "./types.js";

/** Returns the newest project-instruction record, which holds the state the model already saw. */
export function findLatestAgentsMdRecord(
    messages: readonly Message[],
): (UserMessage & { agentsMd: { fingerprint: string | null } }) | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "user" && message.agentsMd !== undefined) {
            return message as UserMessage & { agentsMd: { fingerprint: string | null } };
        }
    }

    return undefined;
}

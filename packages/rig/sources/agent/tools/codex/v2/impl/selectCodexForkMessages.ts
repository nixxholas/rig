import type { AgentMessage, Message } from "../../../../types.js";
import { isExcludedFromModelContext } from "../../../../isExcludedFromModelContext.js";

export function selectCodexForkMessages(
    messages: readonly Message[],
    lastNTurns: number | undefined,
): readonly Message[] {
    const boundaries = messages.flatMap((message, index) =>
        message.role === "user" &&
        (message.provenance !== "agent" || message.agentMessageTriggerTurn === true)
            ? [index]
            : [],
    );
    const selected =
        lastNTurns === undefined
            ? messages
            : messages.slice(
                  boundaries[Math.max(0, boundaries.length - lastNTurns)] ?? messages.length,
              );
    return selected.flatMap((message): readonly Message[] => {
        if (message.role === "system") {
            return isExcludedFromModelContext(message) ? [] : [message];
        }
        if (message.role === "user") {
            return message.provenance === "agent" || message.encryptedAgentMessage !== undefined
                ? []
                : [message];
        }
        if (message.role === "compaction") return [message];
        if (message.role === "error") return isExcludedFromModelContext(message) ? [] : [message];
        const blocks = message.blocks.filter((block) => block.type === "text");
        if (blocks.length === 0) return [];
        const forked = { ...message, blocks } satisfies AgentMessage;
        delete forked.sessionMessage;
        // The checkpoint covers the original prefix, not this projected fork context.
        delete forked.contextTokens;
        return [forked];
    });
}

import { estimateMessagesTokens } from "./estimateMessagesTokens.js";
import type { Message } from "../types.js";

export function resolvePreInferenceContextTokens(messages: readonly Message[]): number | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const checkpoint =
            message?.role === "agent"
                ? message.contextTokens
                : message?.role === "compaction"
                  ? message.statistics.after.tokens
                  : undefined;
        if (checkpoint === undefined) continue;
        return Math.max(0, checkpoint) + estimateMessagesTokens(messages.slice(index + 1));
    }
    return undefined;
}

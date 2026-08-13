import type { HistoryMessage } from "../HistoryMessage.js";

/** What a stretch of history amounts to, in numbers a reader can size it by. */
export interface HistoryStats {
    assistantMessages: number;
    messages: number;
    textCharacters: number;
    thinkingBlocks: number;
    toolCalls: number;
    toolResults: number;
    userMessages: number;
}

/** Count what these messages contain, without reading any of it. */
export function summarizeHistory(messages: readonly HistoryMessage[]): HistoryStats {
    const stats: HistoryStats = {
        assistantMessages: 0,
        messages: messages.length,
        textCharacters: 0,
        thinkingBlocks: 0,
        toolCalls: 0,
        toolResults: 0,
        userMessages: 0,
    };
    for (const message of messages) {
        if (message.role === "user") stats.userMessages += 1;
        if (message.role === "assistant") stats.assistantMessages += 1;
        for (const block of message.blocks) {
            if (block.type === "text") stats.textCharacters += block.text.length;
            if (block.type === "thinking") {
                stats.thinkingBlocks += 1;
                stats.textCharacters += block.thinking.length;
            }
            if (block.type === "tool_call") stats.toolCalls += 1;
            if (block.type === "tool_result") stats.toolResults += 1;
        }
    }
    return stats;
}

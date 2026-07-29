import type { CompactionMessage, Message } from "../types.js";
import type { Usage } from "@slopus/rig-execution";

export function finalizeCompactionMessage(
    contextMessages: Message[],
    transcript: Message[],
    usage: Usage,
): CompactionMessage | undefined {
    const index = contextMessages.findLastIndex(
        (message) => message.role === "compaction" && !message.statistics.after.exact,
    );
    const current = contextMessages[index];
    if (current?.role !== "compaction") return undefined;

    const updated: CompactionMessage = {
        ...current,
        statistics: {
            ...current.statistics,
            after: {
                exact: true,
                tokens: usage.input + usage.cacheRead + usage.cacheWrite,
            },
        },
    };
    contextMessages[index] = updated;
    const transcriptIndex = transcript.findIndex((message) => message.id === updated.id);
    if (transcriptIndex >= 0) transcript[transcriptIndex] = updated;
    return updated;
}
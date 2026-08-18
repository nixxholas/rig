import type { HistoryBlock, HistoryRecord } from "@slopus/happy-agent-modules";

/** How many of the newest history records the second look reads. */
export const MAX_TRANSCRIPT_RECORDS = 24;
/** How much of one message the transcript keeps, so a long paste cannot crowd out the rest. */
const MAX_TRANSCRIPT_BLOCK_CHARS = 2_000;

export interface ConversationLine {
    readonly speaker: "Assistant" | "User";
    readonly text: string;
}

/**
 * The conversation as a reader would see it: who said what, and nothing a title cannot be drawn
 * from.
 *
 * Tool calls, their output and the model's reasoning are left out on purpose. They are most of the
 * bytes and almost none of the subject: a chat about a retry policy looks, in tool traffic, exactly
 * like every other chat that read some files.
 */
export function conversationLines(records: readonly HistoryRecord[]): ConversationLine[] {
    const lines: ConversationLine[] = [];
    for (const { message } of records) {
        // Only the two voices a title is about: what the person asked for, and what the agent
        // said back. A goal continuation or a collaboration hand-off reaches the model wearing
        // the user role without a person having written it, and naming a chat after one of those
        // names it after the machinery rather than the work.
        if (message.role !== "assistant" && message.role !== "user") continue;
        const text = visibleText(message.blocks);
        if (text === undefined) continue;
        lines.push({ speaker: message.role === "assistant" ? "Assistant" : "User", text });
    }
    return lines;
}

/**
 * Adds what the person has just said, unless the history already caught up and holds it.
 *
 * Which of the two happened is a race between the agent writing its history and this reading it,
 * and the answer must be the same either way: the message appears exactly once.
 */
export function withJustSaid(
    lines: readonly ConversationLine[],
    justSaid: string | undefined,
): ConversationLine[] {
    const text = justSaid === undefined ? undefined : boundedText(justSaid);
    if (text === undefined) return [...lines];
    const last = lines[lines.length - 1];
    if (last?.speaker === "User" && last.text === text) return [...lines];
    return [...lines, { speaker: "User", text }];
}

/** Whether anything has been said that the message the chat was named after did not already say. */
export function worthSecondLook(lines: readonly ConversationLine[]): boolean {
    return (
        lines.some((line) => line.speaker === "Assistant") ||
        lines.filter((line) => line.speaker === "User").length > 1
    );
}

function visibleText(blocks: readonly HistoryBlock[]): string | undefined {
    return boundedText(
        blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
    );
}

/** One message, normalized and short enough that a long paste cannot crowd out the rest. */
function boundedText(value: string): string | undefined {
    const text = value
        .replace(/[\r\t]+/gu, " ")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
    if (text.length === 0) return undefined;
    return text.length <= MAX_TRANSCRIPT_BLOCK_CHARS
        ? text
        : `${text.slice(0, MAX_TRANSCRIPT_BLOCK_CHARS - 1)}…`;
}

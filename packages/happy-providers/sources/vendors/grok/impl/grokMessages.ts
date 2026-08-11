import type { SessionMessage } from "@/core/SessionContext.js";

/**
 * Recognition of the message shapes grok-build wraps around conversation turns.
 *
 * A real user turn is wrapped in `<user_query>`, while environment context, reminders, and
 * compaction continuations occupy the same user role and must not be counted as user input.
 */

export function wrapGrokUserQuery(query: string): string {
    return `<user_query>\n${query}\n</user_query>`;
}

export function extractGrokUserQuery(message: SessionMessage): string | undefined {
    if (message.role !== "user") return undefined;
    const content = message.content.trim();
    if (
        content.startsWith("<user_info>") ||
        content.startsWith("<system-reminder>") ||
        content.startsWith("This session is being continued")
    ) {
        return undefined;
    }
    const match = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/u.exec(content);
    return match?.[1]?.trim() ?? content;
}

export function countGrokUserQueries(messages: readonly SessionMessage[]): number {
    return messages.filter((message) => extractGrokUserQuery(message) !== undefined).length;
}

export function findLastGrokUserQuery(
    messages: readonly SessionMessage[],
): SessionMessage | undefined {
    return [...messages].reverse().find((message) => extractGrokUserQuery(message) !== undefined);
}

export function isGrokUserInfoMessage(message: SessionMessage): boolean {
    return message.role === "user" && message.content.trimStart().startsWith("<user_info>");
}

export function isGrokProjectInstructionsMessage(message: SessionMessage): boolean {
    if (message.role !== "user" || !message.content.trimStart().startsWith("<system-reminder>")) {
        return false;
    }
    return /\bAGENTS\.md\b|project instructions/iu.test(message.content);
}

export function isGrokStateReminderMessage(message: SessionMessage): boolean {
    return (
        message.role === "user" &&
        message.content.trimStart().startsWith("<system-reminder>") &&
        !isGrokProjectInstructionsMessage(message)
    );
}

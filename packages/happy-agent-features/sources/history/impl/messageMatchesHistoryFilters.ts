import type { HistoryMessage, HistoryRole } from "../HistoryMessage.js";

/** Whether a message survives the role and text filters a reader asked for. */
export function messageMatchesHistoryFilters(
    message: HistoryMessage,
    options: { query?: string | undefined; roles?: readonly HistoryRole[] | undefined },
): boolean {
    if (options.roles !== undefined && !options.roles.includes(message.role)) return false;
    const query = options.query?.trim().toLocaleLowerCase();
    if (query === undefined || query.length === 0) return true;
    // Search reads the whole stored message, not the bounded rendering a reader is shown, so a
    // hit inside truncated tool output is still findable.
    return searchableParts(message).some((part) => part.toLocaleLowerCase().includes(query));
}

/** Every piece of a message that counts as text a search may match. */
function searchableParts(message: HistoryMessage): string[] {
    const parts: string[] = [];
    for (const block of message.blocks) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "image") parts.push(block.mediaType);
        else if (block.type === "thinking") parts.push(block.thinking);
        else if (block.type === "tool_call") parts.push(block.name, stringify(block.arguments));
        else parts.push(block.toolName, block.display ?? "", block.output);
    }
    return parts;
}

/** Tool arguments as text, or nothing when they cannot be written down. */
function stringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "";
    }
}

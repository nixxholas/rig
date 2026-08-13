import type { HistoryRole } from "./HistoryMessage.js";
import type { HistoryRecord } from "./HistoryStore.js";
import type { HistoryStats } from "./impl/summarizeHistory.js";

/** What a reader is asking for. */
export interface HistoryQuery {
    /** Continue from this position, which came from a previous page's cursor. */
    readonly cursor?: number;
    /** Read the first matching page, or the last one. Cannot be combined with a cursor. */
    readonly from?: "end" | "start";
    /** The most messages to select before the response is bounded by size. */
    readonly limit?: number;
    /** Case-insensitive text to search the whole stored message for. */
    readonly query?: string;
    /** Return only messages in these roles. */
    readonly roles?: readonly HistoryRole[];
    /** Which agent to read. Omitted means the one asking. */
    readonly target?: string;
}

/** One page of history: what matched, what was selected, and how to continue. */
export interface HistoryPage {
    /** The agent this page was read from. */
    readonly agentId: string;
    /** The position this page starts at. */
    readonly cursor: number;
    /** How many messages matched the filters, before the page was cut from them. */
    readonly matchedMessages: number;
    /** What those matching messages amount to. */
    readonly matchedStats: HistoryStats;
    /** The selected messages, chronological. */
    readonly messages: readonly HistoryRecord[];
    /** Where the next page starts, absent at the end. */
    readonly nextCursor?: number;
    /** Where the preceding page starts, absent at the beginning. */
    readonly previousCursor?: number;
    /** How many messages the history holds in total. */
    readonly totalMessages: number;
    /** What the whole history amounts to. */
    readonly totalStats: HistoryStats;
}

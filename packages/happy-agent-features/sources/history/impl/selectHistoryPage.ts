import type { HistoryQuery, HistoryPage } from "../HistoryPage.js";
import type { HistoryRecord } from "../HistoryStore.js";
import { messageMatchesHistoryFilters } from "./messageMatchesHistoryFilters.js";
import { summarizeHistory } from "./summarizeHistory.js";

/** The part of a page that depends only on the records and the query. */
export type SelectedHistoryPage = Omit<HistoryPage, "agentId">;

/**
 * Cut one page out of an agent's history.
 *
 * Filtering happens first and paging second, so a cursor always names a real position in the
 * whole history rather than an offset into a particular search. That is what lets a reader
 * change its mind — narrow the query, ask for the page before — without the positions it
 * already has meaning something else.
 */
export function selectHistoryPage(
    records: readonly HistoryRecord[],
    options: HistoryQuery,
): SelectedHistoryPage {
    if (options.cursor !== undefined && options.from !== undefined) {
        throw new Error("Use either cursor or from, not both.");
    }
    const limit = Math.max(1, options.limit ?? 100);
    const matched = records.filter((record) =>
        messageMatchesHistoryFilters(record.message, options),
    );
    const first = records[0]?.position ?? 0;
    const end = (records.at(-1)?.position ?? first - 1) + 1;
    const anchor = Math.min(Math.max(options.cursor ?? first, first), end);
    const start =
        options.from === "end"
            ? Math.max(0, matched.length - limit)
            : matched.findIndex((record) => record.position >= anchor);
    const startIndex = start < 0 ? matched.length : start;
    const selected = matched.slice(startIndex, startIndex + limit);
    const cursor = selected[0]?.position ?? (options.from === "end" ? end : anchor);
    const next = matched[startIndex + selected.length];
    const previous = matched[Math.max(0, startIndex - limit)];
    return {
        cursor,
        matchedMessages: matched.length,
        matchedStats: summarizeHistory(matched.map((record) => record.message)),
        messages: selected,
        ...(next === undefined ? {} : { nextCursor: next.position }),
        ...(startIndex === 0 || previous === undefined
            ? {}
            : { previousCursor: previous.position }),
        totalMessages: records.length,
        totalStats: summarizeHistory(records.map((record) => record.message)),
    };
}

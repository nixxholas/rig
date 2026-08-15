import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { historyAgentIdSchema, MAX_HISTORY_PAGE_SIZE } from "./HistoryMessage.js";
import {
    historyPageSchema,
    type HistoryPage,
    type HistoryQuery,
    type HistoryRecord,
} from "./HistoryPage.js";
import { historyStatsSchema, type HistoryStats } from "./impl/summarizeHistory.js";

/**
 * The small cross-module surface needed by ModelSwitch. A structural reader keeps model handoff
 * independent from the concrete history implementation and lets hosts provide a read-only view.
 */
export const historyReaderSchema = Type.Object(
    {
        messages: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                historyAgentIdSchema,
                Type.Object(
                    {
                        from: Type.Optional(
                            Type.Union([Type.Literal("end"), Type.Literal("start")]),
                        ),
                        limit: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_HISTORY_PAGE_SIZE }),
                        ),
                    },
                    { additionalProperties: false },
                ),
            ],
            Type.Promise(Type.Array(Type.Unknown())),
        ),
        stats: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                historyAgentIdSchema,
            ],
            Type.Promise(historyStatsSchema),
        ),
    },
    { additionalProperties: true },
);

export type HistoryReader = {
    readonly messages: (
        ctx: Context,
        agentId: string,
        query: Pick<HistoryQuery, "from" | "limit">,
    ) => Promise<readonly HistoryRecord[]>;
    readonly stats: (ctx: Context, agentId: string) => Promise<HistoryStats>;
};

export function assertHistoryReader(value: unknown): asserts value is HistoryReader {
    if (!Value.Check(historyReaderSchema, value)) {
        throw new Error("The model switch history reader is invalid.");
    }
}

// Keep these exports near the contract so structural consumers can validate pages/results too.
export { historyPageSchema };
export type { HistoryPage, HistoryQuery, HistoryStats };

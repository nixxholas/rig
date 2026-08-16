import { Type, type Static } from "@sinclair/typebox";

import {
    historyAgentIdSchema,
    MAX_HISTORY_AGENT_ID_LENGTH,
    MAX_HISTORY_TOTAL_MESSAGES,
} from "./HistoryMessage.js";

/** Maximum number of related agents one history response may describe. */
export const MAX_HISTORY_AGENT_SUMMARIES = 256;
/** Maximum characters in a path supplied by the host roster. */
export const MAX_HISTORY_AGENT_PATH_LENGTH = 1_024;
/** Maximum characters in a host-provided agent description. */
export const MAX_HISTORY_AGENT_DESCRIPTION_LENGTH = 4_000;
/** Maximum characters in a host-provided agent status. */
export const MAX_HISTORY_AGENT_STATUS_LENGTH = 256;

const historyAgentPathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HISTORY_AGENT_PATH_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const historyAgentDescriptionSchema = Type.String({
    maxLength: MAX_HISTORY_AGENT_DESCRIPTION_LENGTH,
});

const historyAgentStatusSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HISTORY_AGENT_STATUS_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/** One agent in the session tree visible to a history reader. */
export const historyAgentSummarySchema = Type.Object(
    {
        agentId: historyAgentIdSchema,
        description: Type.Optional(historyAgentDescriptionSchema),
        messageCount: Type.Integer({
            minimum: 0,
            maximum: MAX_HISTORY_TOTAL_MESSAGES,
        }),
        path: historyAgentPathSchema,
        status: historyAgentStatusSchema,
    },
    { additionalProperties: false },
);

/** A bounded roster page supplied by the host for one history response. */
export const historyAgentSummariesSchema = Type.Array(historyAgentSummarySchema, {
    maxItems: MAX_HISTORY_AGENT_SUMMARIES,
});

/** The TypeScript type inferred from {@link historyAgentSummarySchema}. */
export type HistoryAgentSummary = Static<typeof historyAgentSummarySchema>;

/** The TypeScript type inferred from {@link historyAgentSummariesSchema}. */
export type HistoryAgentSummaries = Static<typeof historyAgentSummariesSchema>;

/**
 * A stable target accepted by the history tool. It may be an Agent ID or a canonical host path;
 * the host resolver decides which one it denotes.
 */
export const historyAgentTargetSchema = Type.String({
    description:
        "Stable Agent ID or canonical session-tree path. The host resolves paths and reports missing or ambiguous targets.",
    minLength: 1,
    maxLength: Math.max(MAX_HISTORY_AGENT_ID_LENGTH, MAX_HISTORY_AGENT_PATH_LENGTH),
    pattern: "^[^\\u0000\\r\\n]+$",
});

/**
 * Usage: what was consumed, never summarized across models.
 *
 * Tokens from different models are not comparable quantities, so the breakdown
 * is always by provider and then by model; a client wanting a rollup computes
 * its own.
 */

/** Token counts for one model. */
export interface ModelUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Provider key, then model ID, then the counts. */
export type UsageBreakdown = Record<string, Record<string, ModelUsage>>;

/** The latest exact provider measurement of one agent's active conversation context. */
export interface AgentContextUsage {
    approximate: boolean;
    contextTokens: number;
    /** The configured hard limit, or `null` for a custom model with no known limit. */
    contextWindow: number | null;
    modelId: string | null;
    providerId: string;
}

/** `GET /v0/agents/:agentId/usage` — the agent's whole life, subagents included. */
export interface AgentUsageResponse {
    /** The root agent's current context; descendant contexts are deliberately separate. */
    context: AgentContextUsage | null;
    usage: UsageBreakdown;
}

/** `GET /v0/usage` — rolling windows ending now. */
export interface DaemonUsageResponse {
    hour: UsageBreakdown;
    day: UsageBreakdown;
    week: UsageBreakdown;
    month: UsageBreakdown;
}

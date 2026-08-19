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

/** `GET /v0/agents/:agentId/usage` — the agent's whole life, subagents included. */
export interface AgentUsageResponse {
    usage: UsageBreakdown;
}

/** `GET /v0/usage` — rolling windows ending now. */
export interface DaemonUsageResponse {
    hour: UsageBreakdown;
    day: UsageBreakdown;
    week: UsageBreakdown;
    month: UsageBreakdown;
}

import type { SessionAgentType } from "../protocol/index.js";

/**
 * Everything the fold needs to know about one agent.
 *
 * The two session stores gather these differently — one from SQLite, one from
 * memory — and both hand the same shape to `buildTimeline`, so there is exactly
 * one description of how work becomes a chart.
 */
export interface TimelineAgentSource {
    agentId: string;
    archived: boolean;
    createdAt: number;
    depth: number;
    description?: string;
    modelId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    projectId: string;
    providerId: string;
    sessionId: string;
    taskName?: string;
    title?: string;
    type: SessionAgentType;
    /** True while the session still has work in flight, which leaves a span open. */
    working: boolean;
    workspaceId?: string;
}

import type { SessionEvent, TimelineAgent } from "../protocol/index.js";
import { agentTimelineSpans } from "./agentTimelineSpans.js";
import { timelineAgentLabel } from "./timelineAgentLabel.js";
import type { TimelineAgentSource } from "./TimelineSource.js";

export interface BuildTimelineOptions {
    /** Drop spans that had already ended by this moment, in milliseconds. */
    since?: number;
}

/**
 * Assembles the flat list of agent rows a client draws its chart from.
 *
 * The daemon deliberately does not shape the tree here. Joining agents to their
 * parents happens once, in `rig-connect`, the same way projects, workspaces, and
 * sessions are joined.
 */
export function buildTimeline(
    agents: readonly TimelineAgentSource[],
    events: readonly SessionEvent[],
    options: BuildTimelineOptions = {},
): readonly TimelineAgent[] {
    const bySession = new Map<string, SessionEvent[]>();
    for (const event of events) {
        const existing = bySession.get(event.sessionId);
        if (existing === undefined) bySession.set(event.sessionId, [event]);
        else existing.push(event);
    }
    const since = options.since;
    const built: TimelineAgent[] = [];
    for (const agent of agents) {
        const spans = agentTimelineSpans(agent, bySession.get(agent.sessionId) ?? []);
        const kept =
            since === undefined
                ? spans
                : spans.filter((span) => span.endedAt === undefined || span.endedAt >= since);
        if (since !== undefined && kept.length === 0) continue;
        built.push({
            agentId: agent.agentId,
            createdAt: agent.createdAt,
            depth: agent.depth,
            label: timelineAgentLabel(agent),
            modelId: agent.modelId,
            scope: agent.scope,
            providerId: agent.providerId,
            sessionId: agent.sessionId,
            spans: kept,
            type: agent.type,
            ...(agent.parentSessionId === undefined
                ? {}
                : { parentSessionId: agent.parentSessionId }),
            ...(agent.parentToolCallId === undefined
                ? {}
                : { parentToolCallId: agent.parentToolCallId }),
        });
    }
    return built.sort((left, right) => left.createdAt - right.createdAt);
}

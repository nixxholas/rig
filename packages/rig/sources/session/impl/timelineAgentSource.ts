import type { TimelineAgentSource } from "../../timeline/index.js";
import type { InMemorySession } from "../InMemorySession.js";

/** Describes a loaded session the way the timeline fold expects to read it. */
export function timelineAgentSource(session: InMemorySession): TimelineAgentSource {
    const summary = session.summary();
    const agent = session.agentMetadata();
    return {
        agentId: session.agentIdentity().agentId,
        archived: summary.archived,
        createdAt: summary.createdAt,
        depth: agent.depth,
        modelId: summary.modelId,
        projectId: summary.projectId,
        providerId: summary.providerId,
        sessionId: session.id,
        type: agent.type,
        working: summary.status === "running" || summary.status === "queued",
        ...(agent.parentSessionId === undefined ? {} : { parentSessionId: agent.parentSessionId }),
        ...(agent.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: agent.parentToolCallId }),
        ...(agent.description === undefined ? {} : { description: agent.description }),
        ...(agent.taskName === undefined ? {} : { taskName: agent.taskName }),
        ...(summary.title === undefined ? {} : { title: summary.title }),
        ...(summary.workspaceId === undefined ? {} : { workspaceId: summary.workspaceId }),
    };
}

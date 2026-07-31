import type { TimelineAgentSource } from "./TimelineSource.js";

/** The human-readable name drawn on an agent's row. */
export function timelineAgentLabel(agent: TimelineAgentSource): string {
    const label = agent.title ?? agent.taskName ?? agent.description;
    if (label !== undefined && label.trim().length > 0) return label.trim();
    return agent.type === "subagent" ? "Delegated task" : "Untitled chat";
}

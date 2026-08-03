import type { ManagedSubagent, SubagentContext } from "./SubagentContext.js";

export function findManagedSubagent(
    subagents: SubagentContext,
    target: string,
): ManagedSubagent | undefined {
    const agents = subagents.list();
    return (
        agents.find((agent) => agent.agentId === target) ??
        agents.find((agent) => agent.path === target)
    );
}

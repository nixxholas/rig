import { Type } from "@sinclair/typebox";

import type { ManagedSubagent } from "../../../context/SubagentContext.js";

export const managedSubagentSchema = Type.Object({
    agent_id: Type.String({ description: "Stable unguessable Agent ID." }),
    path: Type.String(),
    status: Type.Union([
        Type.Literal("aborted"),
        Type.Literal("completed"),
        Type.Literal("error"),
        Type.Literal("running"),
        Type.Literal("suspended"),
    ]),
});

export function toCodexManagedSubagentResult(agent: ManagedSubagent) {
    return {
        agent_id: agent.agentId,
        path: agent.path,
        status: agent.status,
    };
}

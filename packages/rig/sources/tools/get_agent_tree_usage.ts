import { Type } from "@sinclair/typebox";

import type { AgentTreeUsageSession } from "../agent/context/AgentTreeUsageContext.js";
import { defineTool } from "../agent/types.js";

const agentTreeUsageToolResultSchema = Type.Object(
    {
        sessions: Type.Array(
            Type.Object(
                {
                    agentId: Type.String({ description: "Stable unguessable Agent ID." }),
                    description: Type.Optional(Type.String()),
                    modelId: Type.String(),
                    parentAgentId: Type.Optional(Type.String()),
                    path: Type.String({ description: "Canonical path for this agent." }),
                    providerId: Type.String(),
                    relation: Type.Union([
                        Type.Literal("root"),
                        Type.Literal("subagent"),
                        Type.Literal("delegated"),
                    ]),
                    status: Type.String(),
                    totalTokens: Type.Integer({ minimum: 0 }),
                },
                { additionalProperties: false },
            ),
        ),
        totalTokens: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export const getAgentTreeUsageTool = defineTool({
    name: "get_agent_tree_usage",
    label: "Get agent tree usage",
    description:
        "Report exact lifetime token usage for the current agent and every recursively linked descendant agent. The breakdown includes hidden subagents and visible delegated workspace agents, including completed agents, with Agent IDs and canonical paths and each agent counted once.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: agentTreeUsageToolResultSchema,
    execute(_args, context) {
        if (context.agentTreeUsage === undefined) {
            throw new Error("Agent tree usage is unavailable outside a managed Rig session.");
        }
        const result = context.agentTreeUsage.read();
        const bySessionId = new Map(result.sessions.map((session) => [session.sessionId, session]));
        const pathBySessionId = new Map<string, string>();
        return {
            sessions: result.sessions.map((session) => ({
                agentId: session.agentId,
                ...(session.description === undefined ? {} : { description: session.description }),
                modelId: session.modelId,
                ...(session.parentSessionId === undefined
                    ? {}
                    : {
                          parentAgentId: requiredParent(bySessionId, session.parentSessionId)
                              .agentId,
                      }),
                path: canonicalAgentPath(session, bySessionId, pathBySessionId),
                providerId: session.providerId,
                relation: session.relation,
                status: session.status,
                totalTokens: session.totalTokens,
            })),
            totalTokens: result.totalTokens,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Read ${result.totalTokens.toLocaleString("en-US")} tokens across ${result.sessions.length} agent${result.sessions.length === 1 ? "" : "s"}`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});

function canonicalAgentPath(
    session: AgentTreeUsageSession,
    bySessionId: ReadonlyMap<string, AgentTreeUsageSession>,
    cache: Map<string, string>,
): string {
    const cached = cache.get(session.sessionId);
    if (cached !== undefined) return cached;
    const path =
        session.relation !== "subagent"
            ? "/root"
            : `${subagentParentPath(session, bySessionId, cache)}/${session.taskName ?? session.agentId}`;
    cache.set(session.sessionId, path);
    return path;
}

function subagentParentPath(
    session: AgentTreeUsageSession,
    bySessionId: ReadonlyMap<string, AgentTreeUsageSession>,
    cache: Map<string, string>,
): string {
    if (session.parentSessionId === undefined) {
        throw new Error("A subagent usage row is missing its parent.");
    }
    const parent = requiredParent(bySessionId, session.parentSessionId);
    return parent.relation === "subagent"
        ? canonicalAgentPath(parent, bySessionId, cache)
        : "/root";
}

function requiredParent(
    bySessionId: ReadonlyMap<string, AgentTreeUsageSession>,
    parentSessionId: string,
): AgentTreeUsageSession {
    const parent = bySessionId.get(parentSessionId);
    if (parent === undefined) throw new Error("An agent usage row has an unavailable parent.");
    return parent;
}

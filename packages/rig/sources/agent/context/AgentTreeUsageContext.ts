import { Type, type Static } from "@sinclair/typebox";

export const MAX_AGENT_TREE_USAGE_SESSIONS = 10_000;

export const agentTreeRelationSchema = Type.Union([
    Type.Literal("root"),
    Type.Literal("subagent"),
    Type.Literal("delegated"),
]);

export const agentTreeUsageSessionSchema = Type.Object(
    {
        agentId: Type.String({ description: "Stable unguessable agent identity." }),
        description: Type.Optional(Type.String()),
        modelId: Type.String({
            description:
                "The session's current configured model. Its cumulative usage can span earlier models.",
        }),
        parentSessionId: Type.Optional(Type.String()),
        providerId: Type.String({
            description:
                "The session's current configured provider. Its cumulative usage can span earlier providers.",
        }),
        relation: agentTreeRelationSchema,
        sessionId: Type.String({ description: "Stable durable session identity." }),
        status: Type.String(),
        taskName: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        totalTokens: Type.Integer({
            description:
                "Exact cumulative tokens committed to this session, including its attributed permission reviews.",
            minimum: 0,
        }),
    },
    { additionalProperties: false },
);

export const agentTreeUsageSchema = Type.Object(
    {
        sessions: Type.Array(agentTreeUsageSessionSchema),
        totalTokens: Type.Integer({
            description: "Sum of totalTokens across the returned sessions.",
            minimum: 0,
        }),
    },
    { additionalProperties: false },
);

export type AgentTreeRelation = Static<typeof agentTreeRelationSchema>;
export type AgentTreeUsageSession = Static<typeof agentTreeUsageSessionSchema>;
export type AgentTreeUsage = Static<typeof agentTreeUsageSchema>;

export interface AgentTreeUsageContext {
    read(): AgentTreeUsage;
}

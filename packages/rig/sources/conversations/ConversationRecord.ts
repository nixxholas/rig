import { Type, type Static } from "@sinclair/typebox";

import { sessionScopeSchema } from "../protocol/index.js";

const exact = { additionalProperties: false } as const;
const boundedIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const storedTextSchema = Type.String({ maxLength: 262_144 });

export const conversationAgentMetadataSchema = Type.Object(
    {
        delegatedBySessionId: Type.Optional(boundedIdSchema),
        depth: Type.Integer({ minimum: 0 }),
        description: Type.Optional(storedTextSchema),
        parentSessionId: Type.Optional(boundedIdSchema),
        parentToolCallId: Type.Optional(boundedIdSchema),
        rootSessionId: boundedIdSchema,
        taskName: Type.Optional(storedTextSchema),
        type: Type.Union([Type.Literal("primary"), Type.Literal("subagent")]),
    },
    exact,
);
export type ConversationAgentMetadata = Static<typeof conversationAgentMetadataSchema>;

export const conversationExecutionConfigSchema = Type.Object(
    {
        container: Type.Optional(boundedIdSchema),
        environment: Type.Optional(Type.Record(boundedIdSchema, Type.String())),
        image: Type.Optional(boundedIdSchema),
        mounts: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        readOnly: Type.Optional(Type.Boolean()),
                        source: Type.String({ minLength: 1 }),
                        target: Type.String({ minLength: 1 }),
                    },
                    exact,
                ),
            ),
        ),
        name: Type.Optional(boundedIdSchema),
        socketPath: Type.Optional(Type.String({ minLength: 1 })),
        workingDirectory: Type.String({ minLength: 1 }),
    },
    exact,
);
export type ConversationExecutionConfig = Static<typeof conversationExecutionConfigSchema>;

export const conversationRecordSchema = Type.Object(
    {
        agent: conversationAgentMetadataSchema,
        agentId: boundedIdSchema,
        appendSystemPrompt: Type.Optional(storedTextSchema),
        archived: Type.Boolean(),
        createdAt: Type.Integer({ minimum: 0 }),
        cwd: Type.String({ minLength: 1 }),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
        execution: Type.Optional(conversationExecutionConfigSchema),
        id: boundedIdSchema,
        instructions: Type.Optional(storedTextSchema),
        modelId: boundedIdSchema,
        orderKey: Type.String(),
        ownerInstanceId: boundedIdSchema,
        permissionMode: Type.Union([
            Type.Literal("auto"),
            Type.Literal("full_access"),
            Type.Literal("read_only"),
            Type.Literal("workspace_write"),
        ]),
        profileId: Type.Optional(boundedIdSchema),
        providerId: boundedIdSchema,
        scope: sessionScopeSchema,
        serviceTier: Type.Optional(Type.Literal("fast")),
        trackUnread: Type.Boolean(),
    },
    exact,
);
export type ConversationRecord = Static<typeof conversationRecordSchema>;

export const conversationMetadataUpdateSchema = Type.Object(
    {
        metadataRunId: Type.Optional(boundedIdSchema),
        metadataUpdatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        recap: Type.Optional(Type.Union([storedTextSchema, Type.Null()])),
        title: Type.Optional(Type.Union([storedTextSchema, Type.Null()])),
        titleError: Type.Optional(Type.Union([storedTextSchema, Type.Null()])),
        titleStatus: Type.Optional(
            Type.Union([
                Type.Literal("idle"),
                Type.Literal("generating"),
                Type.Literal("ready"),
                Type.Literal("error"),
            ]),
        ),
    },
    exact,
);
export type ConversationMetadataUpdate = Static<typeof conversationMetadataUpdateSchema>;

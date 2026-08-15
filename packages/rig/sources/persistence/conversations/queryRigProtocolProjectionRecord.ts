import type { Context } from "@steve.kite/stdlib";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { eq } from "drizzle-orm";

import { sessionScopeSchema, type SessionScope } from "../../protocol/index.js";
import { sessions } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";

const boundedStringSchema = Type.String({ minLength: 1, maxLength: 262_144 });
const optionalBoundedStringSchema = Type.Optional(boundedStringSchema);
const optionalStoredTextSchema = Type.Optional(Type.String({ maxLength: 262_144 }));

const permissionModeSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("full_access"),
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
]);

const sessionStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("aborted"),
    Type.Literal("suspended"),
    Type.Literal("error"),
    Type.Literal("archived"),
]);

const sessionTitleStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("generating"),
    Type.Literal("ready"),
    Type.Literal("error"),
]);

const sessionUnreadStateSchema = Type.Object(
    {
        reason: Type.Union([Type.Literal("attention_needed"), Type.Literal("turn_finished")]),
        since: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const sessionInterruptionSchema = Type.Object(
    {
        interruptedAt: Type.Integer({ minimum: 0 }),
        message: boundedStringSchema,
        reason: Type.Union([Type.Literal("crash"), Type.Literal("shutdown")]),
        runId: optionalBoundedStringSchema,
    },
    { additionalProperties: false },
);

const sessionTokenCountSchema = Type.Object(
    {
        lastContextTokens: Type.Number({ minimum: 0 }),
        totalTokens: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const usageCostSchema = Type.Object(
    {
        cacheRead: Type.Number({ minimum: 0 }),
        cacheWrite: Type.Number({ minimum: 0 }),
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        total: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const usageSchema = Type.Object(
    {
        cacheRead: Type.Number({ minimum: 0 }),
        cacheWrite: Type.Number({ minimum: 0 }),
        cost: usageCostSchema,
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        reasoning: Type.Optional(Type.Number({ minimum: 0 })),
        totalTokens: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const persistedUsageSchema = Type.Object(
    {
        committed: usageSchema,
    },
    { additionalProperties: true },
);

const dockerExecutionConfigSchema = Type.Object(
    {
        container: Type.Optional(boundedStringSchema),
        environment: Type.Optional(Type.Record(boundedStringSchema, Type.String())),
        image: Type.Optional(boundedStringSchema),
        mounts: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        readOnly: Type.Optional(Type.Boolean()),
                        source: boundedStringSchema,
                        target: boundedStringSchema,
                    },
                    { additionalProperties: false },
                ),
            ),
        ),
        name: Type.Optional(boundedStringSchema),
        socketPath: Type.Optional(boundedStringSchema),
        workingDirectory: boundedStringSchema,
    },
    { additionalProperties: false },
);

const executionEnvironmentSchema = Type.Union([
    Type.Object({ type: Type.Literal("local") }, { additionalProperties: false }),
    Type.Object(
        {
            kind: Type.Union([Type.Literal("container"), Type.Literal("image")]),
            reference: boundedStringSchema,
            type: Type.Literal("docker"),
            workingDirectory: boundedStringSchema,
        },
        { additionalProperties: false },
    ),
]);

const sessionAgentMetadataSchema = Type.Object(
    {
        delegatedBySessionId: optionalBoundedStringSchema,
        depth: Type.Integer({ minimum: 0 }),
        description: optionalStoredTextSchema,
        parentSessionId: optionalBoundedStringSchema,
        parentToolCallId: optionalBoundedStringSchema,
        rootSessionId: boundedStringSchema,
        taskName: optionalStoredTextSchema,
        type: Type.Union([Type.Literal("primary"), Type.Literal("subagent")]),
    },
    { additionalProperties: false },
);

export const rigProtocolProjectionRecordSchema = Type.Object(
    {
        activeRunId: optionalBoundedStringSchema,
        activeSince: Type.Optional(Type.Integer({ minimum: 0 })),
        agent: sessionAgentMetadataSchema,
        agentId: boundedStringSchema,
        appendSystemPrompt: optionalStoredTextSchema,
        archived: Type.Boolean(),
        cumulativeUsage: Type.Optional(usageSchema),
        cwd: boundedStringSchema,
        draft: optionalStoredTextSchema,
        draftUpdatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
        environment: executionEnvironmentSchema,
        id: boundedStringSchema,
        interruption: Type.Optional(sessionInterruptionSchema),
        lastEventId: optionalBoundedStringSchema,
        metadataRunId: optionalBoundedStringSchema,
        metadataUpdatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        modelId: boundedStringSchema,
        orderKey: optionalBoundedStringSchema,
        ownerInstanceId: boundedStringSchema,
        permissionMode: permissionModeSchema,
        profileId: optionalBoundedStringSchema,
        providerId: boundedStringSchema,
        recap: optionalStoredTextSchema,
        scope: sessionScopeSchema,
        serviceTier: Type.Optional(Type.Literal("fast")),
        sessionTokenCount: sessionTokenCountSchema,
        status: sessionStatusSchema,
        systemPrompt: optionalStoredTextSchema,
        title: optionalStoredTextSchema,
        titleError: optionalStoredTextSchema,
        titleStatus: sessionTitleStatusSchema,
        trackUnread: Type.Boolean(),
        unread: Type.Optional(sessionUnreadStateSchema),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export type RigProtocolProjectionRecord = Static<typeof rigProtocolProjectionRecordSchema>;

export async function queryRigProtocolProjectionRecord(
    ctx: Context,
    conversationId: string,
): Promise<RigProtocolProjectionRecord | undefined> {
    return await inDatabase(ctx, "rig.sql.session.query_protocol_projection", async (ctx) => {
        const row = await ctx.tx
            .select()
            .from(sessions)
            .where(eq(sessions.id, conversationId))
            .get();
        if (row === undefined) return undefined;

        const scope = decodeScope(row);
        const docker = decodeOptionalJson(
            dockerExecutionConfigSchema,
            row.dockerJson,
            "execution configuration",
        );
        const interruption = decodeOptionalJson(
            sessionInterruptionSchema,
            row.interruptionJson,
            "interruption",
        );
        const sessionTokenCount = decodeOptionalJson(
            sessionTokenCountSchema,
            row.sessionTokenCountJson,
            "token count",
        ) ?? { lastContextTokens: 0, totalTokens: 0 };
        const persistedUsage = decodeOptionalJson(persistedUsageSchema, row.usageJson, "usage");

        const candidate = {
            activeRunId: row.activeRunId ?? undefined,
            activeSince: row.activeSinceMs ?? undefined,
            agent: compact({
                delegatedBySessionId: row.delegatedBySessionId ?? undefined,
                depth: row.depth,
                description: row.description ?? undefined,
                parentSessionId: row.parentSessionId ?? undefined,
                parentToolCallId: row.parentToolCallId ?? undefined,
                rootSessionId: row.rootSessionId,
                taskName: row.taskName ?? undefined,
                type: row.sessionKind,
            }),
            agentId: row.agentId,
            appendSystemPrompt: row.appendSystemPrompt ?? undefined,
            archived: row.archived,
            cumulativeUsage:
                persistedUsage?.committed.totalTokens === 0 ? undefined : persistedUsage?.committed,
            cwd: row.cwd,
            draft: row.draft ?? undefined,
            draftUpdatedAt: row.draftUpdatedAtMs ?? undefined,
            effort: row.effort ?? undefined,
            environment: summarizeExecution(docker),
            id: row.id,
            interruption,
            lastEventId: row.lastEventId ?? undefined,
            metadataRunId: row.metadataRunId ?? undefined,
            metadataUpdatedAt: row.metadataUpdatedAtMs ?? undefined,
            modelId: row.modelId,
            orderKey: row.orderKey === "" ? undefined : row.orderKey,
            ownerInstanceId: row.ownerInstanceId,
            permissionMode: row.permissionMode,
            profileId: row.profileId ?? undefined,
            providerId: row.providerId,
            recap: row.recap ?? undefined,
            scope,
            serviceTier: row.serviceTier === "fast" ? "fast" : undefined,
            sessionTokenCount,
            status: row.status,
            systemPrompt: row.systemPrompt ?? undefined,
            title: row.title ?? undefined,
            titleError: row.titleError ?? undefined,
            titleStatus: row.titleStatus,
            trackUnread: row.trackUnread,
            unread:
                row.unreadReason === null || row.unreadSinceMs === null
                    ? undefined
                    : { reason: row.unreadReason, since: row.unreadSinceMs },
            updatedAt: row.updatedAtMs,
        };
        return Value.Decode(rigProtocolProjectionRecordSchema, compact(candidate));
    });
}

function decodeScope(row: typeof sessions.$inferSelect): SessionScope {
    const candidate: unknown =
        row.scopeKind === "project"
            ? { kind: row.scopeKind, projectId: row.projectId }
            : row.scopeKind === "workspace"
              ? {
                    kind: row.scopeKind,
                    projectId: row.projectId,
                    workspaceId: row.workspaceId,
                }
              : row.scopeKind === "folder"
                ? { folderId: row.folderId, kind: row.scopeKind }
                : { kind: row.scopeKind };
    return Value.Decode(sessionScopeSchema, candidate);
}

function summarizeExecution(
    config: Static<typeof dockerExecutionConfigSchema> | undefined,
): Static<typeof executionEnvironmentSchema> {
    if (config === undefined) return { type: "local" };
    return config.container === undefined
        ? {
              kind: "image",
              reference: config.image ?? "Unknown image",
              type: "docker",
              workingDirectory: config.workingDirectory,
          }
        : {
              kind: "container",
              reference: config.container,
              type: "docker",
              workingDirectory: config.workingDirectory,
          };
}

function decodeOptionalJson<T extends TSchema>(
    schema: T,
    encoded: string | null,
    label: string,
): Static<T> | undefined {
    if (encoded === null) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(encoded);
    } catch (error) {
        throw new Error(`The stored session ${label} is not valid JSON.`, { cause: error });
    }
    try {
        return Value.Decode(schema, parsed);
    } catch (error) {
        throw new Error(`The stored session ${label} is invalid.`, { cause: error });
    }
}

function compact<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as T;
}

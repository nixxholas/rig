import type { Context } from "@steve.kite/stdlib";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    createEventIdFactory,
    submissionFingerprintSchema,
    submitMessageDisplayTextSchema,
    type ModelCatalog,
    type ProtocolSession,
    type SessionActivity,
    type SessionConfigurationField,
    type SessionEvent,
} from "../../protocol/index.js";
import { querySessionMessageSubmission } from "../../persistence/session/querySessionMessageSubmission.js";
import { queryRigProtocolConfigurationMutation } from "../../persistence/session/queryRigProtocolConfigurationMutation.js";
import {
    queryRigProtocolProjectionRecord,
    type RigProtocolProjectionRecord,
} from "../../persistence/session/queryRigProtocolProjectionRecord.js";
import { sessionProjectProtocolEvent } from "../../persistence/session/sessionProjectProtocolEvent.js";
import { sessionProjectProtocolMessage } from "../../persistence/session/sessionProjectProtocolMessage.js";
import { sessionProjectRigAgentConfiguration } from "../../persistence/session/sessionProjectRigAgentConfiguration.js";
import type { SessionDatabase } from "../../persistence/database/SessionDatabase.js";
import { deferSessionTransactionCommit } from "../../persistence/database/SessionTransactionContext.js";
import { withDatabase } from "../../persistence/databaseContext.js";
import type {
    RigProtocolProjection,
    RigProtocolUserMessageInput,
} from "../RigProtocolProjection.js";
import type { RigAgentConfiguration } from "../RigProtocolFeature.js";
import type { Message } from "../types.js";

const boundedIdSchema = Type.String({ maxLength: 256, minLength: 1 });
const permissionModeSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("full_access"),
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
]);

const rigAgentConfigurationSchema = Type.Object(
    {
        effort: Type.Optional(Type.String({ maxLength: 32, minLength: 1 })),
        modelId: boundedIdSchema,
        mutationId: Type.Optional(boundedIdSchema),
        permissionMode: permissionModeSchema,
        providerId: boundedIdSchema,
        serviceTier: Type.Optional(Type.Literal("fast")),
    },
    { additionalProperties: false },
);

const messageEnvelopeSchema = Type.Object(
    {
        blocks: Type.Array(Type.Unknown(), { maxItems: 16_384 }),
        id: boundedIdSchema,
        role: Type.Union([
            Type.Literal("agent"),
            Type.Literal("compaction"),
            Type.Literal("error"),
            Type.Literal("system"),
            Type.Literal("user"),
        ]),
    },
    { additionalProperties: true },
);

const userMessageEnvelopeSchema = Type.Intersect([
    messageEnvelopeSchema,
    Type.Object({ role: Type.Literal("user") }, { additionalProperties: true }),
]);

const protocolUserMessageInputSchema = Type.Object(
    {
        delivery: Type.Union([Type.Literal("run"), Type.Literal("steer")]),
        displayText: submitMessageDisplayTextSchema,
        message: userMessageEnvelopeSchema,
        mutationId: Type.Optional(boundedIdSchema),
        runId: boundedIdSchema,
        submissionFingerprint: Type.Optional(submissionFingerprintSchema),
    },
    { additionalProperties: false },
);

const sessionEventEnvelopeSchema = Type.Object(
    {
        createdAt: Type.Integer({ minimum: 0 }),
        data: Type.Unknown(),
        id: boundedIdSchema,
        sessionId: boundedIdSchema,
        type: boundedIdSchema,
    },
    { additionalProperties: false },
);

type ValidatedRigAgentConfiguration = Static<typeof rigAgentConfigurationSchema>;

export interface SqliteRigProtocolProjectionOptions {
    readonly database: SessionDatabase;
    readonly now?: () => number;
    readonly publishDurable?: (ctx: Context, event: SessionEvent) => void | Promise<void>;
    readonly publishLive?: (ctx: Context, event: SessionEvent) => void;
    readonly resolveModelCatalog: (
        ctx: Context,
        ownerInstanceId: string,
    ) => ModelCatalog | Promise<ModelCatalog>;
}

/**
 * SQLite-backed external projection for Agent Base conversations.
 *
 * This class owns no live session objects. Every read is reconstructed from durable rows, and
 * every write joins the caller's Agent Base transaction before observers are notified.
 */
export class SqliteRigProtocolProjection implements RigProtocolProjection {
    readonly #database: SessionDatabase;
    readonly #nextEventId = createEventIdFactory();
    readonly #now: () => number;
    readonly #publishDurable: SqliteRigProtocolProjectionOptions["publishDurable"];
    readonly #publishLive: SqliteRigProtocolProjectionOptions["publishLive"];
    readonly #resolveModelCatalog: SqliteRigProtocolProjectionOptions["resolveModelCatalog"];

    constructor(options: SqliteRigProtocolProjectionOptions) {
        this.#database = options.database;
        this.#now = options.now ?? Date.now;
        this.#publishDurable = options.publishDurable;
        this.#publishLive = options.publishLive;
        this.#resolveModelCatalog = options.resolveModelCatalog;
    }

    async afterCommit(
        ctx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): Promise<void> {
        const postCommitCtx = withDatabase(ctx, this.#database);
        await deferSessionTransactionCommit(() => callback(postCommitCtx), this.#database);
    }

    async messageSubmission(
        ctx: Context,
        conversationId: string,
        messageId: string,
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }> | undefined> {
        return await querySessionMessageSubmission(
            withDatabase(ctx, this.#database),
            conversationId,
            messageId,
        );
    }

    async projectAgentConfiguration(
        ctx: Context,
        conversationId: string,
        configuration: RigAgentConfiguration,
    ): Promise<ProtocolSession> {
        const validated = decodeConfiguration(configuration);
        const databaseCtx = withDatabase(ctx, this.#database);
        const current = await queryRigProtocolProjectionRecord(databaseCtx, conversationId);
        if (current === undefined) {
            throw new Error(`The conversation '${conversationId}' does not exist.`);
        }
        const catalog = await this.#resolveModelCatalog(databaseCtx, current.ownerInstanceId);
        const provider = catalog.providers.find(
            (candidate) => candidate.providerId === validated.providerId,
        );
        const model = provider?.models.find((candidate) => candidate.id === validated.modelId);
        if (provider === undefined || model === undefined) {
            throw new Error(
                `Model '${validated.modelId}' is not available from provider '${validated.providerId}'.`,
            );
        }
        if (
            validated.effort !== undefined &&
            !model.thinkingLevels.includes(validated.effort) &&
            !(validated.effort === "max" && model.thinkingLevels.includes("ultra"))
        ) {
            throw new Error(
                `Model '${validated.modelId}' does not support the '${validated.effort}' reasoning effort.`,
            );
        }
        if (
            validated.serviceTier !== undefined &&
            provider.serviceTiers?.includes(validated.serviceTier) !== true
        ) {
            throw new Error(`Provider '${validated.providerId}' does not support fast inference.`);
        }

        if (
            validated.mutationId !== undefined &&
            (await queryRigProtocolConfigurationMutation(
                databaseCtx,
                conversationId,
                validated.mutationId,
            ))
        ) {
            assertConfigurationMatches(current, validated);
            return toProtocolSession(current, catalog);
        }

        const changed: SessionConfigurationField[] = [];
        const modelChanged =
            current.modelId !== validated.modelId || current.providerId !== validated.providerId;
        if (modelChanged) changed.push("model");
        if (current.effort !== validated.effort) changed.push("effort");
        if (current.serviceTier !== validated.serviceTier) changed.push("serviceTier");
        const permissionChanged = current.permissionMode !== validated.permissionMode;
        const events: SessionEvent[] = [];
        if (changed.length > 0) {
            events.push({
                createdAt: this.#now(),
                data: {
                    changed,
                    ...(validated.effort === undefined ? {} : { effort: validated.effort }),
                    modelId: validated.modelId,
                    ...(validated.mutationId === undefined
                        ? {}
                        : { mutationId: validated.mutationId }),
                    providerId: validated.providerId,
                    serviceTier: validated.serviceTier ?? null,
                },
                id: this.#nextEventId(),
                sessionId: conversationId,
                type: "session_configuration_changed",
            });
        }
        if (permissionChanged) {
            events.push({
                createdAt: this.#now(),
                data: {
                    ...(validated.mutationId === undefined
                        ? {}
                        : { mutationId: validated.mutationId }),
                    permissionMode: validated.permissionMode,
                },
                id: this.#nextEventId(),
                sessionId: conversationId,
                type: "permission_mode_changed",
            });
        }

        const {
            effort: _currentEffort,
            interruption: _currentInterruption,
            lastEventId: _currentLastEventId,
            serviceTier: _currentServiceTier,
            ...currentWithoutConfiguration
        } = current;
        const projectedLastEventId = events.at(-1)?.id ?? current.lastEventId;
        const target: RigProtocolProjectionRecord = {
            ...currentWithoutConfiguration,
            ...(validated.effort === undefined ? {} : { effort: validated.effort }),
            ...(projectedLastEventId === undefined ? {} : { lastEventId: projectedLastEventId }),
            modelId: validated.modelId,
            permissionMode: validated.permissionMode,
            providerId: validated.providerId,
            ...(validated.serviceTier === undefined ? {} : { serviceTier: validated.serviceTier }),
            updatedAt: this.#now(),
        };
        if (events.length === 0) return toProtocolSession(target, catalog);

        await sessionProjectRigAgentConfiguration(databaseCtx, {
            bindingId:
                provider.credential?.bindingId ??
                `${current.ownerInstanceId}:${validated.providerId}`,
            ...(validated.effort === undefined ? {} : { effort: validated.effort }),
            events,
            modelChanged,
            modelId: validated.modelId,
            models: provider.models,
            permissionMode: validated.permissionMode,
            providerId: validated.providerId,
            ...(validated.serviceTier === undefined ? {} : { serviceTier: validated.serviceTier }),
            sessionId: conversationId,
            updatedAt: target.updatedAt,
        });
        for (const event of events) await this.#publishAfterCommit(databaseCtx, event);
        return toProtocolSession(target, catalog);
    }

    async projectAgentMessage(
        ctx: Context,
        conversationId: string,
        runId: string,
        message: Message,
    ): Promise<Extract<SessionEvent, { type: "agent_message" }>> {
        assertMessage(message);
        const event: Extract<SessionEvent, { type: "agent_message" }> = {
            createdAt: this.#now(),
            data: { message, runId },
            id: this.#nextEventId(),
            sessionId: conversationId,
            type: "agent_message",
        };
        const databaseCtx = withDatabase(ctx, this.#database);
        await sessionProjectProtocolMessage(databaseCtx, {
            event,
            message,
            runId,
            updatedAt: event.createdAt,
            updateLastMessageAt: false,
        });
        await this.#publishAfterCommit(databaseCtx, event);
        return event;
    }

    async projectProtocolEvent<TEvent extends SessionEvent>(
        ctx: Context,
        conversationId: string,
        event: TEvent,
    ): Promise<TEvent> {
        assertEvent(conversationId, event);
        const databaseCtx = withDatabase(ctx, this.#database);
        await sessionProjectProtocolEvent(
            databaseCtx,
            event,
            protocolEventFacts(event),
            event.createdAt,
        );
        await this.#publishAfterCommit(databaseCtx, event);
        return event;
    }

    async projectUserMessage(
        ctx: Context,
        conversationId: string,
        input: RigProtocolUserMessageInput,
    ): Promise<Extract<SessionEvent, { type: "message_submitted" }>> {
        const validated = decodeUserMessageInput(input);
        const event: Extract<SessionEvent, { type: "message_submitted" }> = {
            createdAt: this.#now(),
            data: {
                delivery: validated.delivery,
                displayText: validated.displayText,
                message: input.message,
                ...(validated.mutationId === undefined ? {} : { mutationId: validated.mutationId }),
                runId: validated.runId,
                ...(validated.submissionFingerprint === undefined
                    ? {}
                    : { submissionFingerprint: validated.submissionFingerprint }),
            },
            id: this.#nextEventId(),
            sessionId: conversationId,
            type: "message_submitted",
        };
        const databaseCtx = withDatabase(ctx, this.#database);
        await sessionProjectProtocolMessage(databaseCtx, {
            event,
            message: input.message,
            runId: validated.runId,
            updatedAt: event.createdAt,
            updateLastMessageAt: true,
        });
        await this.#publishAfterCommit(databaseCtx, event);
        return event;
    }

    publishLive(ctx: Context, event: SessionEvent): void {
        assertEvent(event.sessionId, event);
        this.#publishLive?.(ctx, event);
    }

    async readSnapshot(ctx: Context, conversationId: string): Promise<ProtocolSession | undefined> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const record = await queryRigProtocolProjectionRecord(databaseCtx, conversationId);
        if (record === undefined) return undefined;
        const catalog = await this.#resolveModelCatalog(databaseCtx, record.ownerInstanceId);
        return toProtocolSession(record, catalog);
    }

    async #publishAfterCommit(ctx: Context, event: SessionEvent): Promise<void> {
        if (this.#publishDurable === undefined) return;
        await this.afterCommit(ctx, (postCommitCtx) =>
            this.#publishDurable?.(postCommitCtx, event),
        );
    }
}

function decodeConfiguration(value: RigAgentConfiguration): ValidatedRigAgentConfiguration {
    try {
        return Value.Decode(rigAgentConfigurationSchema, value);
    } catch (error) {
        throw new Error("The Agent Base configuration projection is invalid.", { cause: error });
    }
}

function decodeUserMessageInput(
    value: RigProtocolUserMessageInput,
): Static<typeof protocolUserMessageInputSchema> {
    try {
        return Value.Decode(protocolUserMessageInputSchema, value);
    } catch (error) {
        throw new Error("The Agent Base user message projection is invalid.", { cause: error });
    }
}

function assertMessage(message: Message): void {
    if (!Value.Check(messageEnvelopeSchema, message) || !isJsonSerializable(message)) {
        throw new Error("The Agent Base message projection is invalid.");
    }
}

function assertEvent(conversationId: string, event: SessionEvent): void {
    if (
        !Value.Check(sessionEventEnvelopeSchema, event) ||
        !isJsonSerializable(event.data) ||
        event.sessionId !== conversationId
    ) {
        throw new Error("The Agent Base protocol event projection is invalid.");
    }
}

function assertConfigurationMatches(
    current: RigProtocolProjectionRecord,
    requested: ValidatedRigAgentConfiguration,
): void {
    if (
        current.effort !== requested.effort ||
        current.modelId !== requested.modelId ||
        current.permissionMode !== requested.permissionMode ||
        current.providerId !== requested.providerId ||
        current.serviceTier !== requested.serviceTier
    ) {
        throw new Error(
            `Mutation '${requested.mutationId}' was already used for a different configuration.`,
        );
    }
}

function toProtocolSession(
    record: RigProtocolProjectionRecord,
    modelCatalog: ModelCatalog,
): ProtocolSession {
    const models =
        modelCatalog.providers.find((provider) => provider.providerId === record.providerId)
            ?.models ?? [];
    const activity = activityFor(record);
    const activeTurn =
        record.activeRunId === undefined
            ? undefined
            : {
                  runId: record.activeRunId,
                  startedAt: record.activeSince ?? record.updatedAt,
              };
    return {
        ...(activeTurn === undefined ? {} : { activeTurn }),
        activity,
        agent: record.agent,
        agentId: record.agentId,
        ...(record.appendSystemPrompt === undefined
            ? {}
            : { appendSystemPrompt: record.appendSystemPrompt }),
        archived: record.archived,
        ...(record.cumulativeUsage === undefined
            ? {}
            : { cumulativeUsage: record.cumulativeUsage }),
        cwd: record.cwd,
        ...(record.draft === undefined ? {} : { draft: record.draft }),
        ...(record.draftUpdatedAt === undefined ? {} : { draftUpdatedAt: record.draftUpdatedAt }),
        ...(record.effort === undefined ? {} : { effort: record.effort }),
        environment: record.environment,
        ...(record.scope.kind === "folder" ? { folderId: record.scope.folderId } : {}),
        id: record.id,
        ...(record.interruption === undefined ? {} : { interruption: record.interruption }),
        ...(record.lastEventId === undefined ? {} : { lastEventId: record.lastEventId }),
        mcpServers: [],
        ...(record.metadataRunId === undefined ? {} : { metadataRunId: record.metadataRunId }),
        ...(record.metadataUpdatedAt === undefined
            ? {}
            : { metadataUpdatedAt: record.metadataUpdatedAt }),
        modelCatalog,
        modelId: record.modelId,
        modelLocked: false,
        models,
        ...(record.orderKey === undefined ? {} : { orderKey: record.orderKey }),
        ownerInstanceId: record.ownerInstanceId,
        pendingUserInputs: [],
        permissionMode: record.permissionMode,
        ...(record.profileId === undefined ? {} : { profileId: record.profileId }),
        ...(record.scope.kind === "project" || record.scope.kind === "workspace"
            ? { projectId: record.scope.projectId }
            : {}),
        projectSecretIds: [],
        providerId: record.providerId,
        ...(record.recap === undefined ? {} : { recap: record.recap }),
        scope: record.scope,
        secretIds: [],
        ...(record.serviceTier === undefined ? {} : { serviceTier: record.serviceTier }),
        sessionSecretIds: [],
        sessionTokenCount: record.sessionTokenCount,
        snapshot: {
            ...(record.appendSystemPrompt === undefined
                ? {}
                : { appendSystemPrompt: record.appendSystemPrompt }),
            ...(record.effort === undefined ? {} : { effort: record.effort }),
            id: record.agentId,
            messages: [],
            modelId: record.modelId,
            providerId: record.providerId,
            queue: [],
            ...(record.serviceTier === undefined ? {} : { serviceTier: record.serviceTier }),
            status:
                record.status === "running" || record.status === "queued"
                    ? "running"
                    : record.status === "aborted"
                      ? "aborted"
                      : "idle",
            ...(record.systemPrompt === undefined ? {} : { systemPrompt: record.systemPrompt }),
            tools: [],
        },
        status: record.status,
        ...(record.systemPrompt === undefined ? {} : { systemPrompt: record.systemPrompt }),
        tasks: [],
        ...(record.title === undefined ? {} : { title: record.title }),
        ...(record.titleError === undefined ? {} : { titleError: record.titleError }),
        titleStatus: record.titleStatus,
        trackUnread: record.trackUnread,
        ...(record.unread === undefined ? {} : { unread: record.unread }),
        ...(record.scope.kind === "workspace" ? { workspaceId: record.scope.workspaceId } : {}),
    };
}

function activityFor(record: RigProtocolProjectionRecord): SessionActivity {
    const since = record.activeSince ?? record.updatedAt;
    if (record.status === "queued") return { kind: "queued", label: "Queued", since };
    if (record.status === "running") {
        return {
            kind: "thinking",
            label: "Thinking",
            ...(record.activeRunId === undefined ? {} : { runId: record.activeRunId }),
            since,
        };
    }
    if (record.status === "aborted") return { kind: "stopped", label: "Stopped", since };
    if (record.status === "error") return { kind: "error", label: "Failed", since };
    return { kind: "idle", label: "Idle", since };
}

function protocolEventFacts(event: SessionEvent): {
    messageId?: string;
    runId?: string;
    toolCallId?: string;
} {
    switch (event.type) {
        case "message_submitted":
        case "agent_message":
            return { messageId: event.data.message.id, runId: event.data.runId };
        case "run_started":
        case "run_finished":
        case "run_error":
            return { runId: event.data.runId };
        case "agent_event":
            return {
                runId: event.data.runId,
                ...agentEventToolCallFact(event.data.event),
            };
        case "steering_applied":
            return { runId: event.data.runId };
        case "abort_requested":
            return event.data.runId === undefined ? {} : { runId: event.data.runId };
        default:
            return {};
    }
}

function agentEventToolCallFact(
    event: Extract<SessionEvent, { type: "agent_event" }>["data"]["event"],
): { toolCallId?: string } {
    switch (event.type) {
        case "tool_execution_start":
            return { toolCallId: event.toolCall.id };
        case "tool_execution_end":
            return { toolCallId: event.result.toolCallId };
        case "tool_execution_progress":
        case "tool_execution_status":
        case "permission_review_started":
        case "permission_review":
        case "temporary_full_access_started":
            return { toolCallId: event.toolCallId };
        default:
            return {};
    }
}

function isJsonSerializable(value: unknown): boolean {
    try {
        return JSON.stringify(value) !== undefined;
    } catch {
        return false;
    }
}

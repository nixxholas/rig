import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { and, eq, sql } from "drizzle-orm";

import type { SqliteRigProtocolProjection } from "../agent/persistence/SqliteRigProtocolProjection.js";
import type { Message, SystemMessage } from "../agent/types.js";
import { DEFAULT_PERMISSION_MODE } from "../permissions/index.js";
import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import { withDatabase } from "../persistence/databaseContext.js";
import { inReadTx } from "../persistence/inReadTx.js";
import { inTx } from "../persistence/inTx.js";
import { sessionEvents, sessionMessages, sessions } from "../persistence/database/schema.js";
import { insertConversation } from "../persistence/conversations/insertConversation.js";
import { querySessionAttachment } from "../persistence/conversations/querySessionAttachment.js";
import { querySessionEvents } from "../persistence/conversations/querySessionEvents.js";
import { querySessionHasEarlierTranscriptMessage } from "../persistence/conversations/querySessionHasEarlierTranscriptMessage.js";
import { querySessionHasLaterTranscriptMessage } from "../persistence/conversations/querySessionHasLaterTranscriptMessage.js";
import { querySessionIdByAgentId } from "../persistence/conversations/querySessionIdByAgentId.js";
import { querySessionMessageSubmission } from "../persistence/conversations/querySessionMessageSubmission.js";
import {
    querySessionMutationReceipt,
    type SessionMutationReceiptResult,
} from "../persistence/conversations/querySessionMutationReceipt.js";
import { querySessionOrderItems } from "../persistence/conversations/querySessionOrderItems.js";
import { querySessionSummaries } from "../persistence/conversations/querySessionSummaries.js";
import { querySessionTranscriptEvents } from "../persistence/conversations/querySessionTranscriptEvents.js";
import { querySessionTranscriptPage } from "../persistence/conversations/querySessionTranscriptPage.js";
import { querySessionTranscriptSince } from "../persistence/conversations/querySessionTranscriptSince.js";
import { sessionMoveScope } from "../persistence/conversations/sessionMoveScope.js";
import { sessionRecordMutationReceipt } from "../persistence/conversations/sessionRecordMutationReceipt.js";
import { sessionSaveMessage } from "../persistence/conversations/sessionSaveMessage.js";
import {
    createEventIdFactory,
    type Attachment,
    type CreateSessionRequest,
    type EventId,
    type Model,
    type ModelCatalog,
    type ProtocolSession,
    type ReorderRequest,
    type SessionEvent,
    type SessionScope,
    type SessionSummary,
    type SessionTranscriptWindow,
    type SetSessionDraftRequest,
    type SystemNoticePayload,
    SESSION_DRAFT_MAX_CLOCK_SKEW_MS,
    SESSION_DRAFT_MAX_LENGTH,
    systemNoticePayloadSchema,
} from "../protocol/index.js";
import { SessionEventLog } from "../protocol/projection/SessionEventLog.js";
import {
    sessionTranscriptWindow,
    transcriptRunFacts,
    type TranscriptEntry,
} from "../protocol/projection/sessionTranscriptWindow.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import {
    conversationMetadataUpdateSchema,
    conversationRecordSchema,
    type ConversationAgentMetadata,
    type ConversationMetadataUpdate,
} from "./ConversationRecord.js";

const ARCHIVE_MUTATION = "archive";
const DRAFT_MUTATION = "draft";
const MARK_READ_MUTATION = "mark_read";
const METADATA_MUTATION = "metadata";
const REORDER_MUTATION = "reorder";

export interface ConversationCreationOptions {
    readonly agent?: ConversationAgentMetadata;
    readonly agentId?: string;
    readonly orderKey?: string;
    readonly ownerInstanceId?: string;
    readonly profileId?: string;
    /**
     * Resolved product scope. The projects/folders feature is responsible for deriving this when
     * the request does not already carry an explicit folder or Unsorted scope.
     */
    readonly scope?: SessionScope;
}

export interface ConversationRepositoryOptions {
    readonly database: SessionDatabase;
    readonly localInstanceId: string;
    readonly now?: () => number;
    readonly projection: SqliteRigProtocolProjection;
    readonly resolveModelCatalog: (
        ctx: Context,
        ownerInstanceId: string,
    ) => ModelCatalog | Promise<ModelCatalog>;
    readonly resolveCreation?: (
        ctx: Context,
        conversationId: string,
        request: CreateSessionRequest,
    ) =>
        | { cwd: string; orderKey?: string; scope: SessionScope }
        | Promise<{ cwd: string; orderKey?: string; scope: SessionScope }>;
}

/**
 * Stateless product conversation catalog and protocol read model.
 *
 * This repository deliberately owns no Agent Base runtime or feature state. Every method addresses
 * SQLite by conversation ID, and snapshots come from the shared protocol projection.
 */
export class ConversationRepository {
    readonly #database: SessionDatabase;
    readonly #localInstanceId: string;
    readonly #nextEventId = createEventIdFactory();
    readonly #now: () => number;
    readonly #projection: SqliteRigProtocolProjection;
    readonly #resolveCreation: ConversationRepositoryOptions["resolveCreation"];
    readonly #resolveModelCatalog: ConversationRepositoryOptions["resolveModelCatalog"];

    constructor(options: ConversationRepositoryOptions) {
        this.#database = options.database;
        this.#localInstanceId = options.localInstanceId;
        this.#now = options.now ?? Date.now;
        this.#projection = options.projection;
        this.#resolveCreation = options.resolveCreation;
        this.#resolveModelCatalog = options.resolveModelCatalog;
    }

    async create(
        ctx: Context,
        request: CreateSessionRequest,
        options: ConversationCreationOptions = {},
    ): Promise<ProtocolSession> {
        return await this.createWithId(ctx, createId(), request, options);
    }

    async createWithId(
        ctx: Context,
        conversationId: string,
        request: CreateSessionRequest,
        options: ConversationCreationOptions = {},
    ): Promise<ProtocolSession> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const existing = await this.#projection.readSnapshot(databaseCtx, conversationId);
        if (existing !== undefined) return existing;

        const ownerInstanceId = options.ownerInstanceId ?? this.#localInstanceId;
        const catalog = await this.#resolveModelCatalog(databaseCtx, ownerInstanceId);
        const selection = resolveInitialModelSelection(
            catalog,
            request.modelId ?? catalog.defaultModelId,
            request.providerId ?? catalog.defaultProviderId,
        );
        const resolved: { cwd: string; orderKey?: string; scope: SessionScope } =
            (await this.#resolveCreation?.(databaseCtx, conversationId, request)) ??
            inferCreation(request, options.scope);
        const agent =
            options.agent ??
            ({
                depth: 0,
                rootSessionId: conversationId,
                type: "primary",
            } as const);
        const requestedEffort = request.effort;
        const effort =
            requestedEffort !== undefined &&
            selection.model.thinkingLevels.includes(requestedEffort)
                ? requestedEffort
                : selection.model.defaultThinkingLevel;
        const provider = catalog.providers.find(
            (candidate) => candidate.providerId === selection.providerId,
        );
        const serviceTier =
            request.serviceTier !== undefined &&
            provider?.serviceTiers?.includes(request.serviceTier) === true
                ? request.serviceTier
                : undefined;
        const createdAt = this.#now();
        const record = Value.Decode(conversationRecordSchema, {
            agent,
            agentId: options.agentId ?? createId(),
            ...(request.appendSystemPrompt === undefined
                ? {}
                : { appendSystemPrompt: request.appendSystemPrompt }),
            archived: false,
            createdAt,
            cwd: resolved.cwd,
            ...(effort === undefined ? {} : { effort }),
            ...(request.docker === undefined ? {} : { execution: request.docker }),
            id: conversationId,
            ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
            modelId: selection.model.id,
            orderKey:
                agent.type === "subagent"
                    ? ""
                    : (options.orderKey ??
                      resolved.orderKey ??
                      (await this.#lastOrderKey(databaseCtx, resolved.scope))),
            ownerInstanceId,
            permissionMode: request.permissionMode ?? DEFAULT_PERMISSION_MODE,
            ...((options.profileId ?? request.identity) === undefined
                ? {}
                : { profileId: options.profileId ?? request.identity }),
            providerId: selection.providerId,
            scope: resolved.scope,
            ...(serviceTier === undefined ? {} : { serviceTier }),
            trackUnread: request.trackUnread === true,
        });
        const models = provider?.models ?? [selection.model];

        await inTx(databaseCtx, "rig.sql.conversation.create", async (txCtx) => {
            const inserted = await insertConversation(txCtx, record, models);
            if (!inserted) return;
            const snapshot = await this.#requiredSnapshot(txCtx, conversationId);
            await this.#projection.projectProtocolEvent(txCtx, conversationId, {
                createdAt,
                data: { session: snapshot },
                id: this.#nextEventId(),
                sessionId: conversationId,
                type: "session_created",
            });
        });
        return await this.#requiredSnapshot(databaseCtx, conversationId);
    }

    async readSnapshot(ctx: Context, conversationId: string): Promise<ProtocolSession | undefined> {
        return await this.#projection.readSnapshot(
            withDatabase(ctx, this.#database),
            conversationId,
        );
    }

    async list(ctx: Context, options: { limit?: number } = {}): Promise<readonly SessionSummary[]> {
        return await querySessionSummaries(withDatabase(ctx, this.#database), false, options);
    }

    async listActive(
        ctx: Context,
        options: { limit?: number } = {},
    ): Promise<readonly SessionSummary[]> {
        return await querySessionSummaries(withDatabase(ctx, this.#database), true, options);
    }

    async conversationIdForAgent(ctx: Context, agentId: string): Promise<string | undefined> {
        return await querySessionIdByAgentId(withDatabase(ctx, this.#database), agentId);
    }

    async events(ctx: Context, conversationId: string): Promise<readonly SessionEvent[]> {
        return await querySessionEvents(withDatabase(ctx, this.#database), conversationId);
    }

    async eventsSince(
        ctx: Context,
        conversationId: string,
        after?: EventId,
    ): Promise<readonly SessionEvent[]> {
        if (after === undefined) return await this.events(ctx, conversationId);
        return await inReadTx(
            withDatabase(ctx, this.#database),
            "rig.sql.conversation.events_since",
            async (txCtx) => {
                const anchor = await txCtx.tx
                    .select({ seq: sessionEvents.seq })
                    .from(sessionEvents)
                    .where(
                        and(
                            eq(sessionEvents.sessionId, conversationId),
                            eq(sessionEvents.eventId, after),
                        ),
                    )
                    .get();
                if (anchor === undefined) return [];
                const rows = await txCtx.tx
                    .select({
                        createdAtMs: sessionEvents.createdAtMs,
                        dataJson: sessionEvents.dataJson,
                        eventId: sessionEvents.eventId,
                        type: sessionEvents.type,
                    })
                    .from(sessionEvents)
                    .where(
                        and(
                            eq(sessionEvents.sessionId, conversationId),
                            sql`${sessionEvents.seq} > ${anchor.seq}`,
                        ),
                    )
                    .orderBy(sessionEvents.seq)
                    .all();
                return rows.map(
                    (row) =>
                        ({
                            createdAt: row.createdAtMs,
                            data: JSON.parse(row.dataJson) as SessionEvent["data"],
                            id: row.eventId,
                            sessionId: conversationId,
                            type: row.type as SessionEvent["type"],
                        }) as SessionEvent,
                );
            },
        );
    }

    async messageSubmission(ctx: Context, conversationId: string, messageId: string) {
        return await querySessionMessageSubmission(
            withDatabase(ctx, this.#database),
            conversationId,
            messageId,
        );
    }

    async transcriptPage(
        ctx: Context,
        conversationId: string,
        turnLimit: number,
        before?: string,
    ): Promise<SessionTranscriptWindow | undefined> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const page = await querySessionTranscriptPage(
            databaseCtx,
            conversationId,
            turnLimit,
            before,
        );
        if (page === undefined) return undefined;
        const firstPosition = page.messages[0]?.position;
        const hasEarlier =
            firstPosition !== undefined &&
            (await querySessionHasEarlierTranscriptMessage(
                databaseCtx,
                conversationId,
                firstPosition,
            ));
        return await this.#transcriptWindow(
            databaseCtx,
            conversationId,
            page.messages,
            turnLimit,
            !hasEarlier,
            page.noticesTruncated,
        );
    }

    async transcriptSince(
        ctx: Context,
        conversationId: string,
        turnLimit: number,
        after: EventId,
    ): Promise<SessionTranscriptWindow | undefined> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const range = await querySessionTranscriptSince(
            databaseCtx,
            conversationId,
            turnLimit,
            after,
        );
        if (range === undefined) return undefined;
        const lastPosition = range.messages.at(-1)?.position;
        const hasLater =
            lastPosition !== undefined &&
            (await querySessionHasLaterTranscriptMessage(
                databaseCtx,
                conversationId,
                lastPosition,
            ));
        return await this.#transcriptWindow(
            databaseCtx,
            conversationId,
            range.messages,
            turnLimit,
            !hasLater,
            range.truncated,
        );
    }

    async archive(
        ctx: Context,
        conversationId: string,
        archived: boolean,
        mutationId?: string,
    ): Promise<ProtocolSession | undefined> {
        return await this.#mutate(
            ctx,
            conversationId,
            ARCHIVE_MUTATION,
            mutationId,
            async (txCtx) => {
                const current = await this.#projection.readSnapshot(txCtx, conversationId);
                if (current === undefined) return undefined;
                if (current.archived === archived) return current;
                const now = this.#now();
                await txCtx.tx
                    .update(sessions)
                    .set({ archived, status: archived ? "archived" : "idle", updatedAtMs: now })
                    .where(eq(sessions.id, conversationId))
                    .run();
                await this.#projection.projectProtocolEvent(txCtx, conversationId, {
                    createdAt: now,
                    data: {
                        archived,
                        ...(mutationId === undefined ? {} : { mutationId }),
                    },
                    id: this.#nextEventId(),
                    sessionId: conversationId,
                    type: "session_archived",
                });
                return await this.#requiredSnapshot(txCtx, conversationId);
            },
        );
    }

    async markRead(ctx: Context, conversationId: string, mutationId?: string): Promise<boolean> {
        return await inTx(
            withDatabase(ctx, this.#database),
            "rig.sql.conversation.mark_read",
            async (txCtx) => {
                if (mutationId !== undefined) {
                    const receipt = await querySessionMutationReceipt(txCtx, {
                        action: MARK_READ_MUTATION,
                        mutationId,
                        sessionId: conversationId,
                    });
                    if (receipt === "conflict") {
                        throw new Error(
                            "That mutation ID was already used for another conversation change.",
                        );
                    }
                    if (receipt === "applied") return true;
                }
                const current = await this.#projection.readSnapshot(txCtx, conversationId);
                if (current === undefined || current.agent.type === "subagent") return false;
                if (current.unread === undefined) return false;
                const now = this.#now();
                await txCtx.tx
                    .update(sessions)
                    .set({ unreadReason: null, unreadSinceMs: null, updatedAtMs: now })
                    .where(eq(sessions.id, conversationId))
                    .run();
                await this.#projectUpdated(txCtx, conversationId, mutationId);
                if (mutationId !== undefined) {
                    await sessionRecordMutationReceipt(txCtx, {
                        action: MARK_READ_MUTATION,
                        mutationId,
                        now,
                        sessionId: conversationId,
                    });
                }
                return true;
            },
        );
    }

    async setDraft(
        ctx: Context,
        conversationId: string,
        request: SetSessionDraftRequest,
    ): Promise<ProtocolSession | undefined> {
        if (request.draft !== null && request.draft.length > SESSION_DRAFT_MAX_LENGTH) {
            throw new Error("The draft is too long to sync.");
        }
        return await this.#mutate(
            ctx,
            conversationId,
            DRAFT_MUTATION,
            request.mutationId,
            async (txCtx) => {
                const current = await this.#projection.readSnapshot(txCtx, conversationId);
                if (current === undefined) return undefined;
                const draft =
                    request.draft === null || request.draft.length === 0
                        ? undefined
                        : request.draft;
                const updatedAt = clampDraftTimestamp(request.updatedAt, this.#now());
                if (current.draftUpdatedAt !== undefined && updatedAt < current.draftUpdatedAt) {
                    return current;
                }
                if (current.draft === draft) return current;
                await txCtx.tx
                    .update(sessions)
                    .set({
                        draft: draft ?? null,
                        draftUpdatedAtMs: updatedAt,
                        updatedAtMs: this.#now(),
                    })
                    .where(eq(sessions.id, conversationId))
                    .run();
                await this.#projection.projectProtocolEvent(txCtx, conversationId, {
                    createdAt: this.#now(),
                    data: {
                        ...(draft === undefined ? {} : { draft }),
                        ...(request.mutationId === undefined
                            ? {}
                            : { mutationId: request.mutationId }),
                        ...(request.origin === undefined ? {} : { origin: request.origin }),
                        updatedAt,
                    },
                    id: this.#nextEventId(),
                    sessionId: conversationId,
                    type: "session_draft_changed",
                });
                return await this.#requiredSnapshot(txCtx, conversationId);
            },
        );
    }

    async updateMetadata(
        ctx: Context,
        conversationId: string,
        input: ConversationMetadataUpdate,
        mutationId?: string,
    ): Promise<ProtocolSession | undefined> {
        const update = Value.Decode(conversationMetadataUpdateSchema, input);
        return await this.#mutate(
            ctx,
            conversationId,
            METADATA_MUTATION,
            mutationId,
            async (txCtx) => {
                if ((await this.#projection.readSnapshot(txCtx, conversationId)) === undefined) {
                    return undefined;
                }
                const now = this.#now();
                await txCtx.tx
                    .update(sessions)
                    .set({
                        ...(update.metadataRunId === undefined
                            ? {}
                            : { metadataRunId: update.metadataRunId }),
                        ...(update.metadataUpdatedAt === undefined
                            ? {}
                            : { metadataUpdatedAtMs: update.metadataUpdatedAt }),
                        ...(update.recap === undefined ? {} : { recap: update.recap }),
                        ...(update.title === undefined ? {} : { title: update.title }),
                        ...(update.titleError === undefined
                            ? {}
                            : { titleError: update.titleError }),
                        ...(update.titleStatus === undefined
                            ? {}
                            : { titleStatus: update.titleStatus }),
                        updatedAtMs: now,
                    })
                    .where(eq(sessions.id, conversationId))
                    .run();
                if (update.titleStatus !== undefined) {
                    const projected = await this.#requiredSnapshot(txCtx, conversationId);
                    await this.#projection.projectProtocolEvent(txCtx, conversationId, {
                        createdAt: now,
                        data: {
                            ...(projected.titleError === undefined
                                ? {}
                                : { errorMessage: projected.titleError }),
                            ...(projected.metadataRunId === undefined
                                ? {}
                                : { metadataRunId: projected.metadataRunId }),
                            ...(projected.metadataUpdatedAt === undefined
                                ? {}
                                : { metadataUpdatedAt: projected.metadataUpdatedAt }),
                            ...(projected.recap === undefined ? {} : { recap: projected.recap }),
                            status: update.titleStatus,
                            ...(projected.title === undefined ? {} : { title: projected.title }),
                        },
                        id: this.#nextEventId(),
                        sessionId: conversationId,
                        type: "session_title_changed",
                    });
                } else {
                    await this.#projectUpdated(txCtx, conversationId, mutationId);
                }
                return await this.#requiredSnapshot(txCtx, conversationId);
            },
        );
    }

    async reorder(
        ctx: Context,
        conversationId: string,
        request: ReorderRequest,
        mutationId?: string,
    ): Promise<ProtocolSession | undefined> {
        return await this.#mutate(
            ctx,
            conversationId,
            REORDER_MUTATION,
            mutationId,
            async (txCtx) => {
                const current = await this.#projection.readSnapshot(txCtx, conversationId);
                if (current === undefined) return undefined;
                if (current.agent.type === "subagent") {
                    throw new Error("Subagent histories cannot be reordered.");
                }
                const items = await querySessionOrderItems(txCtx, current.scope);
                const orderKey = orderKeyAfter(items, conversationId, request.afterId);
                if (orderKey === current.orderKey) return current;
                await txCtx.tx
                    .update(sessions)
                    .set({ orderKey, updatedAtMs: this.#now() })
                    .where(eq(sessions.id, conversationId))
                    .run();
                await this.#projectUpdated(txCtx, conversationId, mutationId);
                return await this.#requiredSnapshot(txCtx, conversationId);
            },
        );
    }

    async move(
        ctx: Context,
        conversationId: string,
        input: {
            afterId?: string | null;
            cwd: string;
            mutationId?: string;
            scope: SessionScope;
        },
    ): Promise<ProtocolSession | undefined> {
        const databaseCtx = withDatabase(ctx, this.#database);
        if ((await this.#projection.readSnapshot(databaseCtx, conversationId)) === undefined) {
            return undefined;
        }
        if (input.mutationId !== undefined) {
            const receipt = await querySessionMutationReceipt(databaseCtx, {
                action: "move_scope",
                mutationId: input.mutationId,
                sessionId: conversationId,
            });
            if (receipt === "conflict") {
                throw new Error(
                    "That mutation ID was already used for another conversation change.",
                );
            }
            if (receipt === "applied") {
                return await this.#requiredSnapshot(databaseCtx, conversationId);
            }
        }
        await inTx(databaseCtx, "rig.sql.conversation.move", async (txCtx) => {
            await sessionMoveScope(txCtx, {
                ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
                cwd: input.cwd,
                now: this.#now(),
                scope: input.scope,
                sessionId: conversationId,
                ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
            });
            await this.#projectUpdated(txCtx, conversationId, input.mutationId);
        });
        return await this.#requiredSnapshot(databaseCtx, conversationId);
    }

    async mutationReceipt(
        ctx: Context,
        input: { action: string; mutationId: string; conversationId: string },
    ): Promise<SessionMutationReceiptResult> {
        return await querySessionMutationReceipt(withDatabase(ctx, this.#database), {
            action: input.action,
            mutationId: input.mutationId,
            sessionId: input.conversationId,
        });
    }

    async appendSystemNotice(
        ctx: Context,
        conversationId: string,
        payload: SystemNoticePayload,
    ): Promise<Extract<SessionEvent, { type: "system_notice" }> | undefined> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const notice = Value.Decode(systemNoticePayloadSchema, payload);
        return await inTx(
            databaseCtx,
            "rig.sql.conversation.append_system_notice",
            async (txCtx) => {
                if ((await this.#projection.readSnapshot(txCtx, conversationId)) === undefined) {
                    return undefined;
                }
                const message: SystemMessage = {
                    blocks: [{ text: notice.text, type: "text" }],
                    context: "excluded",
                    id: createId(),
                    role: "system",
                    ...(notice.structured === undefined ? {} : { structured: notice.structured }),
                };
                const latest = await txCtx.tx
                    .select({ position: sessionMessages.position })
                    .from(sessionMessages)
                    .where(eq(sessionMessages.sessionId, conversationId))
                    .orderBy(sql`${sessionMessages.position} DESC`)
                    .get();
                const now = this.#now();
                await sessionSaveMessage(
                    txCtx,
                    conversationId,
                    { message, position: (latest?.position ?? -1) + 1 },
                    now,
                );
                return await this.#projection.projectProtocolEvent(txCtx, conversationId, {
                    createdAt: now,
                    data: { message },
                    id: this.#nextEventId(),
                    sessionId: conversationId,
                    type: "system_notice",
                });
            },
        );
    }

    async attachment(
        ctx: Context,
        conversationId: string,
        attachmentId: string,
    ): Promise<Attachment | undefined> {
        return await querySessionAttachment(
            withDatabase(ctx, this.#database),
            conversationId,
            attachmentId,
        );
    }

    async #lastOrderKey(ctx: Context, scope: SessionScope): Promise<string> {
        const items = await querySessionOrderItems(ctx, scope);
        return generateKeyBetween(items.at(-1)?.orderKey ?? null, null);
    }

    async #mutate<T>(
        ctx: Context,
        conversationId: string,
        action: string,
        mutationId: string | undefined,
        body: (ctx: Context) => Promise<T>,
    ): Promise<T | undefined> {
        return await inTx(
            withDatabase(ctx, this.#database),
            `rig.sql.conversation.${action}`,
            async (txCtx) => {
                if (mutationId !== undefined) {
                    const receipt = await querySessionMutationReceipt(txCtx, {
                        action,
                        mutationId,
                        sessionId: conversationId,
                    });
                    if (receipt === "conflict") {
                        throw new Error(
                            "That mutation ID was already used for another conversation change.",
                        );
                    }
                    if (receipt === "applied") {
                        return (await this.#projection.readSnapshot(txCtx, conversationId)) as
                            | T
                            | undefined;
                    }
                }
                const result = await body(txCtx);
                if (result !== undefined && mutationId !== undefined) {
                    await sessionRecordMutationReceipt(txCtx, {
                        action,
                        mutationId,
                        now: this.#now(),
                        sessionId: conversationId,
                    });
                }
                return result;
            },
        );
    }

    async #projectUpdated(
        ctx: Context,
        conversationId: string,
        mutationId?: string,
    ): Promise<void> {
        const snapshot = await this.#requiredSnapshot(ctx, conversationId);
        await this.#projection.projectProtocolEvent(ctx, conversationId, {
            createdAt: this.#now(),
            data: {
                ...(mutationId === undefined ? {} : { mutationId }),
                session: snapshot,
            },
            id: this.#nextEventId(),
            sessionId: conversationId,
            type: "session_updated",
        });
    }

    async #requiredSnapshot(ctx: Context, conversationId: string): Promise<ProtocolSession> {
        const snapshot = await this.#projection.readSnapshot(ctx, conversationId);
        if (snapshot === undefined) {
            throw new Error(`The conversation '${conversationId}' does not exist.`);
        }
        return snapshot;
    }

    async #transcriptWindow(
        ctx: Context,
        conversationId: string,
        messages: readonly { message: Message; position: number; runId?: string }[],
        turnLimit: number,
        complete: boolean,
        noticesTruncated: boolean,
    ): Promise<SessionTranscriptWindow | undefined> {
        const events = await querySessionTranscriptEvents(ctx, conversationId, messages);
        const eventLog = new SessionEventLog({
            events,
            retentionLimit: Number.MAX_SAFE_INTEGER,
        });
        const entries = messages.map((entry): TranscriptEntry => {
            const createdAt = eventLog.messageCreatedAt(entry.message.id);
            const eventId = eventLog.messageEventId(entry.message.id);
            const steeredAt = eventLog.messageSteeredAt(entry.message.id);
            return {
                ...(createdAt === undefined ? {} : { createdAt }),
                ...(eventId === undefined ? {} : { eventId }),
                message: entry.message,
                ...(entry.runId === undefined ? {} : { runId: entry.runId }),
                ...(steeredAt === undefined ? {} : { steeredAt }),
            };
        });
        const window = sessionTranscriptWindow(entries, transcriptRunFacts(events), turnLimit);
        if (window === undefined) return undefined;
        const toolCallIds = new Set(
            window.messages.flatMap((message) =>
                message.blocks.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])),
            ),
        );
        const permissionReviews = eventLog.permissionReviews(toolCallIds);
        return {
            ...window,
            complete,
            ...(noticesTruncated ? { noticesTruncated: true } : {}),
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        };
    }
}

function inferCreation(
    request: CreateSessionRequest,
    explicitScope: SessionScope | undefined,
): { cwd: string; scope: SessionScope } {
    if (explicitScope !== undefined) return { cwd: request.cwd, scope: explicitScope };
    if (request.scope !== undefined) return { cwd: request.cwd, scope: request.scope };
    if (request.projectId !== undefined && request.workspaceId !== undefined) {
        return {
            cwd: request.cwd,
            scope: {
                kind: "workspace",
                projectId: request.projectId,
                workspaceId: request.workspaceId,
            },
        };
    }
    if (request.projectId !== undefined) {
        return { cwd: request.cwd, scope: { kind: "project", projectId: request.projectId } };
    }
    throw new Error(
        "Conversation creation requires a resolved project, workspace, folder, or Unsorted scope.",
    );
}

function resolveInitialModelSelection(
    catalog: ModelCatalog,
    requestedModelId: string,
    requestedProviderId: string,
): { model: Model; providerId: string } {
    const requestedProvider = catalog.providers.find(
        (provider) => provider.providerId === requestedProviderId,
    );
    const requested = requestedProvider?.models.find((model) => model.id === requestedModelId);
    if (requested !== undefined) return { model: requested, providerId: requestedProviderId };
    for (const provider of catalog.providers) {
        const model = provider.models.find((candidate) => candidate.id === requestedModelId);
        if (model !== undefined) return { model, providerId: provider.providerId };
    }
    const defaultProvider = catalog.providers.find(
        (provider) => provider.providerId === catalog.defaultProviderId,
    );
    const defaultModel = defaultProvider?.models.find(
        (model) => model.id === catalog.defaultModelId,
    );
    if (defaultModel !== undefined) {
        return { model: defaultModel, providerId: catalog.defaultProviderId };
    }
    for (const provider of catalog.providers) {
        const model = provider.models.find((candidate) => candidate.id === catalog.defaultModelId);
        if (model !== undefined) return { model, providerId: provider.providerId };
    }
    for (const provider of catalog.providers) {
        const model = provider.models[0];
        if (model !== undefined) return { model, providerId: provider.providerId };
    }
    throw new Error("No inference models are currently available.");
}

function clampDraftTimestamp(requested: number | undefined, now: number): number {
    if (requested === undefined) return now;
    return Math.min(Math.max(requested, now - SESSION_DRAFT_MAX_CLOCK_SKEW_MS), now);
}

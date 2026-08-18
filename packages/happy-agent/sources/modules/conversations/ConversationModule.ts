import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentBaseAcceptedMessage,
    type AgentBaseInference,
    type AgentBaseLoop,
    type AgentBaseSettlement,
    type AgentBaseTurn,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleAgentLifecycle,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createUuidV7Factory } from "@slopus/happy-agent-modules";
import type { SessionEvent } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

export const conversationSessionIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z0-9][a-z0-9_-]*$",
});

export const conversationScopeSchema = Type.Union([
    Type.Object({ kind: Type.Literal("unsorted") }, { additionalProperties: false }),
    Type.Object(
        { kind: Type.Literal("project"), projectId: Type.String({ minLength: 1, maxLength: 256 }) },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("workspace"),
            projectId: Type.String({ minLength: 1, maxLength: 256 }),
            workspaceId: Type.String({ minLength: 1, maxLength: 256 }),
        },
        { additionalProperties: false },
    ),
]);

export type ConversationScope = Static<typeof conversationScopeSchema>;

export const conversationStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("aborted"),
    Type.Literal("suspended"),
    Type.Literal("error"),
    Type.Literal("archived"),
]);

export type ConversationStatus = Static<typeof conversationStatusSchema>;

const conversationRecordSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1, maxLength: 128 }),
        archived: Type.Boolean(),
        createdAt: Type.Integer({ minimum: 0 }),
        cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
        draft: Type.Optional(Type.String({ maxLength: 100_000 })),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        id: conversationSessionIdSchema,
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        ownerInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
        permissionMode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        scope: conversationScopeSchema,
        serviceTier: Type.Optional(Type.Literal("fast")),
        status: conversationStatusSchema,
        titleStatus: Type.Union([Type.Literal("pending"), Type.Literal("ready")]),
        unread: Type.Boolean(),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export type ConversationRecord = Static<typeof conversationRecordSchema>;

export const conversationCreateInputSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1, maxLength: 128 }),
        cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        id: Type.Optional(conversationSessionIdSchema),
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        ownerInstanceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        permissionMode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        scope: Type.Optional(conversationScopeSchema),
        serviceTier: Type.Optional(Type.Literal("fast")),
    },
    { additionalProperties: false },
);

export type ConversationCreateInput = Static<typeof conversationCreateInputSchema>;

export const conversationUpdateSchema = Type.Object(
    {
        archived: Type.Optional(Type.Boolean()),
        draft: Type.Optional(Type.String({ maxLength: 100_000 })),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        scope: Type.Optional(conversationScopeSchema),
        serviceTier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Null()])),
        status: Type.Optional(conversationStatusSchema),
        unread: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export type ConversationUpdate = Static<typeof conversationUpdateSchema>;

export interface ConversationEvent {
    readonly id: string;
    readonly occurredAt: number;
    readonly payload: unknown;
    readonly sessionId: string;
    readonly type: string;
}

const conversationEventSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 256 }),
        occurredAt: Type.Integer({ minimum: 0 }),
        payload: Type.Unknown(),
        sessionId: conversationSessionIdSchema,
        type: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

interface ConversationRow {
    readonly agent_id: string;
    readonly archived: number;
    readonly created_at: number;
    readonly cwd: string;
    readonly draft: string | null;
    readonly effort: string | null;
    readonly model_id: string | null;
    readonly owner_instance_id: string;
    readonly permission_mode: string | null;
    readonly provider_id: string | null;
    readonly scope_json: string;
    readonly service_tier: string | null;
    readonly session_id: string;
    readonly status: string;
    readonly title_status: string;
    readonly unread: number;
    readonly updated_at: number;
}

interface ConversationEventRow {
    readonly event_id: string;
    readonly occurred_at: number;
    readonly payload_json: string;
    readonly session_id: string;
    readonly type: string;
}

/**
 * The durable protocol catalog for one Agent Base collection.
 *
 * It intentionally stores only public conversation metadata and a bounded protocol event
 * projection. Agent Base remains the owner of inference, message queues, and history; this module
 * only maps the visible session identity to the Agent Base identity and records host mutations.
 */
export class ConversationModule implements AgentModule<AnyAgentTool, LibSQLDatabase> {
    readonly name = "conversations";
    readonly migrations = [
        [
            "001-conversation-catalog",
            async (_ctx: Context, database: AgentDatabase) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_conversations (
                        session_id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL UNIQUE,
                        owner_instance_id TEXT NOT NULL,
                        cwd TEXT NOT NULL,
                        scope_json TEXT NOT NULL,
                        archived INTEGER NOT NULL DEFAULT 0,
                        unread INTEGER NOT NULL DEFAULT 0,
                        status TEXT NOT NULL DEFAULT 'idle',
                        title_status TEXT NOT NULL DEFAULT 'pending',
                        provider_id TEXT,
                        model_id TEXT,
                        permission_mode TEXT,
                        draft TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE INDEX IF NOT EXISTS happy_agent_conversations_updated
                        ON happy_agent_conversations (updated_at, session_id)`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_conversation_events (
                        event_id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        type TEXT NOT NULL,
                        occurred_at INTEGER NOT NULL,
                        payload_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE INDEX IF NOT EXISTS happy_agent_conversation_events_session
                        ON happy_agent_conversation_events (session_id, occurred_at, event_id)`,
                );
            },
        ],
        [
            "002-conversation-selection",
            async (_ctx: Context, database: AgentDatabase) => {
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE happy_agent_conversations ADD COLUMN effort TEXT`,
                );
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE happy_agent_conversations ADD COLUMN service_tier TEXT`,
                );
            },
        ],
    ] as const;

    readonly #clock: () => number;
    readonly #createEventId: () => string;
    readonly #defaultCwd: string;
    readonly #ownerInstanceId: string;

    constructor(options: {
        readonly defaultCwd?: string;
        readonly clock?: () => number;
        readonly ownerInstanceId?: string;
    }) {
        this.#defaultCwd = options.defaultCwd ?? process.cwd();
        this.#clock = options.clock ?? Date.now;
        this.#createEventId = createUuidV7Factory(this.#clock);
        this.#ownerInstanceId = options.ownerInstanceId ?? createId();
    }

    async ensure(ctx: Context, input: ConversationCreateInput): Promise<ConversationRecord> {
        assertConversationCreateInput(input);
        return await ctx.inTx(async (txCtx) => {
            return await this.#ensure(txCtx, txCtx.db, input);
        });
    }

    async get(ctx: Context, sessionId: string): Promise<ConversationRecord | undefined> {
        assertSessionId(sessionId);
        return await ctx.inTx(async (txCtx) => {
            return await this.#readBySession(txCtx, txCtx.db, sessionId);
        });
    }

    async getByAgent(ctx: Context, agentId: string): Promise<ConversationRecord | undefined> {
        if (!Value.Check(Type.String({ minLength: 1, maxLength: 128 }), agentId)) {
            throw new Error("Conversation agent ID is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            return await this.#readByAgent(txCtx, txCtx.db, agentId);
        });
    }

    async list(
        ctx: Context,
        query: { readonly archived?: boolean | "all"; readonly limit?: number } = {},
    ): Promise<readonly ConversationRecord[]> {
        const limit = query.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
            throw new Error("Conversation list limit must be between 1 and 50.");
        }
        return await ctx.inTx(async (txCtx) => {
            // Archiving a chat is how a person puts it away, so listing chats means the ones they
            // have not put away. Asking for everything is what `all` is for; leaving the question
            // unasked is not the same as asking for everything.
            const archived = query.archived === "all" ? undefined : (query.archived ?? false);
            const rows = await agentDatabaseRows<ConversationRow>(
                txCtx.db,
                archived === undefined
                    ? sql`SELECT * FROM happy_agent_conversations
                          ORDER BY updated_at DESC, session_id DESC LIMIT ${limit}`
                    : sql`SELECT * FROM happy_agent_conversations
                          WHERE archived = ${archived ? 1 : 0}
                          ORDER BY updated_at DESC, session_id DESC LIMIT ${limit}`,
            );
            return rows.map(rowFromDatabase);
        });
    }

    async update(
        ctx: Context,
        sessionId: string,
        update: ConversationUpdate,
    ): Promise<ConversationRecord> {
        assertSessionId(sessionId);
        if (!Value.Check(conversationUpdateSchema, update)) {
            throw new Error("Conversation update is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#readBySession(txCtx, txCtx.db, sessionId);
            if (current === undefined) throw new Error(`Session "${sessionId}" was not found.`);
            const candidate: Record<string, unknown> = {
                ...current,
                ...update,
                ...(update.draft === undefined ? {} : { draft: update.draft }),
                updatedAt: this.#now(),
            };
            if (update.serviceTier === null) delete candidate.serviceTier;
            const next = normalizeConversation(candidate);
            await agentDatabaseRun(
                txCtx.db,
                sql`UPDATE happy_agent_conversations SET
                    scope_json = ${JSON.stringify(next.scope)},
                    archived = ${next.archived ? 1 : 0},
                    unread = ${next.unread ? 1 : 0},
                    status = ${next.status},
                    provider_id = ${next.providerId ?? null},
                    model_id = ${next.modelId ?? null},
                    effort = ${next.effort ?? null},
                    service_tier = ${next.serviceTier ?? null},
                    permission_mode = ${next.permissionMode ?? null},
                    draft = ${next.draft ?? null},
                    updated_at = ${next.updatedAt}
                    WHERE session_id = ${sessionId}`,
            );
            return next;
        });
    }

    async appendEvent(
        ctx: Context,
        sessionId: string,
        input: { readonly type: string; readonly payload: unknown; readonly id?: string },
    ): Promise<ConversationEvent> {
        assertSessionId(sessionId);
        const inputSchema = Type.Object(
            {
                id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
                payload: Type.Unknown(),
                type: Type.String({ minLength: 1, maxLength: 128 }),
            },
            { additionalProperties: false },
        );
        if (!Value.Check(inputSchema, input))
            throw new Error("Conversation event input is invalid.");
        const id = input.id ?? this.#createEventId();
        if (
            !Value.Check(conversationEventSchema, {
                id,
                occurredAt: this.#now(),
                payload: input.payload,
                sessionId,
                type: input.type,
            })
        ) {
            throw new Error("Conversation event is invalid.");
        }
        const event: ConversationEvent = {
            id,
            occurredAt: this.#now(),
            payload: snapshot(input.payload),
            sessionId,
            type: input.type,
        };
        await ctx.inTx(async (txCtx) => {
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT OR IGNORE INTO happy_agent_conversation_events
                    (event_id, session_id, type, occurred_at, payload_json)
                    VALUES (${event.id}, ${event.sessionId}, ${event.type},
                        ${event.occurredAt}, ${JSON.stringify(event.payload)})`,
            );
        });
        return event;
    }

    async events(
        ctx: Context,
        sessionId: string,
        query: { readonly after?: string; readonly limit?: number } = {},
    ): Promise<readonly ConversationEvent[]> {
        assertSessionId(sessionId);
        const limit = query.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("Conversation event limit must be between 1 and 100.");
        }
        return await ctx.inTx(async (txCtx) => {
            const rows = await agentDatabaseRows<ConversationEventRow>(
                txCtx.db,
                query.after === undefined
                    ? sql`SELECT * FROM happy_agent_conversation_events
                          WHERE session_id = ${sessionId}
                          ORDER BY occurred_at, event_id LIMIT ${limit}`
                    : sql`SELECT * FROM happy_agent_conversation_events
                          WHERE session_id = ${sessionId} AND event_id > ${query.after}
                          ORDER BY occurred_at, event_id LIMIT ${limit}`,
            );
            return rows.map(eventFromDatabase);
        });
    }

    async recordAgentEvent(
        ctx: Context,
        agentId: string,
        type: string,
        payload: unknown,
    ): Promise<void> {
        const session = await this.getByAgent(ctx, agentId);
        if (session === undefined) return;
        await this.appendEvent(ctx, session.id, { type, payload });
    }

    readonly #hooks: AgentModuleHooks<AnyAgentTool, LibSQLDatabase> = {
        agentCreatedTransact: async (
            ctx: Context,
            _scope: AgentModuleSystemScope<LibSQLDatabase>,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.#ensure(ctx, ctx.db, {
                agentId: agent.id,
                cwd: this.#defaultCwd,
            });
        },

        agentRestoredTransact: async (
            ctx: Context,
            _scope: AgentModuleSystemScope<LibSQLDatabase>,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.#ensure(ctx, ctx.db, {
                agentId: agent.id,
                cwd: this.#defaultCwd,
            });
        },

        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope<LibSQLDatabase>,
            event: SessionEvent,
        ): Promise<void> => {
            await this.recordAgentEvent(ctx, scope.agent.id, "agent_event", event);
            // A run that ends badly must not settle as completed. Recording the failure here
            // rather than at settlement keeps the provider's own verdict authoritative; the next
            // run clears it again when the loop starts.
            if (event.type === "done" && event.state === "error") {
                const session = await this.getByAgent(ctx, scope.agent.id);
                if (session !== undefined) await this.update(ctx, session.id, { status: "error" });
            }
        },

        messageAccepted: async (
            ctx: Context,
            scope: AgentModuleScope<LibSQLDatabase>,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            await this.recordAgentEvent(ctx, scope.agent.id, "message_submitted", accepted);
        },

        beforeAgentLoop: async (
            ctx: Context,
            scope: AgentModuleScope<LibSQLDatabase>,
            loop: AgentBaseLoop,
        ): Promise<void> => {
            const session = await this.getByAgent(ctx, scope.agent.id);
            if (session === undefined) return;
            await this.update(ctx, session.id, { status: "running" });
            await this.appendEvent(ctx, session.id, { payload: loop, type: "run_started" });
        },

        afterInference: async (
            ctx: Context,
            scope: AgentModuleScope<LibSQLDatabase>,
            inference: AgentBaseInference,
        ): Promise<void> => {
            await this.recordAgentEvent(ctx, scope.agent.id, "inference_completed", inference);
        },

        afterTurn: async (
            ctx: Context,
            scope: AgentModuleScope<LibSQLDatabase>,
            turn: AgentBaseTurn,
        ): Promise<readonly never[]> => {
            await this.recordAgentEvent(ctx, scope.agent.id, "turn_completed", turn);
            // A cancelled turn is the only place the interruption is visible to this module: the
            // settlement that follows describes a run that ended, not why it ended. Recording it
            // here is what stops the settlement below from calling an interrupted run completed.
            if (turn.aborted) {
                const session = await this.getByAgent(ctx, scope.agent.id);
                if (session !== undefined) {
                    await this.update(ctx, session.id, { status: "aborted" });
                }
            }
            return [];
        },

        afterAgentSettled: async (
            ctx: Context,
            scope: AgentModuleScope<LibSQLDatabase>,
            settlement: AgentBaseSettlement,
        ): Promise<void> => {
            const session = await this.getByAgent(ctx, scope.agent.id);
            if (session === undefined) return;
            // A run that failed or was interrupted already says so, and settling is not what makes
            // it finished. The next run moves the session back to running when it starts.
            if (session.status !== "error" && session.status !== "aborted") {
                await this.update(ctx, session.id, { status: "completed" });
            }
            await this.appendEvent(ctx, session.id, {
                payload: settlement,
                type: "run_finished",
            });
        },
    };

    readonly beforeStart = (): AgentModuleHooks<AnyAgentTool, LibSQLDatabase> => this.#hooks;

    async #ensure(
        ctx: Context,
        database: AgentDatabase,
        input: ConversationCreateInput,
    ): Promise<ConversationRecord> {
        const existing = await this.#readByAgent(ctx, database, input.agentId);
        if (existing !== undefined) {
            if (input.id !== undefined && input.id !== existing.id) {
                throw new Error(`Agent "${input.agentId}" is already mapped to another session.`);
            }
            return existing;
        }
        const id = input.id ?? input.agentId;
        if (!Value.Check(conversationSessionIdSchema, id)) {
            throw new Error(`Conversation session ID "${id}" is invalid.`);
        }
        const now = this.#now();
        const record = normalizeConversation({
            agentId: input.agentId,
            archived: false,
            createdAt: now,
            cwd: input.cwd,
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
            ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
            ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
            ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
            id,
            ownerInstanceId: input.ownerInstanceId ?? this.#ownerInstanceId,
            scope: input.scope ?? { kind: "unsorted" },
            status: "idle",
            titleStatus: "pending",
            unread: false,
            updatedAt: now,
        });
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_conversations (
                session_id, agent_id, owner_instance_id, cwd, scope_json, archived, unread,
                status, title_status, provider_id, model_id, effort, service_tier,
                permission_mode, draft, created_at, updated_at
            ) VALUES (
                ${record.id}, ${record.agentId}, ${record.ownerInstanceId}, ${record.cwd},
                ${JSON.stringify(record.scope)}, 0, 0, ${record.status}, ${record.titleStatus},
                ${record.providerId ?? null}, ${record.modelId ?? null},
                ${record.effort ?? null}, ${record.serviceTier ?? null},
                ${record.permissionMode ?? null}, NULL, ${record.createdAt}, ${record.updatedAt}
            )`,
        );
        return record;
    }

    async #readBySession(
        _ctx: Context,
        database: AgentDatabase,
        sessionId: string,
    ): Promise<ConversationRecord | undefined> {
        const rows = await agentDatabaseRows<ConversationRow>(
            database,
            sql`SELECT * FROM happy_agent_conversations WHERE session_id = ${sessionId} LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : rowFromDatabase(row);
    }

    async #readByAgent(
        _ctx: Context,
        database: AgentDatabase,
        agentId: string,
    ): Promise<ConversationRecord | undefined> {
        const rows = await agentDatabaseRows<ConversationRow>(
            database,
            sql`SELECT * FROM happy_agent_conversations WHERE agent_id = ${agentId} LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : rowFromDatabase(row);
    }

    #now(): number {
        const now = Math.trunc(this.#clock());
        if (!Number.isSafeInteger(now) || now < 0)
            throw new Error("Conversation clock is invalid.");
        return now;
    }
}

function rowFromDatabase(row: ConversationRow): ConversationRecord {
    let scope: unknown;
    try {
        scope = JSON.parse(row.scope_json) as unknown;
    } catch {
        throw new Error("Conversation scope JSON is invalid.");
    }
    const record = {
        agentId: row.agent_id,
        archived: row.archived !== 0,
        createdAt: Number(row.created_at),
        cwd: row.cwd,
        ...(row.draft === null ? {} : { draft: row.draft }),
        ...(row.effort === null ? {} : { effort: row.effort }),
        id: row.session_id,
        ...(row.model_id === null ? {} : { modelId: row.model_id }),
        ownerInstanceId: row.owner_instance_id,
        ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
        ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
        scope,
        ...(row.service_tier === null ? {} : { serviceTier: row.service_tier }),
        status: row.status,
        titleStatus: row.title_status,
        unread: row.unread !== 0,
        updatedAt: Number(row.updated_at),
    };
    if (!Value.Check(conversationRecordSchema, record)) {
        throw new Error("Conversation catalog contains an invalid record.");
    }
    return record as ConversationRecord;
}

function eventFromDatabase(row: ConversationEventRow): ConversationEvent {
    let payload: unknown;
    try {
        payload = JSON.parse(row.payload_json) as unknown;
    } catch {
        throw new Error("Conversation event payload JSON is invalid.");
    }
    const event = {
        id: row.event_id,
        occurredAt: Number(row.occurred_at),
        payload,
        sessionId: row.session_id,
        type: row.type,
    };
    if (!Value.Check(conversationEventSchema, event)) {
        throw new Error("Conversation event is invalid.");
    }
    return event;
}

function normalizeConversation(input: Record<string, unknown>): ConversationRecord {
    const result = {
        ...input,
        ...(input.scope === undefined ? { scope: { kind: "unsorted" } } : {}),
    };
    if (!Value.Check(conversationRecordSchema, result)) {
        throw new Error("Conversation catalog input is invalid.");
    }
    return structuredClone(result) as ConversationRecord;
}

function assertConversationCreateInput(input: ConversationCreateInput): void {
    if (!Value.Check(conversationCreateInputSchema, input)) {
        throw new Error("Conversation create input is invalid.");
    }
    assertSessionId(input.id ?? input.agentId);
}

function assertSessionId(sessionId: string): void {
    if (!Value.Check(conversationSessionIdSchema, sessionId)) {
        throw new Error("Conversation session ID is invalid.");
    }
}

function snapshot(value: unknown): unknown {
    const encoded = JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
    );
    return encoded === undefined ? null : JSON.parse(encoded);
}

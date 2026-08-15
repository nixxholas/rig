import { AsyncLocalStorage } from "node:async_hooks";

import {
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
    type AgentStorageTransaction,
    withAgentDatabase,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    collaborationAgentPageQuerySchema,
    collaborationAgentSchema,
    type CollaborationAgent,
    type CollaborationAgentPage,
    type CollaborationAgentPageQuery,
} from "./CollaborationAgent.js";
import { collaborationMessageSchema, type CollaborationMessage } from "./CollaborationMessage.js";
import {
    collaborationObligationSchema,
    type CollaborationObligation,
    type CollaborationObligationPage,
    type CollaborationObligationPageQuery,
} from "./CollaborationMessage.js";
import type {
    CollaborationRoster,
    CollaborationStore,
} from "./CollaborationStore.js";

/**
 * The durable part of collaboration is deliberately implemented here, beside the module, rather
 * than in Rig. Agent Base installs these migrations before any agent starts and passes the active
 * Drizzle facade through every module scope.
 */
export const collaborationMigrations: readonly AgentModuleMigration[] = [
    [
        "001-collaboration",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_collaboration_agents (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    parent_id TEXT,
                    role TEXT,
                    group_id TEXT,
                    title TEXT,
                    metadata_json TEXT,
                    status TEXT NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_collaboration_agents_parent
                    ON happy_collaboration_agents(parent_id, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_collaboration_messages (
                    id TEXT PRIMARY KEY,
                    from_agent_id TEXT NOT NULL,
                    to_agent_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    reply_to TEXT,
                    obligation_id TEXT,
                    metadata_json TEXT,
                    created_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_collaboration_messages_recipient
                    ON happy_collaboration_messages(to_agent_id, created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_collaboration_obligations (
                    id TEXT PRIMARY KEY,
                    requester_agent_id TEXT NOT NULL,
                    responder_agent_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    answer_message_id TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_collaboration_obligations_requester
                    ON happy_collaboration_obligations(requester_agent_id, updated_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_collaboration_obligations_responder
                    ON happy_collaboration_obligations(responder_agent_id, updated_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_collaboration_receipts (
                    acting_agent_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY (acting_agent_id, kind, operation_id)
                )`,
            );
        },
    ],
    [
        "002-drop-collaboration-receipts",
        async (_ctx, database) => {
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS happy_collaboration_receipts`);
        },
    ],
];

export interface SqliteCollaborationStorageOptions<Database extends AgentDatabase = AgentDatabase> {
    /**
     * Optional for Agent Base hooks, which already carry the active database in their context.
     * Public calls made without an active database must provide this host transaction.
     */
    readonly transaction?: AgentStorageTransaction<Database>;
}

export interface SqliteCollaborationStorage {
    readonly roster: CollaborationRoster;
    readonly store: CollaborationStore;
}

export function createSqliteCollaborationStorage<Database extends AgentDatabase = AgentDatabase>(
    options: SqliteCollaborationStorageOptions<Database>,
): SqliteCollaborationStorage {
    const activeTransactions = new AsyncLocalStorage<true>();
    const dbFor = (ctx: Context): AgentDatabaseFacade<Database> =>
        (agentDatabase(ctx) ??
            (() => {
                throw new Error(
                    "Collaboration database access requires an AgentStorage transaction context.",
                );
            })()) as AgentDatabaseFacade<Database>;
    const json = (value: unknown): string => JSON.stringify(value);
    const parse = (value: unknown, label: string): unknown => {
        if (typeof value !== "string") throw new Error(`Collaboration ${label} is not JSON text.`);
        try {
            return JSON.parse(value) as unknown;
        } catch {
            throw new Error(`Collaboration ${label} contains invalid JSON.`);
        }
    };
    const number = (value: unknown, label: string): number => {
        const result = typeof value === "number" ? value : Number(value);
        if (!Number.isSafeInteger(result) || result < 0) {
            throw new Error(`Collaboration ${label} is not a valid timestamp.`);
        }
        return result;
    };
    const readAgentRow = (row: AgentRow): CollaborationAgent => {
        const metadataValue =
            row.metadata_json === null ? undefined : parse(row.metadata_json, "agent metadata");
        const agent = {
            id: row.id,
            ownerAgentId: row.owner_agent_id,
            parentId: row.parent_id,
            ...(row.role === null ? {} : { role: row.role }),
            ...(row.group_id === null ? {} : { groupId: row.group_id }),
            ...(row.title === null ? {} : { title: row.title }),
            ...(metadataValue === undefined ? {} : { metadata: metadataValue }),
            status: row.status,
            createdAt: number(row.created_at, "agent createdAt"),
            updatedAt: number(row.updated_at, "agent updatedAt"),
        };
        if (!ValueCheck(collaborationAgentSchema, agent)) {
            throw new Error("Collaboration database returned an invalid agent.");
        }
        return agent as CollaborationAgent;
    };
    const readMessageRow = (row: MessageRow): CollaborationMessage => {
        const metadataValue =
            row.metadata_json === null ? undefined : parse(row.metadata_json, "message metadata");
        const message = {
            id: row.id,
            fromAgentId: row.from_agent_id,
            toAgentId: row.to_agent_id,
            text: row.text,
            ...(row.reply_to === null ? {} : { replyTo: row.reply_to }),
            ...(row.obligation_id === null ? {} : { obligationId: row.obligation_id }),
            ...(metadataValue === undefined ? {} : { metadata: metadataValue }),
            createdAt: number(row.created_at, "message createdAt"),
        };
        if (!ValueCheck(collaborationMessageSchema, message)) {
            throw new Error("Collaboration database returned an invalid message.");
        }
        return message as CollaborationMessage;
    };
    const readObligationRow = (row: ObligationRow): CollaborationObligation => {
        const obligation = {
            id: row.id,
            requesterAgentId: row.requester_agent_id,
            responderAgentId: row.responder_agent_id,
            messageId: row.message_id,
            status: row.status,
            ...(row.answer_message_id === null ? {} : { answerMessageId: row.answer_message_id }),
            createdAt: number(row.created_at, "obligation createdAt"),
            updatedAt: number(row.updated_at, "obligation updatedAt"),
        };
        if (!ValueCheck(collaborationObligationSchema, obligation)) {
            throw new Error("Collaboration database returned an invalid obligation.");
        }
        return obligation as CollaborationObligation;
    };
    const readAgent = async (ctx: Context, id: string): Promise<CollaborationAgent | undefined> => {
        const rows = await agentDatabaseRows<AgentRow>(
            dbFor(ctx),
            sql`SELECT id, owner_agent_id, parent_id, role, group_id, title, metadata_json,
                       status, created_at, updated_at
                FROM happy_collaboration_agents WHERE id = ${id} LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : readAgentRow(rows[0]);
    };
    const writeAgent = async (ctx: Context, agent: CollaborationAgent): Promise<void> => {
        await agentDatabaseRun(
            dbFor(ctx),
            sql`INSERT INTO happy_collaboration_agents
                (id, owner_agent_id, parent_id, role, group_id, title, metadata_json, status, created_at, updated_at)
                VALUES (
                    ${agent.id}, ${agent.ownerAgentId}, ${agent.parentId},
                    ${agent.role ?? null}, ${agent.groupId ?? null}, ${agent.title ?? null},
                    ${agent.metadata === undefined ? null : json(agent.metadata)},
                    ${agent.status}, ${agent.createdAt}, ${agent.updatedAt}
                )
                ON CONFLICT(id) DO UPDATE SET
                    owner_agent_id = excluded.owner_agent_id,
                    parent_id = excluded.parent_id,
                    role = excluded.role,
                    group_id = excluded.group_id,
                    title = excluded.title,
                    metadata_json = excluded.metadata_json,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at`,
        );
    };
    const listAgents = async (
        ctx: Context,
        _actingAgentId: string,
        query: CollaborationAgentPageQuery,
    ): Promise<CollaborationAgentPage> => {
        if (!ValueCheck(collaborationAgentPageQuerySchema, query)) {
            throw new Error("Collaboration agent page query is invalid.");
        }
        const limit = query.limit ?? 50;
        const offset = cursorOffset(query.cursor);
        const group = query.groupId === undefined ? sql`` : sql` AND group_id = ${query.groupId}`;
        const owner =
            query.ownerAgentId === undefined
                ? sql``
                : sql` AND owner_agent_id = ${query.ownerAgentId}`;
        const rows = await agentDatabaseRows<AgentRow>(
            dbFor(ctx),
            sql`SELECT id, owner_agent_id, parent_id, role, group_id, title, metadata_json,
                       status, created_at, updated_at
                FROM happy_collaboration_agents
                WHERE 1 = 1${group}${owner}
                ORDER BY id
                LIMIT ${limit + 1} OFFSET ${offset}`,
        );
        const agents = rows.slice(0, limit).map(readAgentRow);
        return {
            agents,
            limit,
            ...(rows.length > limit ? { nextCursor: String(offset + agents.length) } : {}),
        };
    };
    const readMessage = async (
        ctx: Context,
        id: string,
    ): Promise<CollaborationMessage | undefined> => {
        const rows = await agentDatabaseRows<MessageRow>(
            dbFor(ctx),
            sql`SELECT id, from_agent_id, to_agent_id, text, reply_to, obligation_id,
                       metadata_json, created_at
                FROM happy_collaboration_messages WHERE id = ${id} LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : readMessageRow(rows[0]);
    };
    const writeMessage = async (ctx: Context, message: CollaborationMessage): Promise<void> => {
        await agentDatabaseRun(
            dbFor(ctx),
            sql`INSERT INTO happy_collaboration_messages
                (id, from_agent_id, to_agent_id, text, reply_to, obligation_id, metadata_json, created_at)
                VALUES (
                    ${message.id}, ${message.fromAgentId}, ${message.toAgentId}, ${message.text},
                    ${message.replyTo ?? null}, ${message.obligationId ?? null},
                    ${message.metadata === undefined ? null : json(message.metadata)}, ${message.createdAt}
                )
                ON CONFLICT(id) DO UPDATE SET
                    from_agent_id = excluded.from_agent_id,
                    to_agent_id = excluded.to_agent_id,
                    text = excluded.text,
                    reply_to = excluded.reply_to,
                    obligation_id = excluded.obligation_id,
                    metadata_json = excluded.metadata_json,
                    created_at = excluded.created_at`,
        );
    };
    const readObligation = async (
        ctx: Context,
        id: string,
    ): Promise<CollaborationObligation | undefined> => {
        const rows = await agentDatabaseRows<ObligationRow>(
            dbFor(ctx),
            sql`SELECT id, requester_agent_id, responder_agent_id, message_id, status,
                       answer_message_id, created_at, updated_at
                FROM happy_collaboration_obligations WHERE id = ${id} LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : readObligationRow(rows[0]);
    };
    const writeObligation = async (
        ctx: Context,
        obligation: CollaborationObligation,
    ): Promise<void> => {
        await agentDatabaseRun(
            dbFor(ctx),
            sql`INSERT INTO happy_collaboration_obligations
                (id, requester_agent_id, responder_agent_id, message_id, status, answer_message_id, created_at, updated_at)
                VALUES (
                    ${obligation.id}, ${obligation.requesterAgentId}, ${obligation.responderAgentId},
                    ${obligation.messageId}, ${obligation.status},
                    ${"answerMessageId" in obligation ? obligation.answerMessageId : null},
                    ${obligation.createdAt}, ${obligation.updatedAt}
                )
                ON CONFLICT(id) DO UPDATE SET
                    requester_agent_id = excluded.requester_agent_id,
                    responder_agent_id = excluded.responder_agent_id,
                    message_id = excluded.message_id,
                    status = excluded.status,
                    answer_message_id = excluded.answer_message_id,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at`,
        );
    };
    const listObligations = async (
        ctx: Context,
        _actingAgentId: string,
        query: CollaborationObligationPageQuery,
    ): Promise<CollaborationObligationPage> => {
        const limit = query.limit ?? 50;
        const offset = cursorOffset(query.cursor);
        const status = query.status === undefined ? sql`` : sql` AND status = ${query.status}`;
        const requester =
            query.requesterAgentId === undefined
                ? sql``
                : sql` AND requester_agent_id = ${query.requesterAgentId}`;
        const responder =
            query.responderAgentId === undefined
                ? sql``
                : sql` AND responder_agent_id = ${query.responderAgentId}`;
        const rows = await agentDatabaseRows<ObligationRow>(
            dbFor(ctx),
            sql`SELECT id, requester_agent_id, responder_agent_id, message_id, status,
                       answer_message_id, created_at, updated_at
                FROM happy_collaboration_obligations
                WHERE 1 = 1${status}${requester}${responder}
                ORDER BY updated_at, id
                LIMIT ${limit + 1} OFFSET ${offset}`,
        );
        const obligations = rows.slice(0, limit).map(readObligationRow);
        return {
            obligations,
            limit,
            ...(rows.length > limit ? { nextCursor: String(offset + obligations.length) } : {}),
        };
    };
    const inTransaction = async <Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> => {
        if (activeTransactions.getStore() === true) return await work(ctx);
        const transaction = options.transaction;
        if (transaction === undefined) {
            throw new Error(
                "Collaboration database access requires an active Agent Base database or host transaction.",
            );
        }
        return await transaction(ctx, async (txCtx, database) => {
            const activeCtx = withAgentDatabase(txCtx, database);
            return await activeTransactions.run(true, async () => await work(activeCtx));
        });
    };
    const readAgentInTransaction = (ctx: Context, id: string) =>
        inTransaction(ctx, (txCtx) => readAgent(txCtx, id));
    const writeAgentInTransaction = (ctx: Context, value: CollaborationAgent) =>
        inTransaction(ctx, (txCtx) => writeAgent(txCtx, value));
    const listAgentsInTransaction = (
        ctx: Context,
        actingAgentId: string,
        query: CollaborationAgentPageQuery,
    ) => inTransaction(ctx, (txCtx) => listAgents(txCtx, actingAgentId, query));
    const readMessageInTransaction = (ctx: Context, id: string) =>
        inTransaction(ctx, (txCtx) => readMessage(txCtx, id));
    const writeMessageInTransaction = (ctx: Context, value: CollaborationMessage) =>
        inTransaction(ctx, (txCtx) => writeMessage(txCtx, value));
    const readObligationInTransaction = (ctx: Context, id: string) =>
        inTransaction(ctx, (txCtx) => readObligation(txCtx, id));
    const writeObligationInTransaction = (ctx: Context, value: CollaborationObligation) =>
        inTransaction(ctx, (txCtx) => writeObligation(txCtx, value));
    const listObligationsInTransaction = (
        ctx: Context,
        actingAgentId: string,
        query: CollaborationObligationPageQuery,
    ) => inTransaction(ctx, (txCtx) => listObligations(txCtx, actingAgentId, query));
    const store = {
        transaction: async (
            ctx: Context,
            _actingAgentId: string,
            work: (txCtx: Context) => Promise<unknown>,
        ) => await inTransaction(ctx, work),
        readMessage: readMessageInTransaction,
        writeMessage: writeMessageInTransaction,
        readObligation: readObligationInTransaction,
        writeObligation: writeObligationInTransaction,
        listObligations: listObligationsInTransaction,
    } as CollaborationStore;
    const roster = {
        readAgent: readAgentInTransaction,
        writeAgent: writeAgentInTransaction,
        listAgents: listAgentsInTransaction,
    } as CollaborationRoster;
    return { roster, store };
}

interface AgentRow {
    readonly id: string;
    readonly owner_agent_id: string;
    readonly parent_id: string | null;
    readonly role: string | null;
    readonly group_id: string | null;
    readonly title: string | null;
    readonly metadata_json: string | null;
    readonly status: CollaborationAgent["status"];
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

interface MessageRow {
    readonly id: string;
    readonly from_agent_id: string;
    readonly to_agent_id: string;
    readonly text: string;
    readonly reply_to: string | null;
    readonly obligation_id: string | null;
    readonly metadata_json: string | null;
    readonly created_at: number | string;
}

interface ObligationRow {
    readonly id: string;
    readonly requester_agent_id: string;
    readonly responder_agent_id: string;
    readonly message_id: string;
    readonly status: CollaborationObligation["status"];
    readonly answer_message_id: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

function cursorOffset(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error("Collaboration cursor is invalid.");
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset)) throw new Error("Collaboration cursor is too large.");
    return offset;
}

/**
 * Keep the runtime checks local so this adapter does not expose a second TypeBox contract to
 * callers. The module revalidates every value at its public boundary.
 */
function ValueCheck(
    schema: Parameters<typeof import("@sinclair/typebox/value").Value.Check>[0],
    value: unknown,
): boolean {
    return Value.Check(schema, value);
}

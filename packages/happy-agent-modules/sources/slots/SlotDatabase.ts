import {
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    slotEntrySchema,
    slotScopeReferenceSchema,
    slotUpdateInputSchema,
    type SlotEntry,
    type SlotScopeReference,
    type SlotUpdateInput,
} from "./Slot.js";
import { slotPageSchema, type SlotPage, type SlotPageQuery } from "./SlotPage.js";
import {
    slotStoreCreateInputContractSchema,
    type SlotStoreCreateInput,
} from "./SlotStore.js";

export const SLOTS_MIGRATION_KEY = "001-slots";
export const SLOTS_IDEMPOTENCY_REMOVAL_MIGRATION_KEY = "002-remove-slot-idempotency";

const SLOTS_TABLE = "happy_agent_slots";

export const slotsMigrations: readonly AgentModuleMigration[] = [
    [
        SLOTS_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_slots (
                    id TEXT PRIMARY KEY,
                    author_agent_id TEXT NOT NULL,
                    slot TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    scope_ref TEXT,
                    content_json TEXT NOT NULL,
                    description TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    ordering INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_slots_order
                    ON happy_agent_slots(ordering, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_slot_receipts (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_slot_mutation_proofs (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
        },
    ],
    [
        SLOTS_IDEMPOTENCY_REMOVAL_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS happy_agent_slot_mutation_proofs`,
            );
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS happy_agent_slot_receipts`);
        },
    ],
];

export interface SlotDatabase {
    readonly list: (ctx: Context, agentId: string, query: SlotPageQuery) => Promise<SlotPage>;
    readonly get: (ctx: Context, agentId: string, id: string) => Promise<SlotEntry | undefined>;
    readonly create: (
        ctx: Context,
        agentId: string,
        input: SlotStoreCreateInput,
    ) => Promise<SlotEntry>;
    readonly update: (
        ctx: Context,
        agentId: string,
        id: string,
        changes: SlotUpdateInput,
    ) => Promise<SlotEntry>;
    readonly reorder: (
        ctx: Context,
        agentId: string,
        entryIds: readonly string[],
    ) => Promise<readonly SlotEntry[]>;
    readonly remove: (
        ctx: Context,
        agentId: string,
        id: string,
    ) => Promise<SlotEntry | undefined>;
}

export function createSlotDatabase(): SlotDatabase {
    const databaseFor = (ctx: Context): AgentDatabase => {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Slots module requires an Agent Base database context.");
        }
        return database;
    };

    const readEntry = (row: SlotRow): SlotEntry => {
        const entry = {
            id: row.id,
            authorAgentId: row.author_agent_id,
            slot: row.slot,
            content: parseJson(row.content_json, "slot content"),
            description: row.description,
            purpose: row.purpose,
            ordering: integer(row.ordering, "slot ordering"),
            createdAt: integer(row.created_at, "slot createdAt"),
            updatedAt: integer(row.updated_at, "slot updatedAt"),
            ...scopeFromRow(row),
        };
        if (!Value.Check(slotEntrySchema, entry)) {
            throw new Error("Slots database contains an invalid entry.");
        }
        return structuredClone(entry) as SlotEntry;
    };

    const list = async (
        ctx: Context,
        _agentId: string,
        query: SlotPageQuery,
    ): Promise<SlotPage> => {
        const clauses = [sql`1 = 1`];
        if (query.slot !== undefined) clauses.push(sql`slot = ${query.slot}`);
        if ("scope" in query) {
            clauses.push(sql`scope = ${query.scope}`);
            if (query.scope === "project") clauses.push(sql`scope_ref = ${query.projectId}`);
            if (query.scope === "workspace") clauses.push(sql`scope_ref = ${query.workspaceId}`);
            if (query.scope === "session") clauses.push(sql`scope_ref = ${query.sessionId}`);
        }
        const limit = query.limit ?? 100;
        const cursor = query.cursor ?? 0;
        const rows = await agentDatabaseRows<SlotRow>(
            databaseFor(ctx),
            sql`SELECT id, author_agent_id, slot, scope, scope_ref, content_json,
                       description, purpose, ordering, created_at, updated_at
                FROM ${sql.raw(SLOTS_TABLE)}
                WHERE ${sql.join(clauses, sql` AND `)}
                ORDER BY ordering, id
                LIMIT ${limit} OFFSET ${cursor}`,
        );
        const page = {
            entries: rows.map(readEntry),
            limit,
            ...(rows.length === limit ? { nextCursor: cursor + rows.length } : {}),
        };
        if (!Value.Check(slotPageSchema, page)) {
            throw new Error("Slots database produced an invalid page.");
        }
        return page;
    };

    const get = async (
        ctx: Context,
        _agentId: string,
        id: string,
    ): Promise<SlotEntry | undefined> => {
        const rows = await agentDatabaseRows<SlotRow>(
            databaseFor(ctx),
            sql`SELECT id, author_agent_id, slot, scope, scope_ref, content_json,
                       description, purpose, ordering, created_at, updated_at
                FROM ${sql.raw(SLOTS_TABLE)} WHERE id = ${id} LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : readEntry(rows[0]);
    };

    const create = async (
        ctx: Context,
        _agentId: string,
        input: SlotStoreCreateInput,
    ): Promise<SlotEntry> => {
        if (!Value.Check(slotStoreCreateInputContractSchema, input)) {
            throw new Error("Slots database received invalid create input.");
        }
        const rows = await agentDatabaseRows<{ ordering: number | string }>(
            databaseFor(ctx),
            sql`SELECT COALESCE(MAX(ordering), -1) + 1 AS ordering
                FROM ${sql.raw(SLOTS_TABLE)}`,
        );
        const at = Date.now();
        const entry = {
            ...structuredClone(input),
            ordering: Math.max(0, integer(rows[0]?.ordering ?? 0, "slot ordering")),
            createdAt: at,
            updatedAt: at,
        };
        if (!Value.Check(slotEntrySchema, entry)) {
            throw new Error("Slots database entry is invalid.");
        }
        await agentDatabaseRun(
            databaseFor(ctx),
            sql`INSERT INTO ${sql.raw(SLOTS_TABLE)}
                (id, author_agent_id, slot, scope, scope_ref, content_json,
                 description, purpose, ordering, created_at, updated_at)
                VALUES (
                    ${entry.id}, ${entry.authorAgentId}, ${entry.slot}, ${entry.scope},
                    ${scopeRef(entry)}, ${JSON.stringify(entry.content)},
                    ${entry.description}, ${entry.purpose}, ${entry.ordering},
                    ${entry.createdAt}, ${entry.updatedAt}
                )`,
        );
        return structuredClone(entry);
    };

    const update = async (
        ctx: Context,
        agentId: string,
        id: string,
        changes: SlotUpdateInput,
    ): Promise<SlotEntry> => {
        if (!Value.Check(slotUpdateInputSchema, changes)) {
            throw new Error("Slots database received invalid update input.");
        }
        const current = await get(ctx, agentId, id);
        if (current === undefined) throw new Error("Slot entry does not exist.");
        const next = { ...current, ...structuredClone(changes), updatedAt: Date.now() };
        if (!Value.Check(slotEntrySchema, next)) {
            throw new Error("Slots database entry is invalid.");
        }
        await agentDatabaseRun(
            databaseFor(ctx),
            sql`UPDATE ${sql.raw(SLOTS_TABLE)}
                SET slot = ${next.slot}, content_json = ${JSON.stringify(next.content)},
                    description = ${next.description}, purpose = ${next.purpose},
                    updated_at = ${next.updatedAt}
                WHERE id = ${id}`,
        );
        return structuredClone(next);
    };

    const reorder = async (
        ctx: Context,
        agentId: string,
        entryIds: readonly string[],
    ): Promise<readonly SlotEntry[]> => {
        const entries: SlotEntry[] = [];
        for (const [ordering, id] of entryIds.entries()) {
            const entry = await get(ctx, agentId, id);
            if (entry === undefined) throw new Error(`Slot entry "${id}" does not exist.`);
            const updatedAt = Date.now();
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`UPDATE ${sql.raw(SLOTS_TABLE)}
                    SET ordering = ${ordering}, updated_at = ${updatedAt}
                    WHERE id = ${id}`,
            );
            entries.push({ ...entry, ordering, updatedAt });
        }
        return entries;
    };

    const remove = async (
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SlotEntry | undefined> => {
        const entry = await get(ctx, agentId, id);
        if (entry === undefined) return undefined;
        await agentDatabaseRun(
            databaseFor(ctx),
            sql`DELETE FROM ${sql.raw(SLOTS_TABLE)} WHERE id = ${id}`,
        );
        await agentDatabaseRun(
            databaseFor(ctx),
            sql`UPDATE ${sql.raw(SLOTS_TABLE)}
                SET ordering = ordering - 1
                WHERE ordering > ${entry.ordering}`,
        );
        return entry;
    };

    return { list, get, create, update, reorder, remove };
}

interface SlotRow {
    readonly id: string;
    readonly author_agent_id: string;
    readonly slot: string;
    readonly scope: string;
    readonly scope_ref: string | null;
    readonly content_json: string;
    readonly description: string;
    readonly purpose: string;
    readonly ordering: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

function scopeFromRow(row: SlotRow): SlotScopeReference {
    switch (row.scope) {
        case "everywhere":
            return { scope: "everywhere" };
        case "project":
            return { scope: "project", projectId: requireScopeRef(row.scope_ref) };
        case "workspace":
            return { scope: "workspace", workspaceId: requireScopeRef(row.scope_ref) };
        case "session":
            return { scope: "session", sessionId: requireScopeRef(row.scope_ref) };
        default:
            throw new Error("Slots database contains an invalid scope.");
    }
}

function scopeRef(entry: SlotScopeReference): string | null {
    switch (entry.scope) {
        case "everywhere":
            return null;
        case "project":
            return entry.projectId;
        case "workspace":
            return entry.workspaceId;
        case "session":
            return entry.sessionId;
    }
}

function requireScopeRef(value: string | null): string {
    if (value === null || !Value.Check(Type.String(), value)) {
        throw new Error("Slots database contains a missing scope reference.");
    }
    return value;
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Slots database ${label} is not valid JSON.`);
    }
}

function integer(value: unknown, label: string): number {
    const result = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ${label}.`);
    return result;
}
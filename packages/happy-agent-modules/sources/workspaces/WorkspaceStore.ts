import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import {
    workspaceAgentIdSchema,
    workspaceIdSchema,
    workspaceMutationOperationSchema,
    workspaceOperationIdSchema,
    workspaceNameSchema,
    workspacePathSchema,
    workspaceProjectRefSchema,
    workspaceSchema,
    workspaceTimestampSchema,
    type Workspace,
} from "./Workspace.js";
import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";
import { workspaceContextSchema, workspaceEventSchema } from "./WorkspaceEvent.js";
import {
    workspacePageQuerySchema,
    workspacePageSchema,
    workspaceListSchema,
    type WorkspacePage,
    type WorkspacePageQuery,
    type WorkspaceList,
} from "./WorkspacePage.js";
import {
    workspaceTransferInputSchema,
    workspaceTransferResultSchema,
    workspaceTransferStoreResultSchema,
    type WorkspaceTransferInput,
    type WorkspaceTransferResult,
    type WorkspaceTransferStoreResult,
} from "./WorkspaceTransfer.js";

export const workspaceMutationRequestSchema = Type.Object(
    {
        operation: workspaceMutationOperationSchema,
        operationId: workspaceOperationIdSchema,
    },
    { additionalProperties: false },
);

/**
 * The module adds `ownerAgentId` before crossing the host boundary. The
 * project reference remains optional because a host may resolve a default
 * project while creating the row.
 */
export const workspaceStoreCreateInputSchema = Type.Object(
    {
        id: workspaceIdSchema,
        ownerAgentId: workspaceAgentIdSchema,
        projectRef: Type.Optional(workspaceProjectRefSchema),
        path: Type.Optional(workspacePathSchema),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    },
    { additionalProperties: false },
);

export const workspaceStoreArchiveInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

export const workspaceStoreRenameInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
        expectedUpdatedAt: Type.Optional(workspaceTimestampSchema),
    },
    { additionalProperties: false },
);

const workspaceMutationEnvelope = {
    agentId: workspaceAgentIdSchema,
    operationId: workspaceOperationIdSchema,
    changed: Type.Boolean(),
} as const;

export const workspaceCreateResultSchema = Type.Object(
    {
        ...workspaceMutationEnvelope,
        operation: Type.Literal("create"),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceArchiveResultSchema = Type.Object(
    {
        ...workspaceMutationEnvelope,
        operation: Type.Literal("archive"),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceRenameResultSchema = Type.Object(
    {
        ...workspaceMutationEnvelope,
        operation: Type.Literal("rename"),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceCreateStoreResultSchema = Type.Union([
    workspaceCreateResultSchema,
    workspaceSchema,
    Type.Undefined(),
    Type.Void(),
]);

export const workspaceArchiveStoreResultSchema = Type.Union([
    workspaceArchiveResultSchema,
    workspaceSchema,
    Type.Undefined(),
    Type.Void(),
]);

export const workspaceRenameStoreResultSchema = Type.Union([
    workspaceRenameResultSchema,
    workspaceSchema,
    Type.Undefined(),
    Type.Void(),
]);

export const workspaceStoreMutationResultSchema = Type.Union([
    workspaceCreateResultSchema,
    workspaceRenameResultSchema,
    workspaceArchiveResultSchema,
    workspaceTransferResultSchema,
]);

export const workspaceTransactionChangeSchema = Type.Object(
    {
        result: workspaceStoreMutationResultSchema,
        event: Type.Optional(workspaceEventSchema),
    },
    { additionalProperties: false },
);

export const workspaceAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("branch_metadata"),
    Type.Literal("transfer"),
]);

/**
 * Missing authorization is an intentional deny for another owner's record.
 * Self access is granted by the module without invoking this policy.
 */
export const workspaceAuthorizationSchema = Type.Function(
    [
        workspaceContextSchema,
        workspaceAgentIdSchema,
        workspaceAgentIdSchema,
        workspaceAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

export type WorkspaceAuthorizationAction = Static<typeof workspaceAuthorizationActionSchema>;
export type WorkspaceAuthorization = Static<typeof workspaceAuthorizationSchema>;

/**
 * This contract is private to the module-owned SQLite adapter. Callers
 * configure a narrow host operation service instead of injecting a store.
 */
export const workspaceStoreSchema = Type.Object(
    {
        create: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceStoreCreateInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceCreateResultSchema),
        ),
        list: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspacePageQuerySchema],
            Type.Promise(workspacePageSchema),
        ),
        get: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
            Type.Promise(Type.Union([workspaceSchema, Type.Undefined()])),
        ),
        transfer: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceTransferInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceTransferStoreResultSchema),
        ),
        archive: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceStoreArchiveInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceArchiveResultSchema),
        ),
        rename: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceStoreRenameInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceRenameResultSchema),
        ),
        branchMetadata: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
            Type.Promise(workspaceBranchMetadataSchema),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceStore = Static<typeof workspaceStoreSchema>;
export type WorkspaceStoreCreateInput = Static<typeof workspaceStoreCreateInputSchema>;
export type WorkspaceStoreArchiveInput = Static<typeof workspaceStoreArchiveInputSchema>;
export type WorkspaceStoreRenameInput = Static<typeof workspaceStoreRenameInputSchema>;
export type WorkspaceMutationRequest = Static<typeof workspaceMutationRequestSchema>;
export type WorkspaceCreateResult = Static<typeof workspaceCreateResultSchema>;
export type WorkspaceArchiveResult = Static<typeof workspaceArchiveResultSchema>;
export type WorkspaceRenameResult = Static<typeof workspaceRenameResultSchema>;
export type WorkspaceCreateStoreResult = Static<typeof workspaceCreateStoreResultSchema>;
export type WorkspaceArchiveStoreResult = Static<typeof workspaceArchiveStoreResultSchema>;
export type WorkspaceRenameStoreResult = Static<typeof workspaceRenameStoreResultSchema>;
export type WorkspaceStoreMutationResult = Static<typeof workspaceStoreMutationResultSchema>;
export type WorkspaceTransactionChange = Static<typeof workspaceTransactionChangeSchema>;

export type {
    Workspace,
    WorkspaceBranchMetadata,
    WorkspacePage,
    WorkspacePageQuery,
    WorkspaceTransferInput,
    WorkspaceTransferResult,
    WorkspaceTransferStoreResult,
};

export function assertWorkspaceStore(value: unknown): asserts value is WorkspaceStore {
    if (!Value.Check(workspaceStoreSchema, value)) {
        throw new Error("Workspace module received an invalid host store.");
    }
}
export function assertWorkspace(value: unknown): asserts value is Workspace {
    if (!Value.Check(workspaceSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace.");
    }
}
export function assertWorkspacePage(value: unknown): asserts value is WorkspacePage {
    if (!Value.Check(workspacePageSchema, value)) {
        throw new Error("Workspace store returned an invalid page.");
    }
}

export function assertWorkspaceList(value: unknown): asserts value is WorkspaceList {
    if (!Value.Check(workspaceListSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace list.");
    }
}

export function assertWorkspaceBranchMetadata(
    value: unknown,
): asserts value is WorkspaceBranchMetadata {
    if (!Value.Check(workspaceBranchMetadataSchema, value)) {
        throw new Error("Workspace store returned invalid branch metadata.");
    }
}

export function assertWorkspaceCreateResult(
    value: unknown,
): asserts value is WorkspaceCreateResult {
    if (!Value.Check(workspaceCreateResultSchema, value)) {
        throw new Error("Workspace store returned an invalid create result.");
    }
}

export function assertWorkspaceArchiveResult(
    value: unknown,
): asserts value is WorkspaceArchiveResult {
    if (!Value.Check(workspaceArchiveResultSchema, value)) {
        throw new Error("Workspace store returned an invalid archive result.");
    }
}

export function assertWorkspaceRenameResult(
    value: unknown,
): asserts value is WorkspaceRenameResult {
    if (!Value.Check(workspaceRenameResultSchema, value)) {
        throw new Error("Workspace store returned an invalid rename result.");
    }
}

export function assertWorkspaceStoreMutationResult(
    value: unknown,
): asserts value is WorkspaceStoreMutationResult {
    if (!Value.Check(workspaceStoreMutationResultSchema, value)) {
        throw new Error("Workspace store returned an invalid mutation result.");
    }
}

export function assertWorkspaceTransferResult(
    value: unknown,
): asserts value is WorkspaceTransferResult {
    if (!Value.Check(workspaceTransferResultSchema, value)) {
        throw new Error("Workspace store returned an invalid transfer result.");
    }
}

export function assertWorkspaceTransactionChange(
    value: unknown,
): asserts value is WorkspaceTransactionChange {
    if (!Value.Check(workspaceTransactionChangeSchema, value)) {
        throw new Error("Workspace store transaction returned an invalid change.");
    }
}

export const workspaceHostSchema = Type.Object(
    {
        create: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceStoreCreateInputSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(workspaceCreateStoreResultSchema),
            ),
        ),
        archive: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceStoreArchiveInputSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(workspaceArchiveStoreResultSchema),
            ),
        ),
        rename: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceStoreRenameInputSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(workspaceRenameStoreResultSchema),
            ),
        ),
        branchMetadata: Type.Optional(
            Type.Function(
                [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
                Type.Promise(workspaceBranchMetadataSchema),
            ),
        ),
        transfer: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceTransferInputSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(workspaceTransferStoreResultSchema),
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceHost = Static<typeof workspaceHostSchema>;

export const workspaceStoreOptionsSchema = Type.Object(
    { host: Type.Optional(workspaceHostSchema) },
    { additionalProperties: false },
);

export type WorkspaceStoreOptions = Static<typeof workspaceStoreOptionsSchema>;

type WorkspaceRow = {
    readonly id: string;
    readonly owner_agent_id: string;
    readonly project_ref: string;
    readonly base_ref: string | null;
    readonly name: string;
    readonly status: string;
    readonly path: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly archived_at: number | string | null;
};

const WORKSPACE_MIGRATION_KEY = "001-workspaces-catalog";
const WORKSPACES_TABLE = "happy_agent_module_workspaces";
const WORKSPACE_RECEIPTS_TABLE = "happy_agent_module_workspace_operation_receipts";
const WORKSPACE_PROOFS_TABLE = "happy_agent_module_workspace_mutation_proofs";

/** Durable workspace catalog owned by the workspaces module. */
export const workspaceMigrations = [
    [
        WORKSPACE_MIGRATION_KEY,
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKSPACES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    project_ref TEXT NOT NULL,
                    base_ref TEXT,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_project_id`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKSPACE_RECEIPTS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKSPACE_PROOFS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
        },
    ],
    [
        "002-drop-workspace-replay-state",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(WORKSPACE_RECEIPTS_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(WORKSPACE_PROOFS_TABLE)}`,
            );
        },
    ],
    [
        "003-workspace-path",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(WORKSPACES_TABLE)} ADD COLUMN path TEXT`,
            );
        },
    ],
] as const;

export function createWorkspaceStore(options: WorkspaceStoreOptions = {}): WorkspaceStore {
    if (!Value.Check(workspaceStoreOptionsSchema, options)) {
        throw new Error("Workspace store options are invalid.");
    }
    return {
        create: async (ctx, actingAgentId, input, operation) => {
            const hostResult =
                options.host?.create === undefined
                    ? undefined
                    : await options.host.create(ctx, actingAgentId, input, operation);
            if (hostResult !== undefined) {
                const result = normalizeCreateStoreResult(
                    hostResult,
                    actingAgentId,
                    input,
                    operation,
                );
                await insertWorkspace(ctx.db, result.workspace);
                return result;
            }
            const at = Date.now();
            const workspace: Workspace = {
                id: input.id,
                ownerAgentId: input.ownerAgentId,
                projectRef: input.projectRef ?? "default",
                ...(input.path === undefined ? {} : { path: input.path }),
                ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                name: input.name,
                status: "ready",
                createdAt: at,
                updatedAt: at,
            };
            assertWorkspace(workspace);
            await insertWorkspace(ctx.db, workspace);
            return {
                operation: "create",
                agentId: actingAgentId,
                operationId: operation.operationId,
                changed: true,
                workspace,
            };
        },
        list: async (ctx, _agentId, query) => {
            const offset = query.cursor === undefined ? 0 : Number(query.cursor);
            const limit = query.limit ?? 50;
            const database = ctx.db;
            const rows = await agentDatabaseRows<WorkspaceRow>(
                database,
                query.projectRef === undefined
                    ? query.includeArchived !== false
                        ? sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)} ORDER BY id LIMIT ${limit} OFFSET ${offset}`
                        : sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                               WHERE status NOT IN ('archived', 'archiving')
                               ORDER BY id LIMIT ${limit} OFFSET ${offset}`
                    : query.includeArchived !== false
                      ? sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                             WHERE project_ref = ${query.projectRef}
                             ORDER BY id LIMIT ${limit} OFFSET ${offset}`
                      : sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                             WHERE project_ref = ${query.projectRef}
                               AND status NOT IN ('archived', 'archiving')
                             ORDER BY id LIMIT ${limit} OFFSET ${offset}`,
            );
            const workspaces = rows.map(workspaceFromRow);
            return {
                workspaces,
                ...(workspaces.length === limit
                    ? { nextCursor: String(offset + workspaces.length) }
                    : {}),
            };
        },
        get: async (ctx, _agentId, workspaceId) => {
            const rows = await agentDatabaseRows<WorkspaceRow>(
                ctx.db,
                sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                    WHERE id = ${workspaceId} LIMIT 1`,
            );
            const row = rows[0];
            return row === undefined ? undefined : workspaceFromRow(row);
        },
        transfer: async (ctx, actingAgentId, input, operation) => {
            const database = ctx.db;
            const hostResult =
                options.host?.transfer === undefined
                    ? undefined
                    : await options.host.transfer(ctx, actingAgentId, input, operation);
            const result =
                hostResult ??
                (await defaultWorkspaceTransfer(database, actingAgentId, input, operation));
            if (Value.Check(workspaceSchema, result)) {
                await persistWorkspace(database, result);
                return {
                    agentId: actingAgentId,
                    operationId: operation.operationId,
                    changed: true,
                    state: "transferred",
                    workspace: {
                        id: result.id,
                        projectRef: result.projectRef,
                        ownerAgentId: result.ownerAgentId,
                        ...(result.path === undefined ? {} : { path: result.path }),
                    },
                };
            }
            if (result.state === "transferred") {
                const current = await readWorkspace(database, result.workspace.id);
                if (current === undefined) {
                    throw new Error("Workspace transfer host returned a missing workspace.");
                }
                if (current.projectRef !== result.workspace.projectRef) {
                    await agentDatabaseRun(
                        database,
                        sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
                            SET project_ref = ${result.workspace.projectRef},
                                updated_at = ${Date.now()}
                            WHERE id = ${result.workspace.id}`,
                    );
                }
            } else {
                await agentDatabaseRun(
                    database,
                    sql`UPDATE ${sql.raw(WORKSPACES_TABLE)} SET updated_at = ${Date.now()}
                        WHERE id = ${result.targetWorkspaceId}`,
                );
            }
            return result;
        },
        rename: async (ctx, actingAgentId, input, operation) => {
            const database = ctx.db;
            const before = await readWorkspace(database, input.workspaceId);
            if (before === undefined) {
                throw new Error(`Workspace "${input.workspaceId}" was not found.`);
            }
            if (
                input.expectedUpdatedAt !== undefined &&
                input.expectedUpdatedAt !== before.updatedAt
            ) {
                throw new Error("Workspace changed before it could be renamed.");
            }
            const hostResult =
                options.host?.rename === undefined
                    ? undefined
                    : await options.host.rename(ctx, actingAgentId, input, operation);
            if (hostResult !== undefined) {
                const result = normalizeRenameStoreResult(
                    hostResult,
                    actingAgentId,
                    input,
                    operation,
                    before,
                );
                if (result.workspace.id !== input.workspaceId) {
                    throw new Error("Workspace rename host returned a different workspace.");
                }
                await persistWorkspace(database, result.workspace);
                return result;
            }
            const changed = before.name !== input.name;
            const updatedAt = changed
                ? Math.max(Date.now(), before.updatedAt + 1)
                : before.updatedAt;
            if (changed) {
                await agentDatabaseRun(
                    database,
                    sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
                        SET name = ${input.name}, updated_at = ${updatedAt}
                        WHERE id = ${input.workspaceId}`,
                );
            }
            return {
                operation: "rename",
                agentId: actingAgentId,
                operationId: operation.operationId,
                changed,
                workspace: {
                    ...before,
                    name: input.name,
                    updatedAt,
                },
            };
        },
        archive: async (ctx, actingAgentId, input, operation) => {
            const database = ctx.db;
            const before = await readWorkspace(database, input.workspaceId);
            if (before === undefined)
                throw new Error(`Workspace "${input.workspaceId}" was not found.`);
            if (before.status === "archived") {
                return {
                    operation: "archive",
                    agentId: actingAgentId,
                    operationId: operation.operationId,
                    changed: false,
                    workspace: before,
                };
            }
            const hostResult =
                options.host?.archive === undefined
                    ? undefined
                    : await options.host.archive(ctx, actingAgentId, input, operation);
            if (hostResult !== undefined) {
                const result = normalizeArchiveStoreResult(
                    hostResult,
                    actingAgentId,
                    input,
                    operation,
                );
                if (result.workspace.id !== input.workspaceId) {
                    throw new Error("Workspace archive host returned a different workspace.");
                }
                await persistWorkspace(database, result.workspace);
                return result;
            }
            const updatedAt = Date.now();
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
                    SET status = 'archived', archived_at = ${updatedAt}, updated_at = ${updatedAt}
                    WHERE id = ${input.workspaceId}`,
            );
            const workspace = {
                ...before,
                status: "archived" as const,
                archivedAt: updatedAt,
                updatedAt,
            };
            return {
                operation: "archive",
                agentId: actingAgentId,
                operationId: operation.operationId,
                changed: true,
                workspace,
            };
        },
        branchMetadata: async (ctx, actingAgentId, workspaceId) => {
            if (options.host?.branchMetadata === undefined) {
                throw new Error("Workspace branch metadata requires an injected host service.");
            }
            return await options.host.branchMetadata(ctx, actingAgentId, workspaceId);
        },
    };
}

async function readWorkspace(
    database: AgentDatabase,
    workspaceId: string,
): Promise<Workspace | undefined> {
    const rows = await agentDatabaseRows<WorkspaceRow>(
        database,
        sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
            WHERE id = ${workspaceId} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : workspaceFromRow(row);
}

async function insertWorkspace(database: AgentDatabase, workspace: Workspace): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO ${sql.raw(WORKSPACES_TABLE)} (
            id, owner_agent_id, project_ref, path, base_ref, name, status,
            created_at, updated_at, archived_at
        ) VALUES (
            ${workspace.id}, ${workspace.ownerAgentId}, ${workspace.projectRef},
            ${workspace.path ?? null}, ${workspace.baseRef ?? null}, ${workspace.name},
            ${workspace.status}, ${workspace.createdAt}, ${workspace.updatedAt},
            ${workspace.archivedAt ?? null}
        )`,
    );
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
    const workspace: Workspace = {
        id: row.id,
        ownerAgentId: row.owner_agent_id,
        projectRef: row.project_ref,
        ...(row.path === null ? {} : { path: row.path }),
        ...(row.base_ref === null ? {} : { baseRef: row.base_ref }),
        name: row.name,
        status: row.status as Workspace["status"],
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
    assertWorkspace(workspace);
    return workspace;
}

async function defaultWorkspaceTransfer(
    database: AgentDatabase,
    agentId: string,
    input: WorkspaceTransferInput,
    operation: WorkspaceMutationRequest,
): Promise<WorkspaceTransferResult> {
    if ("targetWorkspaceId" in input) {
        const target = await readWorkspace(database, input.targetWorkspaceId);
        if (target === undefined) {
            throw new Error(`Workspace "${input.targetWorkspaceId}" was not found.`);
        }
        await agentDatabaseRun(
            database,
            sql`UPDATE ${sql.raw(WORKSPACES_TABLE)} SET updated_at = ${Date.now()}
                WHERE id = ${input.targetWorkspaceId}`,
        );
        return {
            agentId,
            operationId: operation.operationId,
            changed: true,
            state: "scheduled",
            targetWorkspaceId: input.targetWorkspaceId,
        };
    }
    const workspace = await readWorkspace(database, input.workspaceId);
    if (workspace === undefined) throw new Error(`Workspace "${input.workspaceId}" was not found.`);
    const changed = workspace.projectRef !== input.targetProjectRef;
    if (changed) {
        const updatedAt = Math.max(Date.now(), workspace.updatedAt + 1);
        await agentDatabaseRun(
            database,
            sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
                SET project_ref = ${input.targetProjectRef}, updated_at = ${updatedAt}
                WHERE id = ${input.workspaceId}`,
        );
    }
    return {
        agentId,
        operationId: operation.operationId,
        changed,
        state: "transferred",
        workspace: {
            id: workspace.id,
            projectRef: input.targetProjectRef,
            ownerAgentId: workspace.ownerAgentId,
            ...(workspace.path === undefined ? {} : { path: workspace.path }),
        },
    };
}

async function persistWorkspace(database: AgentDatabase, workspace: Workspace): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
            SET owner_agent_id = ${workspace.ownerAgentId},
                project_ref = ${workspace.projectRef},
                path = ${workspace.path ?? null},
                base_ref = ${workspace.baseRef ?? null},
                name = ${workspace.name},
                status = ${workspace.status},
                created_at = ${workspace.createdAt},
                updated_at = ${workspace.updatedAt},
                archived_at = ${workspace.archivedAt ?? null}
            WHERE id = ${workspace.id}`,
    );
}

function normalizeCreateStoreResult(
    raw: WorkspaceCreateStoreResult,
    agentId: string,
    input: WorkspaceStoreCreateInput,
    operation: WorkspaceMutationRequest,
): WorkspaceCreateResult {
    if (Value.Check(workspaceCreateResultSchema, raw)) {
        assertWorkspaceCreateResult(raw);
        assertMutationIdentity(raw, agentId, operation.operationId, "create");
        assertCreatedInput(raw.workspace, input);
        return structuredClone(raw);
    }
    assertWorkspace(raw);
    assertCreatedInput(raw, input);
    return {
        operation: "create",
        agentId,
        operationId: operation.operationId,
        changed: true,
        workspace: structuredClone(raw),
    };
}

function normalizeArchiveStoreResult(
    raw: WorkspaceArchiveStoreResult,
    agentId: string,
    input: WorkspaceStoreArchiveInput,
    operation: WorkspaceMutationRequest,
): WorkspaceArchiveResult {
    if (Value.Check(workspaceArchiveResultSchema, raw)) {
        assertWorkspaceArchiveResult(raw);
        assertMutationIdentity(raw, agentId, operation.operationId, "archive");
        if (raw.workspace.id !== input.workspaceId) {
            throw new Error("Workspace archive result has a different workspace identity.");
        }
        return structuredClone(raw);
    }
    assertWorkspace(raw);
    if (raw.id !== input.workspaceId) {
        throw new Error("Workspace archive result has a different workspace identity.");
    }
    return {
        operation: "archive",
        agentId,
        operationId: operation.operationId,
        changed: true,
        workspace: structuredClone(raw),
    };
}

function normalizeRenameStoreResult(
    raw: WorkspaceRenameStoreResult,
    agentId: string,
    input: WorkspaceStoreRenameInput,
    operation: WorkspaceMutationRequest,
    before: Workspace,
): WorkspaceRenameResult {
    if (Value.Check(workspaceRenameResultSchema, raw)) {
        assertWorkspaceRenameResult(raw);
        assertMutationIdentity(raw, agentId, operation.operationId, "rename");
        if (raw.workspace.id !== input.workspaceId || raw.workspace.name !== input.name) {
            throw new Error("Workspace rename result does not match the requested workspace.");
        }
        return structuredClone(raw);
    }
    assertWorkspace(raw);
    if (raw.id !== input.workspaceId || raw.name !== input.name) {
        throw new Error("Workspace rename result does not match the requested workspace.");
    }
    return {
        operation: "rename",
        agentId,
        operationId: operation.operationId,
        changed: before.name !== raw.name,
        workspace: structuredClone(raw),
    };
}

function assertMutationIdentity(
    result: WorkspaceCreateResult | WorkspaceArchiveResult | WorkspaceRenameResult,
    agentId: string,
    operationId: string,
    operation: "create" | "archive" | "rename",
): void {
    if (
        result.agentId !== agentId ||
        result.operationId !== operationId ||
        result.operation !== operation
    ) {
        throw new Error("Workspace host mutation result identity does not match the request.");
    }
}

function assertCreatedInput(workspace: Workspace, input: WorkspaceStoreCreateInput): void {
    if (
        workspace.id !== input.id ||
        workspace.ownerAgentId !== input.ownerAgentId ||
        workspace.name !== input.name ||
        (input.projectRef !== undefined && workspace.projectRef !== input.projectRef) ||
        (input.path !== undefined && workspace.path !== input.path) ||
        (input.baseRef !== undefined && workspace.baseRef !== input.baseRef)
    ) {
        throw new Error("Workspace host create result does not match the requested identity.");
    }
}

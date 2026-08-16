import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    projectAgentIdSchema,
    projectAvatarSchema,
    projectAvatarHashSchema,
    projectIdSchema,
    projectMutationOperationSchema,
    projectOrderKeySchema,
    projectRepositoryRefSchema,
    projectSchema,
    projectSettingsSchema,
    projectVersionSchema,
    type Project,
} from "./Project.js";
import { projectContextSchema } from "./ProjectEvent.js";
import {
    projectPageQuerySchema,
    projectPageSchema,
    type ProjectPage,
    type ProjectPageQuery,
} from "./ProjectPage.js";

export const projectStoreCreateInputSchema = Type.Object(
    {
        id: projectIdSchema,
        ownerAgentId: projectAgentIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        name: Type.String({ minLength: 1, maxLength: 500 }),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

/**
 * The store decides repository uniqueness inside its transaction. `id` is a
 * module-supplied candidate used only if a new row is needed.
 */
export const projectStoreEnsureInputSchema = Type.Object(
    {
        id: projectIdSchema,
        ownerAgentId: projectAgentIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

export const projectStoreRenameInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        name: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);

export const projectStoreArchiveInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreUnarchiveInputSchema = Type.Object(
    { projectId: projectIdSchema },
    { additionalProperties: false },
);

export const projectStoreReorderInputSchema = Type.Object(
    {
        afterId: Type.Union([projectIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreSetAvatarInputSchema = Type.Object(
    {
        avatar: projectAvatarSchema,
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreClearAvatarInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectStoreSettingsUpdateInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

const projectMutationEnvelope = {
    agentId: projectAgentIdSchema,
    changed: Type.Boolean(),
} as const;

export const projectCreateResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("create"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectEnsureResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("ensure"),
        created: Type.Boolean(),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectRenameResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("rename"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectArchiveResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("archive"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectUnarchiveResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("unarchive"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectReorderResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("reorder"),
        previousOrderKey: projectOrderKeySchema,
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectSetAvatarResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("set_avatar"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectClearAvatarResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("clear_avatar"),
        project: projectSchema,
    },
    { additionalProperties: false },
);

export const projectSettingsUpdateResultSchema = Type.Object(
    {
        ...projectMutationEnvelope,
        operation: Type.Literal("update_settings"),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
        version: projectVersionSchema,
    },
    { additionalProperties: false },
);

export const projectStoreMutationResultSchema = Type.Union([
    projectCreateResultSchema,
    projectEnsureResultSchema,
    projectRenameResultSchema,
    projectArchiveResultSchema,
    projectUnarchiveResultSchema,
    projectReorderResultSchema,
    projectSetAvatarResultSchema,
    projectClearAvatarResultSchema,
    projectSettingsUpdateResultSchema,
]);

export const projectAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("ensure"),
    Type.Literal("create"),
    Type.Literal("rename"),
    Type.Literal("archive"),
    Type.Literal("unarchive"),
    Type.Literal("reorder"),
    Type.Literal("set_avatar"),
    Type.Literal("clear_avatar"),
    Type.Literal("avatar_update"),
    Type.Literal("avatar_read"),
    Type.Literal("settings_read"),
    Type.Literal("settings_update"),
]);

export const projectAuthorizationSchema = Type.Function(
    [
        projectContextSchema,
        projectAgentIdSchema,
        projectAgentIdSchema,
        projectAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

/**
 * This is the private persistence contract used by the module-owned SQLite
 * adapter below. It remains exported for the protocol package's structural
 * types, but callers never inject a store into ProjectsModule.
 */
export const projectStoreSchema = Type.Object(
    {
        create: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreCreateInputSchema],
            Type.Promise(projectCreateResultSchema),
        ),
        ensure: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreEnsureInputSchema],
            Type.Promise(projectEnsureResultSchema),
        ),
        list: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectPageQuerySchema],
            Type.Promise(projectPageSchema),
        ),
        get: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectIdSchema],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        findByRepositoryRef: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectRepositoryRefSchema],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        findByAvatarHash: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectAvatarHashSchema],
            Type.Promise(Type.Union([projectSchema, Type.Undefined()])),
        ),
        rename: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreRenameInputSchema],
            Type.Promise(projectRenameResultSchema),
        ),
        archive: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreArchiveInputSchema],
            Type.Promise(projectArchiveResultSchema),
        ),
        unarchive: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreUnarchiveInputSchema],
            Type.Promise(projectUnarchiveResultSchema),
        ),
        reorder: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreReorderInputSchema],
            Type.Promise(projectReorderResultSchema),
        ),
        setAvatar: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreSetAvatarInputSchema],
            Type.Promise(projectSetAvatarResultSchema),
        ),
        clearAvatar: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreClearAvatarInputSchema],
            Type.Promise(projectClearAvatarResultSchema),
        ),
        readSettings: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectIdSchema],
            Type.Promise(projectSettingsSchema),
        ),
        updateSettings: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectStoreSettingsUpdateInputSchema],
            Type.Promise(projectSettingsUpdateResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type ProjectStore = Static<typeof projectStoreSchema>;
export type ProjectStoreCreateInput = Static<typeof projectStoreCreateInputSchema>;
export type ProjectStoreEnsureInput = Static<typeof projectStoreEnsureInputSchema>;
export type ProjectStoreRenameInput = Static<typeof projectStoreRenameInputSchema>;
export type ProjectStoreArchiveInput = Static<typeof projectStoreArchiveInputSchema>;
export type ProjectStoreUnarchiveInput = Static<typeof projectStoreUnarchiveInputSchema>;
export type ProjectStoreReorderInput = Static<typeof projectStoreReorderInputSchema>;
export type ProjectStoreSetAvatarInput = Static<typeof projectStoreSetAvatarInputSchema>;
export type ProjectStoreClearAvatarInput = Static<typeof projectStoreClearAvatarInputSchema>;
export type ProjectStoreSettingsUpdateInput = Static<typeof projectStoreSettingsUpdateInputSchema>;
export type ProjectCreateResult = Static<typeof projectCreateResultSchema>;
export type ProjectEnsureResult = Static<typeof projectEnsureResultSchema>;
export type ProjectRenameResult = Static<typeof projectRenameResultSchema>;
export type ProjectArchiveResult = Static<typeof projectArchiveResultSchema>;
export type ProjectUnarchiveResult = Static<typeof projectUnarchiveResultSchema>;
export type ProjectReorderResult = Static<typeof projectReorderResultSchema>;
export type ProjectSetAvatarResult = Static<typeof projectSetAvatarResultSchema>;
export type ProjectClearAvatarResult = Static<typeof projectClearAvatarResultSchema>;
export type ProjectSettingsUpdateResult = Static<typeof projectSettingsUpdateResultSchema>;
export type ProjectStoreMutationResult = Static<typeof projectStoreMutationResultSchema>;
export type ProjectAuthorizationAction = Static<typeof projectAuthorizationActionSchema>;
export type ProjectAuthorization = Static<typeof projectAuthorizationSchema>;

export type { Project, ProjectPage, ProjectPageQuery };

export function assertProjectStore(value: unknown): asserts value is ProjectStore {
    if (!Value.Check(projectStoreSchema, value)) {
        throw new Error("Project module received an invalid host store.");
    }
}

export function assertProject(value: unknown): asserts value is Project {
    if (!Value.Check(projectSchema, value)) {
        throw new Error("Project store returned an invalid project.");
    }
}

export function assertProjectPage(value: unknown): asserts value is ProjectPage {
    if (!Value.Check(projectPageSchema, value)) {
        throw new Error("Project store returned an invalid project page.");
    }
}

export function assertProjectCreateResult(value: unknown): asserts value is ProjectCreateResult {
    if (!Value.Check(projectCreateResultSchema, value)) {
        throw new Error("Project store returned an invalid create result.");
    }
}

export function assertProjectEnsureResult(value: unknown): asserts value is ProjectEnsureResult {
    if (!Value.Check(projectEnsureResultSchema, value)) {
        throw new Error("Project store returned an invalid ensure result.");
    }
}

export function assertProjectRenameResult(value: unknown): asserts value is ProjectRenameResult {
    if (!Value.Check(projectRenameResultSchema, value)) {
        throw new Error("Project store returned an invalid rename result.");
    }
}

export function assertProjectArchiveResult(value: unknown): asserts value is ProjectArchiveResult {
    if (!Value.Check(projectArchiveResultSchema, value)) {
        throw new Error("Project store returned an invalid archive result.");
    }
}

export function assertProjectUnarchiveResult(
    value: unknown,
): asserts value is ProjectUnarchiveResult {
    if (!Value.Check(projectUnarchiveResultSchema, value)) {
        throw new Error("Project store returned an invalid unarchive result.");
    }
}

export function assertProjectReorderResult(value: unknown): asserts value is ProjectReorderResult {
    if (!Value.Check(projectReorderResultSchema, value)) {
        throw new Error("Project store returned an invalid reorder result.");
    }
}

export function assertProjectSetAvatarResult(
    value: unknown,
): asserts value is ProjectSetAvatarResult {
    if (!Value.Check(projectSetAvatarResultSchema, value)) {
        throw new Error("Project store returned an invalid avatar result.");
    }
}

export function assertProjectClearAvatarResult(
    value: unknown,
): asserts value is ProjectClearAvatarResult {
    if (!Value.Check(projectClearAvatarResultSchema, value)) {
        throw new Error("Project store returned an invalid clear-avatar result.");
    }
}

export function assertProjectSettingsUpdateResult(
    value: unknown,
): asserts value is ProjectSettingsUpdateResult {
    if (!Value.Check(projectSettingsUpdateResultSchema, value)) {
        throw new Error("Project store returned an invalid settings result.");
    }
}

export function assertProjectStoreMutationResult(
    value: unknown,
): asserts value is ProjectStoreMutationResult {
    if (!Value.Check(projectStoreMutationResultSchema, value)) {
        throw new Error("Project store returned an invalid mutation result.");
    }
}

type ProjectRow = {
    readonly id: string;
    readonly owner_agent_id: string;
    readonly repository_ref: string;
    readonly name: string;
    readonly status: string;
    readonly order_key: string;
    readonly version: number | string;
    readonly avatar_json: string | null;
    readonly description: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly archived_at: number | string | null;
};

type ProjectSettingsRow = {
    readonly project_id: string;
    readonly settings_json: string;
};

const PROJECT_MIGRATION_KEY = "001-projects-catalog";
const PROJECTS_TABLE = "happy_agent_module_projects";
const PROJECT_SETTINGS_TABLE = "happy_agent_module_project_settings";
const PROJECT_RECEIPTS_TABLE = "happy_agent_module_project_operation_receipts";
const PROJECT_PROOFS_TABLE = "happy_agent_module_project_mutation_proofs";

/**
 * The projects module owns these tables. They deliberately use stable,
 * human-readable names so a module upgrade can append migrations without
 * borrowing Rig's application schema.
 */
export const projectMigrations = [
    [
        PROJECT_MIGRATION_KEY,
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    repository_ref TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    description TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_status_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (status, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECT_SETTINGS_TABLE)} (
                    project_id TEXT PRIMARY KEY,
                    settings_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECT_RECEIPTS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECT_PROOFS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
        },
    ],
    [
        "002-drop-project-idempotency-tables",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(PROJECT_RECEIPTS_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(PROJECT_PROOFS_TABLE)}`,
            );
        },
    ],
    [
        "003-project-order-version-avatar",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECTS_TABLE)}
                    ADD COLUMN order_key TEXT NOT NULL DEFAULT ''`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECTS_TABLE)}
                    ADD COLUMN version BIGINT NOT NULL DEFAULT 1`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECTS_TABLE)}
                    ADD COLUMN avatar_json TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET order_key = printf('%020d', rowid)
                    WHERE order_key = ''`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_order_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (order_key, id)`,
            );
        },
    ],
] as const;

export function createProjectStore(): ProjectStore {
    const databaseFor = (ctx: Context): AgentDatabase => {
        return ctx.db;
    };

    return {
        create: async (ctx, actingAgentId, input) => {
            const at = Date.now();
            const orderKey = await nextProjectOrderKey(databaseFor(ctx));
            const project: Project = {
                id: input.id,
                ownerAgentId: input.ownerAgentId,
                repositoryRef: input.repositoryRef,
                name: input.name,
                status: "active",
                orderKey,
                version: 1,
                ...(input.description === undefined ? {} : { description: input.description }),
                createdAt: at,
                updatedAt: at,
            };
            assertProject(project);
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(PROJECTS_TABLE)} (
                    id, owner_agent_id, repository_ref, name, status, description,
                    order_key, version, avatar_json, created_at, updated_at, archived_at
                ) VALUES (
                    ${project.id}, ${project.ownerAgentId}, ${project.repositoryRef},
                    ${project.name}, ${project.status},
                    ${project.description ?? null}, ${project.orderKey},
                    ${project.version}, ${null}, ${project.createdAt},
                    ${project.updatedAt}, ${null}
                )`,
            );
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(PROJECT_SETTINGS_TABLE)} (project_id, settings_json)
                    VALUES (${project.id}, ${JSON.stringify({})})`,
            );
            return {
                operation: "create",
                agentId: actingAgentId,
                changed: true,
                project,
            };
        },
        ensure: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const existing = await readProjectByRepository(database, input.repositoryRef);
            if (existing !== undefined) {
                if (existing.status === "archived") {
                    const updatedAt = Date.now();
                    await agentDatabaseRun(
                        database,
                        sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                            SET status = 'active', archived_at = ${null},
                                updated_at = ${updatedAt}, version = version + 1
                            WHERE id = ${existing.id} AND status = 'archived'`,
                    );
                    const restored = await readProject(database, existing.id);
                    if (restored === undefined || restored.status !== "active") {
                        throw new Error("Project ensure could not restore the archived project.");
                    }
                    return {
                        operation: "ensure",
                        agentId: actingAgentId,
                        changed: true,
                        created: false,
                        project: restored,
                    };
                }
                return {
                    operation: "ensure",
                    agentId: actingAgentId,
                    changed: false,
                    created: false,
                    project: existing,
                };
            }
            const at = Date.now();
            const orderKey = await nextProjectOrderKey(database);
            const project: Project = {
                id: input.id,
                ownerAgentId: input.ownerAgentId,
                repositoryRef: input.repositoryRef,
                name: input.name ?? input.repositoryRef,
                status: "active",
                orderKey,
                version: 1,
                ...(input.description === undefined ? {} : { description: input.description }),
                createdAt: at,
                updatedAt: at,
            };
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(PROJECTS_TABLE)} (
                    id, owner_agent_id, repository_ref, name, status, description,
                    order_key, version, avatar_json, created_at, updated_at, archived_at
                ) VALUES (
                    ${project.id}, ${project.ownerAgentId}, ${project.repositoryRef},
                    ${project.name}, ${project.status},
                    ${project.description ?? null}, ${project.orderKey},
                    ${project.version}, ${null}, ${project.createdAt},
                    ${project.updatedAt}, ${null}
                )`,
            );
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(PROJECT_SETTINGS_TABLE)} (project_id, settings_json)
                    VALUES (${project.id}, ${JSON.stringify({})})`,
            );
            return {
                operation: "ensure",
                agentId: actingAgentId,
                changed: true,
                created: true,
                project,
            };
        },
        list: async (ctx, _agentId, query) => {
            const database = databaseFor(ctx);
            const offset = query.cursor === undefined ? 0 : Number(query.cursor);
            const rows = await agentDatabaseRows<ProjectRow>(
                database,
                query.status === undefined
                    ? query.includeArchived === true
                        ? sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)} ORDER BY order_key, id LIMIT ${query.limit ?? 50} OFFSET ${offset}`
                        : sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                               WHERE status <> 'archived'
                               ORDER BY order_key, id LIMIT ${query.limit ?? 50} OFFSET ${offset}`
                    : sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                           WHERE status = ${query.status}
                           ORDER BY order_key, id LIMIT ${query.limit ?? 50} OFFSET ${offset}`,
            );
            const projects = rows.map(projectFromRow);
            const requestedLimit = query.limit ?? 50;
            const hasNext = projects.length === requestedLimit;
            return {
                projects,
                ...(hasNext ? { nextCursor: String(offset + projects.length) } : {}),
            };
        },
        get: async (ctx, _agentId, projectId) => {
            const rows = await agentDatabaseRows<ProjectRow>(
                databaseFor(ctx),
                sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)} WHERE id = ${projectId} LIMIT 1`,
            );
            const row = rows[0];
            return row === undefined ? undefined : projectFromRow(row);
        },
        findByRepositoryRef: async (ctx, _agentId, repositoryRef) =>
            await readProjectByRepository(databaseFor(ctx), repositoryRef),
        findByAvatarHash: async (ctx, _agentId, hash) => {
            const rows = await agentDatabaseRows<ProjectRow>(
                databaseFor(ctx),
                sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                    WHERE json_extract(avatar_json, '$.hash') = ${hash}
                    LIMIT 1`,
            );
            const row = rows[0];
            return row === undefined ? undefined : projectFromRow(row);
        },
        rename: async (ctx, actingAgentId, input) => {
            const before = await readProject(databaseFor(ctx), input.projectId);
            if (before === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before it could be renamed.",
            );
            const changed = before.name !== input.name;
            if (!changed) {
                return {
                    operation: "rename",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = changed ? Date.now() : before.updatedAt;
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET name = ${input.name}, updated_at = ${updatedAt}, version = version + 1
                    WHERE id = ${input.projectId}
                      AND version = ${input.expectedVersion ?? before.version}`,
            );
            const project = {
                ...before,
                name: input.name,
                updatedAt,
                version: before.version + 1,
            };
            return {
                operation: "rename",
                agentId: actingAgentId,
                changed,
                project,
            };
        },
        archive: async (ctx, actingAgentId, input) => {
            const before = await readProject(databaseFor(ctx), input.projectId);
            if (before === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            if (before.status === "archived") {
                return {
                    operation: "archive",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before it could be archived.",
            );
            const updatedAt = Date.now();
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET status = 'archived', archived_at = ${updatedAt},
                        updated_at = ${updatedAt}, version = version + 1
                    WHERE id = ${input.projectId}
                      AND version = ${input.expectedVersion ?? before.version}`,
            );
            const project = {
                ...before,
                status: "archived" as const,
                archivedAt: updatedAt,
                updatedAt,
                version: before.version + 1,
            };
            return {
                operation: "archive",
                agentId: actingAgentId,
                changed: true,
                project,
            };
        },
        unarchive: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await readProject(database, input.projectId);
            if (before === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            if (before.status === "active") {
                return {
                    operation: "unarchive",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET status = 'active', archived_at = ${null},
                        updated_at = ${updatedAt}, version = version + 1
                    WHERE id = ${input.projectId} AND status = 'archived'`,
            );
            const project = structuredClone(before);
            project.status = "active";
            delete project.archivedAt;
            project.updatedAt = updatedAt;
            project.version += 1;
            return {
                operation: "unarchive",
                agentId: actingAgentId,
                changed: true,
                project,
            };
        },
        reorder: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await readProject(database, input.projectId);
            if (before === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before it could be reordered.",
            );
            if (input.afterId === input.projectId) {
                throw new Error("A project cannot be placed after itself.");
            }
            const rows = await agentDatabaseRows<ProjectRow>(
                database,
                sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                    ORDER BY order_key, id`,
            );
            const ordered = rows.map(projectFromRow);
            const currentIndex = ordered.findIndex((project) => project.id === input.projectId);
            if (currentIndex === -1) {
                throw new Error(`Project "${input.projectId}" was not found.`);
            }
            const withoutTarget = ordered.filter((project) => project.id !== input.projectId);
            const insertionIndex =
                input.afterId === null
                    ? 0
                    : (() => {
                          const afterIndex = withoutTarget.findIndex(
                              (project) => project.id === input.afterId,
                          );
                          if (afterIndex === -1) {
                              throw new Error(
                                  "The project to place after was not found in the catalog.",
                              );
                          }
                          return afterIndex + 1;
                      })();
            const reordered = [...withoutTarget];
            reordered.splice(insertionIndex, 0, before);
            const changed =
                reordered.some((project, index) => project.id !== ordered[index]?.id) ||
                before.orderKey !== orderKeyForPosition(currentIndex + 1);
            if (!changed) {
                return {
                    operation: "reorder",
                    agentId: actingAgentId,
                    changed: false,
                    previousOrderKey: before.orderKey,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            for (const [index, project] of reordered.entries()) {
                const orderKey = orderKeyForPosition(index + 1);
                if (project.id === input.projectId) {
                    await agentDatabaseRun(
                        database,
                        sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                            SET order_key = ${orderKey}, updated_at = ${updatedAt},
                                version = version + 1
                            WHERE id = ${project.id}
                              AND version = ${input.expectedVersion ?? before.version}`,
                    );
                } else if (project.orderKey !== orderKey) {
                    await agentDatabaseRun(
                        database,
                        sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                            SET order_key = ${orderKey}
                            WHERE id = ${project.id}`,
                    );
                }
            }
            const project = {
                ...before,
                orderKey: orderKeyForPosition(insertionIndex + 1),
                updatedAt,
                version: before.version + 1,
            };
            return {
                operation: "reorder",
                agentId: actingAgentId,
                changed: true,
                previousOrderKey: before.orderKey,
                project,
            };
        },
        setAvatar: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await readProject(database, input.projectId);
            if (before === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before the avatar could be saved.",
            );
            const changed = !sameJson(before.avatar ?? null, input.avatar);
            if (!changed) {
                return {
                    operation: "set_avatar",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET avatar_json = ${JSON.stringify(input.avatar)},
                        updated_at = ${updatedAt}, version = version + 1
                    WHERE id = ${input.projectId}
                      AND version = ${input.expectedVersion ?? before.version}`,
            );
            const project = {
                ...before,
                avatar: structuredClone(input.avatar),
                updatedAt,
                version: before.version + 1,
            };
            return {
                operation: "set_avatar",
                agentId: actingAgentId,
                changed: true,
                project,
            };
        },
        clearAvatar: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await readProject(database, input.projectId);
            if (before === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before the avatar could be cleared.",
            );
            if (before.avatar === undefined) {
                return {
                    operation: "clear_avatar",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET avatar_json = ${null}, updated_at = ${updatedAt},
                        version = version + 1
                    WHERE id = ${input.projectId}
                      AND version = ${input.expectedVersion ?? before.version}`,
            );
            const project = structuredClone(before);
            delete project.avatar;
            project.updatedAt = updatedAt;
            project.version += 1;
            return {
                operation: "clear_avatar",
                agentId: actingAgentId,
                changed: true,
                project,
            };
        },
        readSettings: async (ctx, _agentId, projectId) => {
            const rows = await agentDatabaseRows<ProjectSettingsRow>(
                databaseFor(ctx),
                sql`SELECT project_id, settings_json
                    FROM ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    WHERE project_id = ${projectId} LIMIT 1`,
            );
            const value = rows[0];
            if (value === undefined) {
                const project = await readProject(databaseFor(ctx), projectId);
                if (project === undefined) throw new Error(`Project "${projectId}" was not found.`);
                return {};
            }
            return parseProjectSettings(value.settings_json);
        },
        updateSettings: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const project = await readProject(database, input.projectId);
            if (project === undefined)
                throw new Error(`Project "${input.projectId}" was not found.`);
            assertExpectedProjectVersion(
                project,
                input.expectedVersion,
                "The project changed before its settings could be saved.",
            );
            const before = parseProjectSettingsRow(
                await agentDatabaseRows<ProjectSettingsRow>(
                    database,
                    sql`SELECT project_id, settings_json
                        FROM ${sql.raw(PROJECT_SETTINGS_TABLE)}
                        WHERE project_id = ${input.projectId} LIMIT 1`,
                ),
            );
            const changed = canonicalJson(before) !== canonicalJson(input.settings);
            await agentDatabaseRun(
                database,
                sql`INSERT INTO ${sql.raw(PROJECT_SETTINGS_TABLE)} (project_id, settings_json)
                    VALUES (${input.projectId}, ${JSON.stringify(input.settings)})
                    ON CONFLICT (project_id) DO UPDATE
                    SET settings_json = excluded.settings_json`,
            );
            if (changed) {
                await agentDatabaseRun(
                    database,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET updated_at = ${Date.now()}, version = version + 1
                        WHERE id = ${input.projectId}
                          AND version = ${input.expectedVersion ?? project.version}`,
                );
            }
            return {
                operation: "update_settings",
                agentId: actingAgentId,
                changed,
                projectId: input.projectId,
                settings: structuredClone(input.settings),
                version: project.version + (changed ? 1 : 0),
            };
        },
    };
}

async function readProject(
    database: AgentDatabase,
    projectId: string,
): Promise<Project | undefined> {
    const rows = await agentDatabaseRows<ProjectRow>(
        database,
        sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)} WHERE id = ${projectId} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : projectFromRow(row);
}

async function readProjectByRepository(
    database: AgentDatabase,
    repositoryRef: string,
): Promise<Project | undefined> {
    const rows = await agentDatabaseRows<ProjectRow>(
        database,
        sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
            WHERE repository_ref = ${repositoryRef} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : projectFromRow(row);
}

async function nextProjectOrderKey(database: AgentDatabase): Promise<string> {
    const rows = await agentDatabaseRows<{ readonly order_key: string }>(
        database,
        sql`SELECT order_key
            FROM ${sql.raw(PROJECTS_TABLE)}
            ORDER BY order_key DESC, id DESC
            LIMIT 1`,
    );
    const current = rows[0]?.order_key;
    if (current === undefined) return orderKeyForPosition(1);
    if (!Value.Check(projectOrderKeySchema, current)) {
        throw new Error("Project order storage contains an invalid key.");
    }
    let next: bigint;
    try {
        next = BigInt(current) + 1n;
    } catch {
        throw new Error("Project order storage contains an invalid key.");
    }
    const value = next.toString().padStart(20, "0");
    if (!Value.Check(projectOrderKeySchema, value)) {
        throw new Error("Project order storage exceeded its key bound.");
    }
    return value;
}

function orderKeyForPosition(position: number): string {
    const value = String(position).padStart(20, "0");
    if (!Value.Check(projectOrderKeySchema, value)) {
        throw new Error("Project order position is invalid.");
    }
    return value;
}

function assertExpectedProjectVersion(
    project: Project,
    expectedVersion: number | undefined,
    message: string,
): void {
    if (expectedVersion === undefined) return;
    if (
        !Value.Check(projectVersionSchema, expectedVersion) ||
        project.version !== expectedVersion
    ) {
        throw new Error(message);
    }
}

function projectFromRow(row: ProjectRow): Project {
    const avatar = row.avatar_json === null ? undefined : parseProjectAvatar(row.avatar_json);
    const project: Project = {
        id: row.id,
        ownerAgentId: row.owner_agent_id,
        repositoryRef: row.repository_ref,
        name: row.name,
        status: row.status as Project["status"],
        orderKey: row.order_key,
        version: Number(row.version),
        ...(avatar === undefined ? {} : { avatar }),
        ...(row.description === null ? {} : { description: row.description }),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
    assertProject(project);
    return project;
}

function parseProjectAvatar(value: string): Project["avatar"] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("Project avatar storage contains invalid JSON.");
    }
    if (!Value.Check(projectAvatarSchema, parsed)) {
        throw new Error("Project avatar storage contains an invalid value.");
    }
    return structuredClone(parsed);
}

function parseProjectSettings(value: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("Project settings storage contains invalid JSON.");
    }
    if (!Value.Check(projectSettingsSchema, parsed)) {
        throw new Error("Project settings storage contains an invalid value.");
    }
    return structuredClone(parsed);
}

function parseProjectSettingsRow(rows: readonly ProjectSettingsRow[]): Record<string, unknown> {
    const row = rows[0];
    return row === undefined ? {} : parseProjectSettings(row.settings_json);
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

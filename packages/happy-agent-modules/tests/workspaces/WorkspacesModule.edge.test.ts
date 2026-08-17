import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import {
    MAX_WORKSPACE_NAME_LENGTH,
    MAX_WORKSPACE_STORAGE_KEY_LENGTH,
    type Workspace,
    type WorkspaceEvent,
    workspaceBranchSchema,
    workspaceMigrations,
    WorkspacesModule,
} from "../../sources/workspaces/index.js";
import { cleanupRoots, commitFile, createRoot, git, gitRunner } from "../git/helpers.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { primaryAgents } from "../support/moduleHooks.js";

afterEach(cleanupRoots);

function workspaceDatabase(name: string): ReturnType<typeof moduleDatabase> {
    const database = moduleDatabase([], name);
    const ready = database.ready.then(async () => {
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
    });
    return { ...database, ready };
}

/**
 * Where workspace folders are created. A catalog told this decides every path itself, so a test
 * that never touches the disk still gets the paths the real one would produce.
 */
const WORKSPACES_DIRECTORY = "/managed";

let helperWorkspaceCounter = 0;

async function reserve(
    workspaces: WorkspacesModule,
    database: ReturnType<typeof workspaceDatabase>,
    overrides: Record<string, unknown> = {},
): Promise<Workspace> {
    return (
        await workspaces.reserve(database.context, "agent-a", {
            id: `workspace-helper-${String((helperWorkspaceCounter += 1))}`,
            projectRef: "project-a",
            name: "Workspace",
            ...overrides,
        } as never)
    ).workspace;
}

async function nextMicrotask(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("WorkspacesModule edge contracts", () => {
    it("uses the injected clock for reservation timestamps", async () => {
        const database = workspaceDatabase("workspaces-clock-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                clock: () => 1234,
                eventIdFactory: () => "event-clock",
            });
            const workspace = await reserve(workspaces, database, {
                id: "workspace-clock",
                name: "Clocked workspace",
            });

            expect(workspace.createdAt).toBe(1234);
            expect(workspace.updatedAt).toBe(1234);
        } finally {
            database.close();
        }
    });

    it("rejects invalid availability answers instead of coercing them", async () => {
        const database = workspaceDatabase("workspaces-invalid-probe-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
            });

            await expect(
                workspaces.reserve(
                    database.context,
                    "agent-a",
                    {
                        id: "workspace-invalid-probe",
                        projectRef: "project-a",
                        name: "Invalid probe",
                    },
                    { isBranchUnavailable: (() => 0) as never },
                ),
            ).rejects.toThrow(/invalid|boolean/i);
        } finally {
            database.close();
        }
    });

    it("validates getByPath input as an already-normalized absolute path", async () => {
        const database = workspaceDatabase("workspaces-path-input-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await reserve(workspaces, database, { id: "workspace-path" });

            await expect(
                workspaces.getByPath(database.context, "agent-a", "project-a/workspace"),
            ).rejects.toThrow(/path.*invalid|absolute/i);
        } finally {
            database.close();
        }
    });

    it("does not accept a replay that changes a name ending in a numeric suffix", async () => {
        const database = workspaceDatabase("workspaces-replay-suffix-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-replay-suffix",
                operationId: "create-replay-suffix",
                projectRef: "project-a",
                name: "Release-2",
            });

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-replay-suffix",
                    operationId: "create-replay-suffix",
                    projectRef: "project-a",
                    name: "Release",
                }),
            ).rejects.toThrow(/called something else/i);
        } finally {
            database.close();
        }
    });

    it("does not accept a replay that drops an explicitly selected base", async () => {
        const database = workspaceDatabase("workspaces-replay-settings-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-replay-settings",
                operationId: "create-replay-settings",
                projectRef: "project-a",
                name: "Settings",
                baseRef: "origin/main",
                baseCommit: "abcdef",
            });

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-replay-settings",
                    operationId: "create-replay-settings",
                    projectRef: "project-a",
                    name: "Settings",
                }),
            ).rejects.toThrow(/different base|different commit/i);
        } finally {
            database.close();
        }
    });

    it("does not accept a replay that changes whether a name was configured", async () => {
        const database = workspaceDatabase("workspaces-replay-name-configured-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-replay-name-configured",
                operationId: "create-replay-name-configured",
                projectRef: "project-a",
                name: "Configured",
                nameConfigured: true,
            });

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-replay-name-configured",
                    operationId: "create-replay-name-configured",
                    projectRef: "project-a",
                    name: "Configured",
                }),
            ).rejects.toThrow(/configured|different/i);
        } finally {
            database.close();
        }
    });

    it("does not replay an old rename over a later durable rename", async () => {
        const database = workspaceDatabase("workspaces-rename-replay-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await reserve(workspaces, database, {
                id: "workspace-rename-replay",
                name: "Original",
            });

            await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-rename-replay",
                name: "First rename",
                operationId: "rename-first",
            });
            await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-rename-replay",
                name: "Second rename",
                operationId: "rename-second",
            });

            const replay = await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-rename-replay",
                name: "First rename",
                operationId: "rename-first",
            });
            expect(replay).toMatchObject({ name: "First rename" });
            await expect(
                workspaces.get(database.context, "agent-a", "workspace-rename-replay"),
            ).resolves.toMatchObject({ name: "Second rename" });
        } finally {
            database.close();
        }
    });

    it("keeps legal maximum names within their schema when a collision needs a suffix", async () => {
        const database = workspaceDatabase("workspaces-max-name-collision-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            const name = "A".repeat(MAX_WORKSPACE_NAME_LENGTH);
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-max-name-1",
                projectRef: "project-a",
                name,
            });

            const second = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-max-name-2",
                projectRef: "project-a",
                name,
            });
            expect(second.workspace.name.length).toBeLessThanOrEqual(MAX_WORKSPACE_NAME_LENGTH);
        } finally {
            database.close();
        }
    });

    it("keeps legal maximum storage seeds within their schema when a collision needs a suffix", async () => {
        const database = workspaceDatabase("workspaces-max-storage-collision-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            const seed = "a".repeat(MAX_WORKSPACE_STORAGE_KEY_LENGTH);
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-max-storage-1",
                projectRef: "project-a",
                name: "Storage one",
                storageKeySeed: seed,
            });

            const second = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-max-storage-2",
                projectRef: "project-a",
                name: "Storage two",
                storageKeySeed: seed,
            });
            expect(second.workspace.storageKey.length).toBeLessThanOrEqual(
                MAX_WORKSPACE_STORAGE_KEY_LENGTH,
            );
        } finally {
            database.close();
        }
    });

    it("rejects Git refs whose non-final component ends with a dot", () => {
        expect(Value.Check(workspaceBranchSchema, "worktree/component./branch")).toBe(false);
        expect(Value.Check(workspaceBranchSchema, "worktree/component/branch")).toBe(true);
    });

    it("rejects malformed persisted lifecycle timestamps", async () => {
        const database = workspaceDatabase("workspaces-malformed-state-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await reserve(workspaces, database, { id: "workspace-malformed" });
            await agentDatabaseRows(
                database.database,
                sql`UPDATE happy_agent_module_workspaces
                    SET status = 'archived', archived_at = NULL
                    WHERE id = 'workspace-malformed'
                    RETURNING id`,
            );

            await expect(
                workspaces.get(database.context, "agent-a", "workspace-malformed"),
            ).rejects.toThrow(/archivedAt/i);
        } finally {
            database.close();
        }
    });

    it("does not publish a post-commit event when an outer transaction rolls back", async () => {
        const transactional: string[] = [];
        const postCommit: string[] = [];
        const database = workspaceDatabase("workspaces-outer-rollback-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        transactional.push(event.type);
                    },
                    onEvent: (_ctx, event) => {
                        postCommit.push(event.type);
                    },
                },
            });

            await expect(
                database.context.inTx(async (txCtx) => {
                    await workspaces.reserve(txCtx, "agent-a", {
                        id: "workspace-rollback",
                        projectRef: "project-a",
                        name: "Rollback",
                    });
                    throw new Error("roll back outer transaction");
                }),
            ).rejects.toThrow("roll back outer transaction");
            await nextMicrotask();

            expect(await workspaces.get(database.context, "agent-a", "workspace-rollback")).toBe(
                undefined,
            );
            expect(postCommit).toEqual([]);
            expect(transactional).toEqual(["workspace_created"]);
        } finally {
            database.close();
        }
    });

    it("rolls back durable state when a transactional listener fails", async () => {
        const database = workspaceDatabase("workspaces-transaction-listener-failure-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                listener: {
                    onEventTransactional: () => {
                        throw new Error("transactional observer failed");
                    },
                },
            });

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-listener-failure",
                    projectRef: "project-a",
                    name: "Listener failure",
                }),
            ).rejects.toThrow("transactional observer failed");
            expect(
                await workspaces.get(database.context, "agent-a", "workspace-listener-failure"),
            ).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains post-commit listener failures after the row is durable", async () => {
        const reported: unknown[] = [];
        const database = workspaceDatabase("workspaces-post-commit-failure-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                listener: {
                    onEvent: () => {
                        throw new Error("post-commit observer failed");
                    },
                },
                onPostCommitError: (_ctx, _event, error) => {
                    reported.push(error);
                },
            });

            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-post-commit-failure",
                projectRef: "project-a",
                name: "Post commit failure",
            });
            await nextMicrotask();

            expect(
                await workspaces.get(database.context, "agent-a", "workspace-post-commit-failure"),
            ).toMatchObject({ status: "initializing" });
            expect(reported).toEqual(["post-commit observer failed"]);
        } finally {
            database.close();
        }
    });

    it("rolls back a mutation when the event identity or clock is invalid", async () => {
        const cases = [
            {
                name: "workspaces-invalid-event-id-edge",
                options: { eventIdFactory: () => "e".repeat(129) },
                message: /event ID/i,
                id: "workspace-invalid-event-id",
            },
            {
                name: "workspaces-invalid-event-clock-edge",
                options: { clock: () => -1 },
                message: /clock/i,
                id: "workspace-invalid-event-clock",
            },
        ] as const;

        for (const testCase of cases) {
            const database = workspaceDatabase(testCase.name);
            await database.ready;
            try {
                const workspaces = new WorkspacesModule({
                    workspacesDirectory: WORKSPACES_DIRECTORY,
                    ...testCase.options,
                });
                await expect(
                    workspaces.reserve(database.context, "agent-a", {
                        id: testCase.id,
                        projectRef: "project-a",
                        name: "Invalid event",
                    }),
                ).rejects.toThrow(testCase.message);
                expect(
                    await workspaces.get(database.context, "agent-a", testCase.id),
                ).toBeUndefined();
            } finally {
                database.close();
            }
        }
    });

    it("does not advance version or emit an event for an identical Git observation", async () => {
        const events: string[] = [];
        const database = workspaceDatabase("workspaces-noop-observation-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        events.push(event.type);
                    },
                },
            });
            const created = await reserve(workspaces, database, {
                id: "workspace-noop-observation",
            });
            const observed = await workspaces.applyGitFacts(database.context, "agent-a", {
                workspaceId: created.id,
                facts: {
                    ahead: 0,
                    behind: 0,
                    detached: false,
                },
            });

            expect(observed).toEqual(created);
            expect(events).toEqual(["workspace_created"]);
        } finally {
            database.close();
        }
    });

    it("delivers one detached frozen event to both listeners", async () => {
        let transactionalEvent: WorkspaceEvent | undefined;
        let postCommitEvent: WorkspaceEvent | undefined;
        const database = workspaceDatabase("workspaces-frozen-event-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        transactionalEvent = event;
                    },
                    onEvent: (_ctx, event) => {
                        postCommitEvent = event;
                    },
                },
            });
            const returned = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-frozen-event",
                projectRef: "project-a",
                name: "Frozen event",
            });
            await nextMicrotask();

            expect(postCommitEvent).toBe(transactionalEvent);
            expect(Object.isFrozen(postCommitEvent)).toBe(true);
            expect(postCommitEvent?.type).toBe("workspace_created");
            if (postCommitEvent?.type === "workspace_created") {
                expect(Object.isFrozen(postCommitEvent.workspace)).toBe(true);
                expect(postCommitEvent.workspace).not.toBe(returned.workspace);
            }
        } finally {
            database.close();
        }
    });

    it("uses an authorization policy for cross-agent project transfers", async () => {
        const database = workspaceDatabase("workspaces-transfer-authorization-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
                authorization: (_ctx, actingAgent, ownerAgent, action) =>
                    actingAgent === "agent-b" && ownerAgent === "agent-a" && action === "transfer",
            });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-transfer-auth",
                projectRef: "project-a",
                name: "Transfer auth",
            });

            await expect(
                workspaces.transfer(database.context, "agent-b", {
                    workspaceId: "workspace-transfer-auth",
                    targetProjectRef: "project-b",
                }),
            ).resolves.toMatchObject({
                state: "transferred",
                workspace: { projectRef: "project-b" },
            });
        } finally {
            database.close();
        }
    });

    it("does not repeat folder cleanup for the same durable archive operation", async () => {
        const attempts: string[] = [];
        const root = await realpath(await createRoot("happy-workspaces-archive-replay-"));
        const projectFolder = join(root, "project-a");
        await mkdir(projectFolder, { recursive: true });
        const database = moduleDatabase([], "workspaces-archive-replay-edge");
        for (const [, migrate] of projectMigrations) {
            await migrate(database.context, database.database);
        }
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
        const projects = new ProjectsModule({});
        const workspaces = new WorkspacesModule({
            git: gitRunner,
            onHostError: (_ctx, workspaceId, operation) => {
                attempts.push(`${workspaceId}:${operation}`);
            },
            projects,
            rootContext: database.rootContext,
            workspacesDirectory: join(root, "workspaces"),
        });
        try {
            const project = await projects.create(database.context, "agent-a", {
                id: "project-a",
                repositoryRef: projectFolder,
                name: "Project A",
            });
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-archive-replay",
                projectRef: project.id,
                name: "Archive replay",
            });
            // A folder removal that cannot succeed, so every attempt at it is visible.
            await mkdir(join(root, "workspaces", "project-a"), { recursive: true });
            await symlink(join(root, "somewhere-else"), workspace.path);

            await workspaces.archive(database.context, "agent-a", "workspace-archive-replay", {
                operationId: "archive-repeat",
            });
            await workspaces.whenCleanupSettles();
            await workspaces.archive(database.context, "agent-a", "workspace-archive-replay", {
                operationId: "archive-repeat",
            });
            await workspaces.whenCleanupSettles();

            expect(attempts).toEqual(["workspace-archive-replay:archive"]);
        } finally {
            await workspaces.close(database.context);
            database.close();
        }
    });

    it("keeps the old branch when the Git branch cannot be moved and reports the error", async () => {
        const errors: string[] = [];
        const root = await createRoot("happy-workspaces-rename-failure-");
        const database = workspaceDatabase("workspaces-host-rename-failure-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                git: gitRunner,
                onHostError: (_ctx, workspaceId, operation, message) => {
                    errors.push(`${workspaceId}:${operation}:${message}`);
                },
                workspacesDirectory: join(root, "workspaces"),
            });
            const workspace = await reserve(workspaces, database, {
                id: "workspace-host-rename-failure",
                name: "Original branch",
            });

            // A real checkout on the branch the catalog recorded, but sharing its objects with a
            // repository the catalog was told nothing about.
            await mkdir(workspace.path, { recursive: true });
            await git(workspace.path, ["init", "--quiet", `--initial-branch=${workspace.branch}`]);
            await git(workspace.path, ["config", "user.email", "test@example.com"]);
            await git(workspace.path, ["config", "user.name", "Test"]);
            const baseCommit = await commitFile(workspace.path, "base.txt", "base\n");
            await workspaces.recordInitialization(database.context, "agent-a", {
                workspaceId: workspace.id,
                facts: {
                    baseCommit,
                    baseRef: "origin/main",
                    gitCommonDir: join(root, "elsewhere", ".git"),
                },
            });
            await workspaces.markReady(database.context, "agent-a", {
                workspaceId: workspace.id,
            });

            const renamed = await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-host-rename-failure",
                name: "New title",
            });
            // The catalog's own name changed; the branch in Git did not, so the record still says
            // what the checkout is actually on.
            expect(renamed).toMatchObject({
                name: "New title",
                branch: "worktree/original-branch",
            });
            expect(errors).toEqual([
                "workspace-host-rename-failure:rename:The workspace belongs to an unexpected repository.",
            ]);
        } finally {
            database.close();
        }
    });

    it("pages workspace and branch metadata detail with strictly advancing cursors", async () => {
        const database = workspaceDatabase("workspaces-detail-paging-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
            });
            await reserve(workspaces, database, {
                id: "workspace-detail-paging",
                name: "Detail paging",
            });

            let cursor = 0;
            let detail = "";
            for (;;) {
                const page = await workspaces.getPage(
                    database.context,
                    "agent-a",
                    "workspace-detail-paging",
                    { cursor, limit: 20 },
                );
                if (page.workspace === null) throw new Error("workspace unexpectedly missing");
                expect(page.cursor).toBe(cursor);
                detail += page.detail;
                if (page.nextCursor === undefined) {
                    expect(cursor + page.detail.length).toBe(page.total);
                    break;
                }
                expect(page.nextCursor).toBeGreaterThan(cursor);
                cursor = page.nextCursor;
            }
            expect(detail).toContain("Workspace ID: workspace-detail-paging");

            const metadata = await workspaces.branchMetadataPage(
                database.context,
                "agent-a",
                "workspace-detail-paging",
                { cursor: 0, limit: 10 },
            );
            expect(metadata.cursor).toBe(0);
            expect(metadata.detail.length).toBeLessThanOrEqual(10);
            expect(metadata.nextCursor).toBeGreaterThan(0);
        } finally {
            database.close();
        }
    });

    it("rebuilds a fresh module instance from the durable catalog", async () => {
        const database = workspaceDatabase("workspaces-restart-edge");
        await database.ready;
        try {
            const first = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            const created = await first.reserve(database.context, "agent-a", {
                id: "workspace-restart",
                projectRef: "project-a",
                name: "Restarted",
                baseRef: "origin/main",
            });
            await first.markReady(database.context, "agent-a", {
                workspaceId: created.workspace.id,
            });

            const second = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await expect(
                second.get(database.context, "agent-a", "workspace-restart"),
            ).resolves.toMatchObject({
                id: "workspace-restart",
                status: "ready",
                baseRef: "origin/main",
            });
            await expect(second.list(database.context, "agent-a")).resolves.toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("keeps concurrent same-name reservations unique", async () => {
        const database = workspaceDatabase("workspaces-concurrent-reservations-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            const results = await Promise.all(
                Array.from({ length: 8 }, (_, index) =>
                    workspaces.reserve(database.context, "agent-a", {
                        id: `workspace-concurrent-${String(index)}`,
                        projectRef: "project-a",
                        name: "Concurrent",
                    }),
                ),
            );

            expect(new Set(results.map(({ workspace }) => workspace.name)).size).toBe(8);
            expect(new Set(results.map(({ workspace }) => workspace.storageKey)).size).toBe(8);
            expect(new Set(results.map(({ workspace }) => workspace.branch)).size).toBe(8);
            expect(await workspaces.list(database.context, "agent-a")).toHaveLength(8);
        } finally {
            database.close();
        }
    });

    it("keeps maximum identity detail actionable at the minimum output budget", async () => {
        const database = workspaceDatabase("workspaces-output-bound-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                maxOutputCharacters: 256,
                workspacesDirectory: WORKSPACES_DIRECTORY,
            });
            const created = await workspaces.reserve(database.context, "agent-a", {
                id: "i".repeat(96),
                projectRef: "p".repeat(256),
                name: "N".repeat(MAX_WORKSPACE_NAME_LENGTH),
            });

            const page = await workspaces.listPage(database.context, "agent-a");
            expect(workspaces.formatPageForModel(page)).toContain(created.workspace.id);
            expect(workspaces.formatPageForModel(page).length).toBeLessThanOrEqual(256);
        } finally {
            database.close();
        }
    });

    it("answers branch metadata for a workspace whose folder is not there yet", async () => {
        const database = workspaceDatabase("workspaces-branch-metadata-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                workspacesDirectory: WORKSPACES_DIRECTORY,
            });
            const workspace = await reserve(workspaces, database, {
                id: "workspace-no-branch-folder",
            });

            // Nothing has been checked out, so there is no Git to read. The answer describes that
            // rather than failing or inventing a divergence.
            await expect(
                workspaces.branchMetadata(database.context, "agent-a", workspace.id),
            ).resolves.toEqual({
                workspaceId: workspace.id,
                ahead: 0,
                behind: 0,
                detached: false,
            });
        } finally {
            database.close();
        }
    });

    it("does not expose tools when disabled and keeps direct calls unavailable", async () => {
        const database = workspaceDatabase("workspaces-disabled-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                enabled: false,
                workspacesDirectory: WORKSPACES_DIRECTORY,
            });
            const hooks = workspaces.beforeStart(database.context, primaryAgents());
            expect(
                await hooks.tools?.(database.context, { agent: { id: "agent-a" } } as never),
            ).toEqual([]);
            await expect(workspaces.list(database.context, "agent-a")).rejects.toThrow(/disabled/i);
        } finally {
            database.close();
        }
    });

    it("gives workspace tools to a person's own conversation and not to a subagent", async () => {
        const database = workspaceDatabase("workspaces-subagent-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            const agents = {
                parentOf: (_ctx: unknown, agentId: string) =>
                    Promise.resolve(agentId === "subagent-a" ? "agent-a" : null),
            } as never;
            const hooks = workspaces.beforeStart(database.context, agents);

            const primary = await hooks.tools?.(database.context, {
                agent: { id: "agent-a" },
            } as never);
            expect(primary?.map((tool) => tool.name)).toContain("list_workspaces");
            expect(
                await hooks.tools?.(database.context, { agent: { id: "subagent-a" } } as never),
            ).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("rejects a schema-valid workspace whose status and presence are contradictory", async () => {
        const database = workspaceDatabase("workspaces-lifecycle-invariant-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await reserve(workspaces, database, { id: "workspace-invalid-lifecycle" });
            await agentDatabaseRows(
                database.database,
                sql`UPDATE happy_agent_module_workspaces
                    SET status = 'ready', presence = 'missing'
                    WHERE id = 'workspace-invalid-lifecycle'
                    RETURNING id`,
            );

            await expect(
                workspaces.get(database.context, "agent-a", "workspace-invalid-lifecycle"),
            ).rejects.toThrow(/lifecycle|presence|ready/i);
        } finally {
            database.close();
        }
    });
});

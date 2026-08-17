import { existsSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import {
    createWorkspaceStore,
    workspaceMigrations,
    workspaceModuleOptionsSchema,
    workspaceSchema,
    WorkspacesModule,
} from "../../sources/workspaces/index.js";
import { cleanupRoots, createRoot, gitRunner } from "../git/helpers.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { primaryAgents, resolveModuleHooks } from "../support/moduleHooks.js";

afterEach(cleanupRoots);

/**
 * Migrations are ordered, and the fourth one replaces the table the first one created. The shared
 * helper starts every migration at once, so this applies them the way the agent storage does.
 */
function workspaceDatabase(name: string): ReturnType<typeof moduleDatabase> {
    const database = moduleDatabase([], name);
    const ready = database.ready.then(async () => {
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
    });
    return { ...database, ready };
}

const ROW = {
    id: "workspace-1",
    ownerAgentId: "agent-1",
    projectRef: "project-1",
    name: "Workspace",
    nameConfigured: false,
    branch: "worktree/workspace",
    storageKey: "workspace",
    kind: "git_worktree",
    path: "/tmp/project-1/workspace",
    presence: "present",
    status: "ready",
    orderKey: "5",
    version: 1,
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    initializationAttempt: 1,
    createdAt: 1,
    updatedAt: 1,
};

/**
 * Where workspace folders are created. A catalog told this decides every path itself, so a test
 * that never touches the disk still gets the paths the real one would produce.
 */
const WORKSPACES_DIRECTORY = "/managed";

/** The catalogs a real archival needs: projects owns the folder, workspaces cuts from it. */
async function archivalDatabase(name: string): Promise<ReturnType<typeof moduleDatabase>> {
    const database = moduleDatabase([], name);
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    for (const [, migrate] of workspaceMigrations) {
        await migrate(database.context, database.database);
    }
    return database;
}

describe("WorkspacesModule", () => {
    it("owns its catalog migration and owns its Git and filesystem work", () => {
        const module = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });

        expect(module.name).toBe("workspaces");
        expect(module.migrations).toEqual(workspaceMigrations);
        expect(Value.Check(workspaceModuleOptionsSchema, {})).toBe(true);
        expect(Value.Check(workspaceModuleOptionsSchema, { store: {} })).toBe(false);
        // The catalog does the work itself, so there is no host to hand it and no seam to fill.
        expect(
            Value.Check(workspaceModuleOptionsSchema, {
                host: { pathForStorageKey: () => "/tmp/workspace" },
            }),
        ).toBe(false);
        expect(
            Value.Check(workspaceModuleOptionsSchema, {
                workspacesDirectory: WORKSPACES_DIRECTORY,
            }),
        ).toBe(true);
    });

    it("requires a branch, a folder, and a kind on every workspace row", () => {
        expect(Value.Check(workspaceSchema, ROW)).toBe(true);

        const { branch: _branch, ...withoutBranch } = ROW;
        expect(Value.Check(workspaceSchema, withoutBranch)).toBe(false);
        const { path: _path, ...withoutPath } = ROW;
        expect(Value.Check(workspaceSchema, withoutPath)).toBe(false);
        const { kind: _kind, ...withoutKind } = ROW;
        expect(Value.Check(workspaceSchema, withoutKind)).toBe(false);
        const { storageKey: _storageKey, ...withoutStorageKey } = ROW;
        expect(Value.Check(workspaceSchema, withoutStorageKey)).toBe(false);
        expect(Value.Check(workspaceSchema, { ...ROW, status: "active" })).toBe(false);
    });

    it("drops the obsolete replay tables in a forward migration", async () => {
        const database = workspaceDatabase("workspaces-drop-replay-test");
        await database.ready;

        try {
            const rows = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table'
                      AND name IN (
                          'happy_agent_module_workspace_operation_receipts',
                          'happy_agent_module_workspace_mutation_proofs'
                      )`,
            );
            expect(rows).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("reserves a portable folder key and a branch that follow the name", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-reserve-test");
        await database.ready;

        try {
            const { created, workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                operationId: "reserve-1",
                projectRef: "acme",
                name: "Retry policy rewrite",
            });

            expect(created).toBe(true);
            expect(workspace).toMatchObject({
                name: "Retry policy rewrite",
                nameConfigured: false,
                storageKey: "retry-policy-rewrite",
                branch: "worktree/retry-policy-rewrite",
                path: "/managed/acme/retry-policy-rewrite",
                kind: "git_worktree",
                // Nothing has been checked out yet: the folder is only there once the host says so.
                presence: "missing",
                status: "initializing",
                version: 1,
                initializationAttempt: 1,
            });
        } finally {
            database.close();
        }
    });

    it("counts past names, folder keys, and branches that are already taken", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-collision-test");
        await database.ready;

        try {
            const first = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            expect(first.workspace.branch).toBe("worktree/retry-policy");

            const second = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-2",
                projectRef: "acme",
                name: "Retry policy",
            });
            expect(second.workspace).toMatchObject({
                name: "Retry policy (2)",
                storageKey: "retry-policy-2",
                branch: "worktree/retry-policy-2",
            });

            // Git and the filesystem hold names the catalog knows nothing about.
            const third = await workspaces.reserve(
                database.context,
                "agent-a",
                { id: "workspace-3", projectRef: "acme", name: "Cache warmup" },
                {
                    isStorageKeyUnavailable: (key) => key === "cache-warmup",
                    isBranchUnavailable: (branch) =>
                        branch === "worktree/cache-warmup" || branch === "worktree/cache-warmup-2",
                    pathForStorageKey: (key) => `/managed/acme/${key}`,
                },
            );
            expect(third.workspace).toMatchObject({
                name: "Cache warmup",
                storageKey: "cache-warmup-2",
                branch: "worktree/cache-warmup-3",
                path: "/managed/acme/cache-warmup-2",
            });
        } finally {
            database.close();
        }
    });

    it("returns the same workspace for a repeated reservation and refuses a different one", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-retry-test");
        await database.ready;

        try {
            const first = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
                baseRef: "origin/main",
            });
            const again = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
                baseRef: "origin/main",
            });

            expect(again.created).toBe(false);
            expect(again.workspace).toEqual(first.workspace);

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-1",
                    projectRef: "other",
                    name: "Retry policy",
                }),
            ).rejects.toThrow("another project");
            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-1",
                    projectRef: "acme",
                    name: "Retry policy",
                    baseRef: "origin/release",
                }),
            ).rejects.toThrow("different base");
        } finally {
            database.close();
        }
    });

    it("walks a workspace through setup, readiness, and failure", async () => {
        const changes: string[] = [];
        const workspaces = new WorkspacesModule({
            workspacesDirectory: WORKSPACES_DIRECTORY,
            eventIdFactory: () => "event-lifecycle",
            listener: {
                onEventTransactional: (_ctx, event) => {
                    changes.push(event.type === "workspace_updated" ? event.change : event.type);
                },
            },
        });
        const database = workspaceDatabase("workspaces-lifecycle-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });

            const initialized = await workspaces.recordInitialization(database.context, "agent-a", {
                workspaceId: workspace.id,
                facts: {
                    baseCommit: "abc123",
                    baseRef: "origin/main",
                    gitCommonDir: "/repo/.git",
                },
            });
            expect(initialized).toMatchObject({
                baseCommit: "abc123",
                baseRef: "origin/main",
                gitCommonDir: "/repo/.git",
                status: "initializing",
                version: 2,
            });

            const ready = await workspaces.markReady(database.context, "agent-a", {
                workspaceId: workspace.id,
            });
            expect(ready).toMatchObject({ status: "ready", presence: "present", version: 3 });

            const branched = await workspaces.setBranch(database.context, "agent-a", {
                workspaceId: workspace.id,
                branch: "worktree/retry-policy-actual",
            });
            expect(branched).toMatchObject({
                branch: "worktree/retry-policy-actual",
                version: 4,
            });

            const failed = await workspaces.markFailed(database.context, "agent-a", {
                workspaceId: workspace.id,
                error: "The worktree folder disappeared.",
            });
            expect(failed).toMatchObject({
                status: "failed",
                initializationError: "The worktree folder disappeared.",
                version: 5,
            });

            expect(changes).toEqual([
                "workspace_created",
                "record_initialization",
                "mark_ready",
                "set_branch",
                "mark_failed",
            ]);
        } finally {
            database.close();
        }
    });

    it("counts a failed setup attempt and leaves a ready workspace alone", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-setup-failure-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            const failed = await workspaces.markInitializationFailed(database.context, "agent-a", {
                workspaceId: workspace.id,
                error: "git worktree add refused the branch.",
            });
            expect(failed).toMatchObject({
                status: "failed",
                initializationAttempt: 2,
                initializationError: "git worktree add refused the branch.",
            });

            // A workspace that never became ready is not marked failed a second time.
            const unchanged = await workspaces.markFailed(database.context, "agent-a", {
                workspaceId: workspace.id,
                error: "Something else.",
            });
            expect(unchanged.version).toBe(failed.version);
        } finally {
            database.close();
        }
    });

    it("lets a first chat name a placeholder but never a name someone chose", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-inherit-name-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Workspace",
            });
            expect(workspace.nameConfigured).toBe(false);

            const inherited = await workspaces.inheritName(database.context, "agent-a", {
                workspaceId: workspace.id,
                name: "Retry policy rewrite",
            });
            expect(inherited).toMatchObject({
                name: "Retry policy rewrite",
                branch: "worktree/retry-policy-rewrite",
                nameConfigured: false,
            });

            const named = await workspaces.rename(database.context, "agent-a", {
                workspaceId: workspace.id,
                name: "Cache warmup",
            });
            expect(named).toMatchObject({ name: "Cache warmup", nameConfigured: true });

            const ignored = await workspaces.inheritName(database.context, "agent-a", {
                workspaceId: workspace.id,
                name: "Something the chat decided",
            });
            expect(ignored).toEqual(named);
        } finally {
            database.close();
        }
    });

    it("refuses a rename that was decided against a stale version", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-stale-rename-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            await workspaces.rename(database.context, "agent-a", {
                workspaceId: workspace.id,
                name: "Cache warmup",
            });

            await expect(
                workspaces.rename(database.context, "agent-a", {
                    workspaceId: workspace.id,
                    name: "Too late",
                    expectedVersion: workspace.version,
                }),
            ).rejects.toThrow("changed before it could be renamed");
        } finally {
            database.close();
        }
    });

    it("moves a workspace in the main list", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-reorder-test");
        await database.ready;

        try {
            for (const [id, name] of [
                ["workspace-1", "First"],
                ["workspace-2", "Second"],
                ["workspace-3", "Third"],
            ] as const) {
                await workspaces.reserve(database.context, "agent-a", {
                    id,
                    projectRef: "acme",
                    name,
                });
            }
            // Each reservation goes to the top, so the newest workspace leads the list.
            expect(
                (await workspaces.list(database.context, "agent-a")).map((row) => row.id),
            ).toEqual(["workspace-3", "workspace-2", "workspace-1"]);

            const moved = await workspaces.reorder(database.context, "agent-a", {
                workspaceId: "workspace-3",
                afterId: "workspace-2",
            });
            expect(
                (await workspaces.list(database.context, "agent-a")).map((row) => row.id),
            ).toEqual(["workspace-2", "workspace-3", "workspace-1"]);

            const top = await workspaces.reorder(database.context, "agent-a", {
                workspaceId: "workspace-1",
                afterId: null,
                expectedVersion: 1,
            });
            expect(top.version).toBe(2);
            expect(
                (await workspaces.list(database.context, "agent-a")).map((row) => row.id),
            ).toEqual(["workspace-1", "workspace-2", "workspace-3"]);

            await expect(
                workspaces.reorder(database.context, "agent-a", {
                    workspaceId: "workspace-3",
                    afterId: null,
                    expectedVersion: moved.version + 5,
                }),
            ).rejects.toThrow("changed before it could be reordered");
        } finally {
            database.close();
        }
    });

    it("answers an archive before the folder is gone and removes it in the background", async () => {
        const eventTypes: string[] = [];
        // The catalog canonicalizes the folder it is given, so the test compares against the same
        // canonical form rather than the symlinked temporary path the platform handed out.
        const root = await realpath(await createRoot("happy-workspaces-archive-"));
        const projectFolder = join(root, "acme");
        await mkdir(projectFolder, { recursive: true });
        const database = await archivalDatabase("workspaces-archive-test");
        const projects = new ProjectsModule({});
        const workspaces = new WorkspacesModule({
            eventIdFactory: () => "event-archive",
            git: gitRunner,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    eventTypes.push(event.type === "workspace_updated" ? event.change : event.type);
                },
            },
            projects,
            rootContext: database.rootContext,
            workspacesDirectory: join(root, "workspaces"),
        });

        try {
            // The project's own folder key names the directory its workspaces sit under, so the
            // identity the catalog picked is the identity removal checks the path against.
            const project = await projects.create(database.context, "agent-a", {
                id: "acme",
                repositoryRef: projectFolder,
                name: "Acme",
            });
            expect(project.storageKey).toBe("acme");

            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: project.id,
                name: "Retry policy",
            });
            expect(workspace.path).toBe(join(root, "workspaces", "acme", "retry-policy"));
            await mkdir(workspace.path, { recursive: true });
            await writeFile(join(workspace.path, "notes.txt"), "work in progress\n");

            const archived = await workspaces.archive(database.context, "agent-a", workspace.id);

            // The decision is durable and answered before the folder has been taken away.
            expect(archived.status).toBe("archiving");
            expect(
                await workspaces.list(database.context, "agent-a", { includeArchived: false }),
            ).toEqual([]);

            await workspaces.whenCleanupSettles();

            expect(existsSync(workspace.path)).toBe(false);
            const settled = await workspaces.get(database.context, "agent-a", workspace.id);
            expect(settled).toMatchObject({ status: "archived" });
            expect(settled!.archivedAt).toBeGreaterThanOrEqual(settled!.createdAt);
            expect(eventTypes).toEqual([
                "workspace_created",
                "begin_archive",
                "workspace_archived",
            ]);
        } finally {
            await workspaces.close(database.context);
            database.close();
        }
    });

    it("keeps a workspace archived when its folder cannot be removed", async () => {
        const reported: string[] = [];
        const root = await realpath(await createRoot("happy-workspaces-archive-failure-"));
        const projectFolder = join(root, "acme");
        await mkdir(projectFolder, { recursive: true });
        const database = await archivalDatabase("workspaces-archive-failure-test");
        const projects = new ProjectsModule({});
        const workspaces = new WorkspacesModule({
            git: gitRunner,
            onHostError: (_ctx, workspaceId, operation, message) => {
                reported.push(`${workspaceId}:${operation}:${message}`);
            },
            projects,
            rootContext: database.rootContext,
            workspacesDirectory: join(root, "workspaces"),
        });

        try {
            const project = await projects.create(database.context, "agent-a", {
                id: "acme",
                repositoryRef: projectFolder,
                name: "Acme",
            });
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: project.id,
                name: "Retry policy",
            });

            // Something left a link where the managed folder should be. Following it is not this
            // catalog's to do, so removal refuses rather than deleting whatever it names.
            await mkdir(join(root, "workspaces", "acme"), { recursive: true });
            await symlink(join(root, "somewhere-else"), workspace.path);

            const archived = await workspaces.archive(database.context, "agent-a", workspace.id);
            await workspaces.whenCleanupSettles();

            // Cleanup failed. The archival it followed is not undone, and it was never the caller's
            // error to handle.
            expect(archived.status).toBe("archiving");
            expect(reported).toEqual([
                "workspace-1:archive:Refusing to archive a workspace path that is a symbolic link.",
            ]);
            expect(existsSync(projectFolder)).toBe(true);
            // The decision stands: it is gone from the active list and it does not come back.
            await expect(
                workspaces.get(database.context, "agent-a", workspace.id),
            ).resolves.toMatchObject({ status: "archived" });
            expect(
                await workspaces.list(database.context, "agent-a", { includeArchived: false }),
            ).toEqual([]);
        } finally {
            await workspaces.close(database.context);
            database.close();
        }
    });

    it("writes Git facts only when they actually changed", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-git-facts-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            const facts = {
                head: "abc123",
                upstream: "origin/worktree/retry-policy",
                ahead: 2,
                behind: 0,
                detached: false,
            };

            const applied = await workspaces.applyGitFacts(database.context, "agent-a", {
                workspaceId: workspace.id,
                facts,
            });
            expect(applied).toMatchObject({
                gitHead: "abc123",
                gitUpstream: "origin/worktree/retry-policy",
                gitAhead: 2,
                version: workspace.version + 1,
            });

            const again = await workspaces.applyGitFacts(database.context, "agent-a", {
                workspaceId: workspace.id,
                facts,
            });
            expect(again).toEqual(applied);

            // A probe only describes a workspace someone can already use. A folder does not become
            // real because something looked at it while the workspace was still being set up.
            const ignored = await workspaces.applyProbe(database.context, "agent-a", {
                workspaceId: workspace.id,
                presence: "present",
                facts,
            });
            expect(ignored.presence).toBe("missing");

            await workspaces.markReady(database.context, "agent-a", {
                workspaceId: workspace.id,
            });
            const probed = await workspaces.applyProbe(database.context, "agent-a", {
                workspaceId: workspace.id,
                presence: "missing",
                facts,
            });
            expect(probed).toMatchObject({ presence: "missing", status: "ready" });
        } finally {
            database.close();
        }
    });

    it("resolves a folder back to the workspace that lives in it", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-by-path-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(
                database.context,
                "agent-a",
                { id: "workspace-1", projectRef: "acme", name: "Retry policy" },
                { pathForStorageKey: (key) => `/managed/acme/${key}` },
            );

            await expect(
                workspaces.getByPath(database.context, "agent-a", "/managed/acme/retry-policy"),
            ).resolves.toEqual(workspace);
            await expect(
                workspaces.getByPath(database.context, "agent-a", "/managed/acme/elsewhere"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("uses transactional database tools and keeps host transfer non-durable", async () => {
        const workspaces = new WorkspacesModule({
            workspacesDirectory: WORKSPACES_DIRECTORY,
            idFactory: () => "workspace-generated",
            eventIdFactory: () => "event-tool",
            clock: () => 123,
        });
        const database = workspaceDatabase("workspaces-tool-commit-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, workspaces, primaryAgents());

        try {
            const call = (id: string) =>
                ({
                    id,
                    providerCallId: `provider-${id}`,
                    kv: {},
                }) as never;
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<NonNullable<typeof hooks.tools>>[1];
            const tools = await hooks.tools!(database.context, scope);
            const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

            const created = await tool("create_workspace").execute(
                database.context,
                { name: "Durable workspace", projectRef: "acme" },
                call("call-create"),
            );
            // The tool's own call ID is the workspace's identity, so a retried call finds the
            // workspace the first attempt made instead of inventing a second one.
            expect(created).toMatchObject({
                id: "call-create",
                branch: "worktree/durable-workspace",
                status: "initializing",
            });

            const renamed = await tool("rename_workspace").execute(
                database.context,
                { workspaceId: created.id, name: "Retry policy" },
                call("call-rename"),
            );
            expect(renamed).toMatchObject({
                name: "Retry policy",
                branch: "worktree/retry-policy",
                nameConfigured: true,
            });

            const transferred = await tool("transfer_workspace").execute(
                database.context,
                { targetWorkspaceId: created.id },
                call("call-transfer"),
            );
            expect(transferred).toMatchObject({
                state: "scheduled",
                targetWorkspaceId: "call-create",
                operationId: "call-transfer",
            });

            const archived = await tool("archive_workspace").execute(
                database.context,
                { workspaceId: created.id },
                call("call-archive"),
            );
            expect(archived.status).toBe("archived");

            expect([
                tool("create_workspace").transactional,
                tool("rename_workspace").transactional,
                tool("archive_workspace").transactional,
            ]).toEqual([true, true, true]);
            expect(tool("transfer_workspace").durable).toBe(false);
            expect([
                tool("list_workspaces").durable,
                tool("get_workspace").durable,
                tool("get_workspace_branch_metadata").durable,
            ]).toEqual([false, false, false]);
        } finally {
            database.close();
        }
    });

    it("moves a workspace between projects and keeps its folder", async () => {
        const eventTypes: string[] = [];
        const workspaces = new WorkspacesModule({
            workspacesDirectory: WORKSPACES_DIRECTORY,
            eventIdFactory: () => "event-transfer",
            listener: {
                onEventTransactional: (_ctx, event) => {
                    eventTypes.push(event.type);
                },
            },
        });
        const database = workspaceDatabase("workspaces-transfer-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });

            const fresh = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
            await expect(
                fresh.transfer(database.context, "agent-a", {
                    workspaceId: workspace.id,
                    targetProjectRef: "beta",
                    operationId: "transfer-project",
                }),
            ).resolves.toMatchObject({
                state: "transferred",
                workspace: { projectRef: "beta", path: workspace.path },
            });
            expect(eventTypes).toEqual(["workspace_created"]);
        } finally {
            database.close();
        }
    });

    it("reviews archive and transfer without requesting Full access", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-review-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, workspaces, primaryAgents());

        try {
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<NonNullable<typeof hooks.tools>>[1];
            const tools = await hooks.tools!(database.context, scope);
            const transfer = tools.find((tool) => tool.name === "transfer_workspace");
            const archive = tools.find((tool) => tool.name === "archive_workspace");
            expect(transfer).toBeDefined();
            expect(archive).toBeDefined();
            expect(
                await transfer!.shouldReviewInAutoMode(
                    { targetWorkspaceId: "workspace-target" },
                    database.context,
                ),
            ).toBe(true);
            expect(
                transfer!.describeAutoPermissionAction?.(
                    { targetWorkspaceId: "workspace-target" },
                    database.context,
                ),
            ).toContain("local working state");
            expect(transfer!.shouldRunInFullAccessInAutoMode).toBeUndefined();
            expect(
                await archive!.shouldReviewInAutoMode(
                    { workspaceId: "workspace-a" },
                    database.context,
                ),
            ).toBe(true);
            expect(
                archive!.describeAutoPermissionAction?.(
                    { workspaceId: "workspace-a" },
                    database.context,
                ),
            ).toContain("worktree");
            expect(archive!.shouldRunInFullAccessInAutoMode).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("refuses to reserve a workspace at a folder key that is not a folder", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-blind-reservation-test");
        await database.ready;

        try {
            // A folder key alone is not a folder: a reservation records somewhere Git can be
            // handed without resolving it again.
            await expect(
                workspaces.reserve(
                    database.context,
                    "agent-a",
                    { id: "workspace-1", projectRef: "acme", name: "Retry policy" },
                    {
                        isBranchUnavailable: () => false,
                        isStorageKeyUnavailable: () => false,
                        pathForStorageKey: (storageKey) => `acme/${storageKey}`,
                    },
                ),
            ).rejects.toThrow("absolute path");

            expect(await workspaces.list(database.context, "agent-a")).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("consults Git through a probe that may take a moment to answer", async () => {
        const asked: string[] = [];
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-async-probe-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(
                database.context,
                "agent-a",
                { id: "workspace-1", projectRef: "acme", name: "Retry policy" },
                {
                    // Reading loose and packed refs is real work, so an answer may be a promise.
                    isBranchUnavailable: async (branch) => {
                        asked.push(branch);
                        await Promise.resolve();
                        return branch === "worktree/retry-policy";
                    },
                    isStorageKeyUnavailable: async () => false,
                },
            );

            expect(asked).toEqual(["worktree/retry-policy", "worktree/retry-policy-2"]);
            expect(workspace).toMatchObject({
                branch: "worktree/retry-policy-2",
                path: "/managed/acme/retry-policy",
            });
        } finally {
            database.close();
        }
    });

    it("makes one workspace when a create is retried after a crash", async () => {
        const events: string[] = [];
        let identities = 0;
        const workspaces = new WorkspacesModule({
            workspacesDirectory: WORKSPACES_DIRECTORY,
            // A retry runs in a new process, so nothing it generates matches the first attempt.
            idFactory: () => `workspace-${String((identities += 1))}`,
            eventIdFactory: () => `event-${String(events.length + 1)}`,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event.type);
                },
            },
        });
        const database = workspaceDatabase("workspaces-crash-retry-test");
        await database.ready;

        try {
            const create = {
                operationId: "call-create",
                projectRef: "acme",
                name: "Retry policy",
            } as const;
            const first = await workspaces.reserve(database.context, "agent-a", create);
            const retried = await workspaces.reserve(database.context, "agent-a", create);

            expect(first.created).toBe(true);
            expect(retried.created).toBe(false);
            expect(retried.workspace).toEqual(first.workspace);
            expect(identities).toBe(0);

            const rows = await agentDatabaseRows<{ readonly id: string }>(
                database.database,
                sql`SELECT id FROM happy_agent_module_workspaces`,
            );
            expect(rows).toEqual([{ id: "call-create" }]);
            expect(events).toEqual(["workspace_created"]);
        } finally {
            database.close();
        }
    });

    it("ignores every observation that arrives after a workspace was archived", async () => {
        const events: string[] = [];
        const workspaces = new WorkspacesModule({
            workspacesDirectory: WORKSPACES_DIRECTORY,
            eventIdFactory: () => `event-${String(events.length + 1)}`,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event.type === "workspace_updated" ? event.change : event.type);
                },
            },
        });
        const database = workspaceDatabase("workspaces-late-observation-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            await workspaces.markReady(database.context, "agent-a", {
                workspaceId: workspace.id,
            });
            const archived = await workspaces.beginArchive(
                database.context,
                "agent-a",
                workspace.id,
            );
            const settledEvents = [...events];

            // Scans, renames, and branch reports that were already in flight describe a workspace
            // nobody has any more. None of them may touch the row, its version, or the log.
            const late = [
                await workspaces.applyGitFacts(database.context, "agent-a", {
                    workspaceId: workspace.id,
                    facts: { head: "abc123", ahead: 3, behind: 1, detached: false },
                }),
                await workspaces.setBranch(database.context, "agent-a", {
                    workspaceId: workspace.id,
                    branch: "worktree/something-else",
                }),
                await workspaces.rename(database.context, "agent-a", {
                    workspaceId: workspace.id,
                    name: "Renamed too late",
                }),
                await workspaces.inheritName(database.context, "agent-a", {
                    workspaceId: workspace.id,
                    name: "Named by a first chat",
                }),
            ];

            for (const observed of late) expect(observed).toEqual(archived);
            expect(events).toEqual(settledEvents);
        } finally {
            database.close();
        }
    });

    it("refuses a write decided against a row that changed underneath it", async () => {
        const database = workspaceDatabase("workspaces-lost-update-test");
        await database.ready;
        let interfere = false;
        // The catalog's own Git and filesystem answers, driven straight through the store: reading
        // refs is real work, and a rename asks for it between the read it decided from and the
        // guarded write it applies.
        const store = createWorkspaceStore({
            host: {
                pathForStorageKey: (projectRef, storageKey) =>
                    `/managed/${projectRef}/${storageKey}`,
                isStorageKeyUnavailable: () => false,
                isBranchUnavailable: async () => {
                    if (!interfere) return false;
                    interfere = false;
                    await agentDatabaseRows(
                        database.database,
                        sql`UPDATE happy_agent_module_workspaces
                            SET version = version + 1 WHERE id = 'workspace-1' RETURNING id`,
                    );
                    return false;
                },
            },
        });

        try {
            const reserved = await store.reserve(
                database.context,
                "agent-a",
                {
                    id: "workspace-1",
                    ownerAgentId: "agent-a",
                    projectRef: "acme",
                    name: "Retry policy",
                    nameConfigured: false,
                    kind: "git_worktree",
                },
                {},
                { operation: "reserve", operationId: "reserve-1" },
            );

            interfere = true;
            await expect(
                store.rename(
                    database.context,
                    "agent-a",
                    { workspaceId: reserved.workspace.id, name: "Cache warmup" },
                    { operation: "rename", operationId: "rename-1" },
                ),
            ).rejects.toThrow("changed before this write could be applied");

            // The write was refused outright, so nothing of the rename reached the row: only the
            // version the interfering commit left behind is different.
            const after = await store.get(database.context, "agent-a", reserved.workspace.id);
            expect(after).toEqual({
                ...reserved.workspace,
                version: reserved.workspace.version + 1,
            });
        } finally {
            database.close();
        }
    });

    it("lists the workspaces someone can still work in and keeps history behind a flag", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-active-only-test");
        await database.ready;

        try {
            for (const [id, name] of [
                ["workspace-1", "Retry policy"],
                ["workspace-2", "Cache warmup"],
            ] as const) {
                await workspaces.reserve(database.context, "agent-a", {
                    id,
                    projectRef: "acme",
                    name,
                });
            }
            await workspaces.archive(database.context, "agent-a", "workspace-1");

            expect(
                (await workspaces.list(database.context, "agent-a")).map((row) => row.id),
            ).toEqual(["workspace-2"]);
            expect(
                (await workspaces.list(database.context, "agent-a", { includeArchived: true })).map(
                    (row) => row.id,
                ),
            ).toEqual(["workspace-2", "workspace-1"]);
        } finally {
            database.close();
        }
    });

    it("does not offer a cursor to a page that has already shown everything", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-exact-page-test");
        await database.ready;

        try {
            for (const [id, name] of [
                ["workspace-1", "Retry policy"],
                ["workspace-2", "Cache warmup"],
            ] as const) {
                await workspaces.reserve(database.context, "agent-a", {
                    id,
                    projectRef: "acme",
                    name,
                });
            }

            const exact = await workspaces.listPage(database.context, "agent-a", { limit: 2 });
            expect(exact.workspaces).toHaveLength(2);
            expect(exact.nextCursor).toBeUndefined();
            expect(workspaces.formatPageForModel(exact)).not.toContain("More workspaces");

            const partial = await workspaces.listPage(database.context, "agent-a", { limit: 1 });
            expect(partial.nextCursor).toBe(1);
        } finally {
            database.close();
        }
    });

    it("tells a model how a workspace is doing rather than what the column says", async () => {
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        const database = workspaceDatabase("workspaces-model-text-test");
        await database.ready;

        try {
            const { workspace } = await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });

            const page = workspaces.formatPageForModel(
                await workspaces.listPage(database.context, "agent-a"),
            );
            expect(page).toContain("Retry policy — being set up");
            expect(page).not.toContain("[initializing]");

            const detail = workspaces.formatWorkspaceForModel(workspace);
            expect(detail).toContain("Retry policy — being set up");
            expect(detail).not.toContain("[initializing]");
        } finally {
            database.close();
        }
    });

    it("picks again from a fresh snapshot when another reservation took the name first", async () => {
        const database = workspaceDatabase("workspaces-reservation-race-test");
        await database.ready;
        const workspaces = new WorkspacesModule({ workspacesDirectory: WORKSPACES_DIRECTORY });
        /** Another reservation commits between this one's snapshot and its insert. */
        const takeTheName = async (): Promise<void> => {
            await agentDatabaseRows(
                database.database,
                sql`INSERT INTO happy_agent_module_workspaces (
                        id, owner_agent_id, project_ref, name, name_key, name_configured,
                        branch, storage_key, kind, path, presence, status, order_key,
                        version, git_ahead, git_behind, git_detached,
                        initialization_attempt, created_at, updated_at
                    ) VALUES (
                        'workspace-rival', 'agent-a', 'acme', 'Retry policy',
                        'retry policy', 0, 'worktree/retry-policy', 'retry-policy',
                        'git_worktree', '/managed/acme/retry-policy', 'missing',
                        'initializing', '500', 1, 0, 0, 0, 1, 1, 1
                    ) RETURNING id`,
            );
        };

        try {
            let rivalStillToCome = true;
            const { created, workspace } = await workspaces.reserve(
                database.context,
                "agent-a",
                { id: "workspace-1", projectRef: "acme", name: "Retry policy" },
                {
                    isBranchUnavailable: async () => {
                        if (!rivalStillToCome) return false;
                        rivalStillToCome = false;
                        await takeTheName();
                        return false;
                    },
                },
            );

            // The unique index decided the winner; the loser kept its own identity and picked a
            // name, folder key, and branch nothing else answers to.
            expect(created).toBe(true);
            expect(workspace).toMatchObject({
                id: "workspace-1",
                name: "Retry policy (2)",
                storageKey: "retry-policy-2",
                branch: "worktree/retry-policy-2",
                path: "/managed/acme/retry-policy-2",
            });
        } finally {
            database.close();
        }
    });

    it("refuses text a person could not have typed and paths a host did not normalize", () => {
        // Control characters reach a terminal, a branch name, or a filesystem call as an escape
        // sequence rather than as the text someone meant.
        expect(Value.Check(workspaceSchema, { ...ROW, name: "Retry\u0007policy" })).toBe(false);
        expect(Value.Check(workspaceSchema, { ...ROW, name: "Retry policy" })).toBe(true);

        // Git refuses these itself, so a row that holds one describes a branch that cannot exist.
        for (const branch of [
            "worktree/retry..policy",
            "worktree/retry policy",
            "worktree/retry-policy.lock",
            "worktree/retry-policy/",
            "worktree/retry-policy.",
            "worktree/@{now}",
            "worktree/retry^policy",
        ]) {
            expect(Value.Check(workspaceSchema, { ...ROW, branch })).toBe(false);
        }
        expect(Value.Check(workspaceSchema, { ...ROW, branch: "worktree/retry-policy" })).toBe(
            true,
        );

        // A workspace folder is somewhere a host can hand to Git without resolving it again.
        for (const path of [
            "acme/workspace",
            "/tmp/../workspace",
            "/tmp/./workspace",
            "/tmp/workspace/",
            "",
        ]) {
            expect(Value.Check(workspaceSchema, { ...ROW, path })).toBe(false);
        }
        expect(Value.Check(workspaceSchema, { ...ROW, path: "/tmp/project-1/workspace" })).toBe(
            true,
        );
        expect(Value.Check(workspaceSchema, { ...ROW, path: "C:\\Users\\rig\\workspace" })).toBe(
            true,
        );
    });
});

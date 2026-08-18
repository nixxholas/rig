import { join } from "node:path";

import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { workspaceMigrations, workspaceSchema } from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { temporaryWorkspacesCatalog } from "../support/workspacesModule.js";

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

describe("WorkspacesModule", () => {
    it("is assembled from modules and takes its managed path from configuration", async () => {
        const { config, workspaces, workspacesDirectory } = await temporaryWorkspacesCatalog();

        expect(workspaces.name).toBe("workspaces");
        expect(workspaces.migrations).toEqual(workspaceMigrations);
        expect(workspacesDirectory).toContain("workspaces");
        expect(workspaces.pathForStorageKey("acme", "retry-policy")).toBe(
            join(workspacesDirectory, "acme", "retry-policy"),
        );
        expect(config.workspacesHome.endsWith("workspaces")).toBe(true);
    });

    it("requires a branch, folder, and kind on every workspace row", () => {
        expect(Value.Check(workspaceSchema, ROW)).toBe(true);

        const { branch: _branch, ...withoutBranch } = ROW;
        expect(Value.Check(workspaceSchema, withoutBranch)).toBe(false);
        const { path: _path, ...withoutPath } = ROW;
        expect(Value.Check(workspaceSchema, withoutPath)).toBe(false);
        const { kind: _kind, ...withoutKind } = ROW;
        expect(Value.Check(workspaceSchema, withoutKind)).toBe(false);
    });

    it("drops obsolete replay tables in the forward migration", async () => {
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

    it("reserves a portable folder key and branch that follow the name", async () => {
        const { workspaces, workspacesDirectory } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-reserve-test");
        await database.ready;
        try {
            const { created, workspace } = await workspaces.reserve(database.context, {
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
                path: join(workspacesDirectory, "acme", "retry-policy-rewrite"),
                kind: "git_worktree",
                presence: "missing",
                status: "initializing",
                version: 1,
                initializationAttempt: 1,
            });
        } finally {
            database.close();
        }
    });

    it("uses reservation hooks only while choosing names unavailable to the catalog", async () => {
        const { workspaces, workspacesDirectory } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-collision-test");
        await database.ready;
        try {
            const workspace = await workspaces.reserve(
                database.context,
                { id: "workspace-3", projectRef: "acme", name: "Cache warmup" },
                {
                    isStorageKeyUnavailable: (key) => key === "cache-warmup",
                    isBranchUnavailable: (branch) =>
                        branch === "worktree/cache-warmup" || branch === "worktree/cache-warmup-2",
                    pathForStorageKey: (key) => join(workspacesDirectory, "acme", key),
                },
            );

            expect(workspace.workspace).toMatchObject({
                name: "Cache warmup",
                storageKey: "cache-warmup-2",
                branch: "worktree/cache-warmup-3",
                path: join(workspacesDirectory, "acme", "cache-warmup-2"),
            });
        } finally {
            database.close();
        }
    });

    it("returns the same workspace for a repeated reservation and rejects different details", async () => {
        const { workspaces } = await temporaryWorkspacesCatalog();
        const database = workspaceDatabase("workspaces-retry-test");
        await database.ready;
        try {
            const input = {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
                baseRef: "origin/main",
            };
            const first = await workspaces.reserve(database.context, input);
            const again = await workspaces.reserve(database.context, input);

            expect(again).toEqual({ created: false, workspace: first.workspace });
            await expect(
                workspaces.reserve(database.context, { ...input, projectRef: "other" }),
            ).rejects.toThrow("another project");
            await expect(
                workspaces.reserve(database.context, { ...input, baseRef: "origin/release" }),
            ).rejects.toThrow("different base");
        } finally {
            database.close();
        }
    });

    it("records lifecycle changes and publishes them transactionally", async () => {
        const changes: string[] = [];
        const { workspaces } = await temporaryWorkspacesCatalog();
        const unsubscribe = workspaces.onEventTransactional((_ctx, event) => {
            changes.push(event.type === "workspace_updated" ? event.change : event.type);
        });
        const database = workspaceDatabase("workspaces-lifecycle-test");
        await database.ready;
        try {
            const { workspace } = await workspaces.reserve(database.context, {
                id: "workspace-1",
                projectRef: "acme",
                name: "Retry policy",
            });
            await workspaces.recordInitialization(database.context, {
                workspaceId: workspace.id,
                facts: {
                    baseCommit: "abc123",
                    baseRef: "origin/main",
                    gitCommonDir: "/repo/.git",
                },
            });
            await workspaces.markReady(database.context, { workspaceId: workspace.id });
            await workspaces.setBranch(database.context, {
                workspaceId: workspace.id,
                branch: "worktree/retry-policy-actual",
            });
            const failed = await workspaces.markFailed(database.context, {
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
            unsubscribe();
            database.close();
        }
    });
});

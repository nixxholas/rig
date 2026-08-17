import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    MAX_WORKSPACE_NAME_LENGTH,
    MAX_WORKSPACE_STORAGE_KEY_LENGTH,
    type Workspace,
    type WorkspaceEvent,
    type WorkspaceHost,
    workspaceBranchSchema,
    workspaceMigrations,
    WorkspacesModule,
} from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { primaryAgents } from "../support/moduleHooks.js";

function workspaceDatabase(name: string): ReturnType<typeof moduleDatabase> {
    const database = moduleDatabase([], name);
    const ready = database.ready.then(async () => {
        for (const [, migrate] of workspaceMigrations) {
            await migrate(database.context, database.database);
        }
    });
    return { ...database, ready };
}

const HOST: WorkspaceHost = {
    pathForStorageKey: (projectRef, storageKey) => `/managed/${projectRef}/${storageKey}`,
    isBranchUnavailable: () => false,
    isStorageKeyUnavailable: () => false,
};

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
                host: HOST,
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

    it("preserves the receiver when host reservation methods are called", async () => {
        const database = workspaceDatabase("workspaces-host-receiver-reserve-edge");
        await database.ready;
        try {
            class ReceiverHost {
                static readonly root = "/receiver-managed";

                get root(): string {
                    return ReceiverHost.root;
                }

                pathForStorageKey(this: ReceiverHost, projectRef: string, key: string) {
                    return `${this.root}/${projectRef}/${key}`;
                }

                isBranchUnavailable() {
                    return false;
                }

                isStorageKeyUnavailable() {
                    return false;
                }
            }
            const workspaces = new WorkspacesModule({
                host: new ReceiverHost() as unknown as WorkspaceHost,
            });

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-host-receiver",
                    projectRef: "project-a",
                    name: "Receiver",
                }),
            ).resolves.toMatchObject({
                path: "/receiver-managed/project-a/receiver",
            });
        } finally {
            database.close();
        }
    });

    it("rejects invalid host availability answers instead of coercing them", async () => {
        const database = workspaceDatabase("workspaces-invalid-probe-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                host: {
                    ...HOST,
                    isBranchUnavailable: (() => 0) as never,
                },
            });

            await expect(
                workspaces.reserve(database.context, "agent-a", {
                    id: "workspace-invalid-probe",
                    projectRef: "project-a",
                    name: "Invalid probe",
                }),
            ).rejects.toThrow(/invalid|boolean/i);
        } finally {
            database.close();
        }
    });

    it("validates getByPath input as an already-normalized absolute path", async () => {
        const database = workspaceDatabase("workspaces-path-input-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
                host: HOST,
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
                host: HOST,
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
                host: HOST,
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
                const workspaces = new WorkspacesModule({ host: HOST, ...testCase.options });
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
                host: HOST,
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
                host: HOST,
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
                host: HOST,
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

    it("reconciles compact host transfer receipts with the authoritative workspace row", async () => {
        const database = workspaceDatabase("workspaces-transfer-receipt-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                host: {
                    ...HOST,
                    transfer: async (_ctx, _agentId, input, operation) => ({
                        agentId: "agent-a",
                        operationId: operation.operationId,
                        changed: true,
                        state: "transferred" as const,
                        workspace: {
                            id:
                                "targetWorkspaceId" in input
                                    ? input.targetWorkspaceId
                                    : input.workspaceId,
                            projectRef: "project-a",
                            ownerAgentId: "attacker",
                            path: "/attacker/secret",
                        },
                    }),
                },
            });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-transfer-receipt",
                projectRef: "project-a",
                name: "Transfer receipt",
            });

            const transferred = await workspaces.transfer(database.context, "agent-a", {
                targetWorkspaceId: "workspace-transfer-receipt",
            });
            expect(transferred).toMatchObject({
                state: "transferred",
                workspace: {
                    id: "workspace-transfer-receipt",
                    ownerAgentId: "agent-a",
                    path: "/managed/project-a/transfer-receipt",
                },
            });
        } finally {
            database.close();
        }
    });

    it("does not repeat an external archive cleanup for the same durable operation", async () => {
        let cleanupCalls = 0;
        const database = workspaceDatabase("workspaces-archive-replay-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                cleanupContext: database.context,
                host: {
                    ...HOST,
                    archive: async () => {
                        cleanupCalls += 1;
                        throw new Error("cleanup unavailable");
                    },
                },
                onHostError: () => undefined,
            });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-archive-replay",
                projectRef: "project-a",
                name: "Archive replay",
            });

            await workspaces.archive(database.context, "agent-a", "workspace-archive-replay", {
                operationId: "archive-repeat",
            });
            await workspaces.whenCleanupSettles();
            await workspaces.archive(database.context, "agent-a", "workspace-archive-replay", {
                operationId: "archive-repeat",
            });
            await workspaces.whenCleanupSettles();

            expect(cleanupCalls).toBe(1);
        } finally {
            database.close();
        }
    });

    it("keeps the old branch when a host rename fails and reports the host error", async () => {
        const errors: string[] = [];
        const database = workspaceDatabase("workspaces-host-rename-failure-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                host: {
                    ...HOST,
                    renameBranch: async () => {
                        throw new Error("branch is locked");
                    },
                },
                onHostError: (_ctx, workspaceId, operation, message) => {
                    errors.push(`${workspaceId}:${operation}:${message}`);
                },
            });
            await reserve(workspaces, database, {
                id: "workspace-host-rename-failure",
                name: "Original branch",
            });

            const renamed = await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-host-rename-failure",
                name: "New title",
            });
            expect(renamed).toMatchObject({
                name: "New title",
                branch: "worktree/original-branch",
            });
            expect(errors).toEqual(["workspace-host-rename-failure:rename:branch is locked"]);
        } finally {
            database.close();
        }
    });

    it("pages workspace and branch metadata detail with strictly advancing cursors", async () => {
        const database = workspaceDatabase("workspaces-detail-paging-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({
                host: {
                    ...HOST,
                    branchMetadata: async (_ctx, _agentId, workspaceId) => ({
                        workspaceId,
                        branch: "worktree/paged",
                        head: "abcdef123456",
                        upstream: "origin/worktree/paged",
                        ahead: 2,
                        behind: 1,
                        detached: false,
                    }),
                },
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

    it("retains receiver binding for host branch rename and archive methods", async () => {
        const database = workspaceDatabase("workspaces-host-receiver-mutations-edge");
        await database.ready;
        try {
            class ReceiverHost {
                static readonly calls: string[] = [];

                get calls(): string[] {
                    return ReceiverHost.calls;
                }

                pathForStorageKey(_projectRef: string, key: string) {
                    return `/managed/project-a/${key}`;
                }

                isBranchUnavailable() {
                    return false;
                }

                isStorageKeyUnavailable() {
                    return false;
                }

                renameBranch(
                    this: ReceiverHost,
                    _ctx: Context,
                    _agentId: string,
                    request: { previousBranch: string },
                ) {
                    this.calls.push(`rename:${request.previousBranch}`);
                    return Promise.resolve(request.previousBranch);
                }

                archive(
                    this: ReceiverHost,
                    _ctx: Context,
                    _agentId: string,
                    request: { workspaceId: string },
                ) {
                    this.calls.push(`archive:${request.workspaceId}`);
                    return Promise.resolve();
                }
            }
            ReceiverHost.calls.length = 0;
            const host = new ReceiverHost();
            const workspaces = new WorkspacesModule({
                host: host as unknown as WorkspaceHost,
                cleanupContext: database.context,
            });
            await workspaces.reserve(database.context, "agent-a", {
                id: "workspace-host-mutations",
                projectRef: "project-a",
                name: "Original",
            });

            await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-host-mutations",
                name: "Renamed",
            });
            await workspaces.archive(database.context, "agent-a", "workspace-host-mutations");
            await workspaces.whenCleanupSettles();

            expect(ReceiverHost.calls).toEqual([
                "rename:worktree/original",
                "archive:workspace-host-mutations",
            ]);
        } finally {
            database.close();
        }
    });

    it("rebuilds a fresh module instance from the durable catalog", async () => {
        const database = workspaceDatabase("workspaces-restart-edge");
        await database.ready;
        try {
            const first = new WorkspacesModule({ host: HOST });
            const created = await first.reserve(database.context, "agent-a", {
                id: "workspace-restart",
                projectRef: "project-a",
                name: "Restarted",
                baseRef: "origin/main",
            });
            await first.markReady(database.context, "agent-a", {
                workspaceId: created.workspace.id,
            });

            const second = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
                host: {
                    ...HOST,
                    pathForStorageKey: (_projectRef, key) => `/managed/${"p".repeat(300)}/${key}`,
                },
                maxOutputCharacters: 256,
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

    it("requires an injected host for branch metadata and rejects a mismatched identity", async () => {
        const database = workspaceDatabase("workspaces-branch-metadata-edge");
        await database.ready;
        try {
            const noHost = new WorkspacesModule({ host: HOST });
            await reserve(noHost, database, { id: "workspace-no-branch-host" });
            await expect(
                noHost.branchMetadata(database.context, "agent-a", "workspace-no-branch-host"),
            ).rejects.toThrow(/requires an injected host service/i);

            const mismatch = new WorkspacesModule({
                host: {
                    ...HOST,
                    branchMetadata: async () => ({
                        workspaceId: "another-workspace",
                        branch: "worktree/other",
                        ahead: 0,
                        behind: 0,
                        detached: false,
                    }),
                },
            });
            await mismatch.reserve(database.context, "agent-a", {
                id: "workspace-branch-mismatch",
                projectRef: "project-a",
                name: "Branch mismatch",
            });
            await expect(
                mismatch.branchMetadata(database.context, "agent-a", "workspace-branch-mismatch"),
            ).rejects.toThrow(/another workspace/i);
        } finally {
            database.close();
        }
    });

    it("does not expose tools when disabled and keeps direct calls unavailable", async () => {
        const database = workspaceDatabase("workspaces-disabled-edge");
        await database.ready;
        try {
            const workspaces = new WorkspacesModule({ enabled: false, host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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
            const workspaces = new WorkspacesModule({ host: HOST });
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

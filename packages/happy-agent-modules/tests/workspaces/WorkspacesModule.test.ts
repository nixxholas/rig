import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    workspaceMigrations,
    workspaceModuleOptionsSchema,
    workspaceSchema,
    workspaceHostSchema,
    WorkspacesModule,
} from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("WorkspacesModule", () => {
    it("owns its catalog migration and host side effects stay explicit", () => {
        const module = new WorkspacesModule({});

        expect(module.name).toBe("workspaces");
        expect(module.migrations).toEqual(workspaceMigrations);
        expect(Value.Check(workspaceModuleOptionsSchema, {})).toBe(true);
        expect(Value.Check(workspaceModuleOptionsSchema, { store: {} })).toBe(false);
    });

    it("keeps workspace rows runtime-validated", () => {
        expect(
            Value.Check(workspaceSchema, {
                id: "workspace-1",
                ownerAgentId: "agent-1",
                projectRef: "project-1",
                name: "Workspace",
                status: "ready",
                createdAt: 1,
                updatedAt: 1,
            }),
        ).toBe(true);
    });

    it("uses transactional database tools and keeps host transfer non-durable", async () => {
        let identityCount = 0;
        let createdWorkspace:
            | {
                  readonly id: string;
                  readonly ownerAgentId: string;
                  readonly projectRef: string;
                  readonly name: string;
                  readonly status: "ready";
                  readonly createdAt: number;
                  readonly updatedAt: number;
              }
            | undefined;
        const hostOperationIds: string[] = [];
        const workspaces = new WorkspacesModule({
            idFactory: () => `workspace-${++identityCount}`,
            eventIdFactory: () => `event-${identityCount}`,
            clock: () => 123,
            host: {
                branchMetadata: async () => {
                    throw new Error("Branch metadata is not used by this test.");
                },
                transfer: async (_ctx, _agentId, input, operation) => {
                    hostOperationIds.push(operation.operationId);
                    if (createdWorkspace === undefined || !("targetWorkspaceId" in input)) {
                        throw new Error("The test transfer target is unavailable.");
                    }
                    return {
                        ...createdWorkspace,
                        updatedAt: createdWorkspace.updatedAt + 1,
                    };
                },
            },
        });
        const database = moduleDatabase(workspaces.migrations, "workspaces-tool-commit-test");
        await database.ready;

        try {
            const call = (id: string) =>
                ({
                    id,
                    providerCallId: `provider-${id}`,
                    kv: {},
                }) as never;
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<WorkspacesModule["tools"]>[1];
            const [create, list, get, transfer, archive, branchMetadata] = workspaces.tools(
                database.context,
                scope,
            );

            const created = await create!.execute(
                database.context,
                { name: "Durable workspace", projectRef: "project-a" },
                call("call-create"),
            );
            createdWorkspace = created;
            const transferred = await transfer!.execute(
                database.context,
                { targetWorkspaceId: created.id },
                call("call-transfer"),
            );
            const archived = await archive!.execute(
                database.context,
                { workspaceId: created.id },
                call("call-archive"),
            );

            expect(identityCount).toBe(1);
            expect(hostOperationIds).toEqual(["call-transfer"]);
            expect([create!.transactional, archive!.transactional]).toEqual([true, true]);
            expect(transfer!.durable).toBe(false);
            expect([list!.durable, get!.durable, branchMetadata!.durable]).toEqual([
                false,
                false,
                false,
            ]);
        } finally {
            database.close();
        }
    });

    it("drops the obsolete replay tables in a forward migration", async () => {
        const database = moduleDatabase([], "workspaces-drop-replay-test");
        await database.ready;

        try {
            for (const [, migrate] of workspaceMigrations) {
                await migrate(database.context, database.database);
            }
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

    it("delegates optional lifecycle hooks and preserves host paths and transitional statuses", async () => {
        const createCalls: string[] = [];
        const archiveCalls: string[] = [];
        const workspaces = new WorkspacesModule({
            host: {
                create: async (_ctx, agentId, input, operation) => {
                    createCalls.push(`${agentId}:${operation.operationId}`);
                    return {
                        id: input.id,
                        ownerAgentId: input.ownerAgentId,
                        projectRef: input.projectRef ?? "host-project",
                        path: "/tmp/host-workspace",
                        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                        name: input.name,
                        status: "initializing",
                        createdAt: 10,
                        updatedAt: 10,
                    };
                },
                archive: async (_ctx, agentId, input, operation) => {
                    archiveCalls.push(`${agentId}:${operation.operationId}:${input.workspaceId}`);
                    return {
                        id: input.workspaceId,
                        ownerAgentId: agentId,
                        projectRef: "host-project",
                        path: "/tmp/host-workspace",
                        name: "Provisioned workspace",
                        status: "archiving",
                        createdAt: 10,
                        updatedAt: 11,
                    };
                },
            },
        });
        expect(
            Value.Check(workspaceHostSchema, {
                create: async () => undefined,
            }),
        ).toBe(true);
        const database = moduleDatabase(workspaces.migrations, "workspaces-host-lifecycle-test");
        await database.ready;

        try {
            const created = await workspaces.create(database.context, "agent-a", {
                id: "workspace-host",
                operationId: "create-host",
                name: "Provisioned workspace",
            });
            expect(created).toMatchObject({
                id: "workspace-host",
                path: "/tmp/host-workspace",
                status: "initializing",
            });
            expect(createCalls).toEqual(["agent-a:create-host"]);

            const archived = await workspaces.archive(
                database.context,
                "agent-a",
                "workspace-host",
                { operationId: "archive-host" },
            );
            expect(archived).toMatchObject({
                id: "workspace-host",
                path: "/tmp/host-workspace",
                status: "archiving",
            });
            expect(archiveCalls).toEqual(["agent-a:archive-host:workspace-host"]);
            expect(
                (await workspaces.list(database.context, "agent-a")).map((row) => row.id),
            ).toEqual(["workspace-host"]);
            expect(
                await workspaces.list(database.context, "agent-a", { includeArchived: false }),
            ).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("renames workspaces, emits a rename event, and keeps the path across a fresh module", async () => {
        const eventTypes: string[] = [];
        const workspaces = new WorkspacesModule({
            eventIdFactory: () => "event-rename",
            listener: {
                onEventTransactional: async (_ctx, event) => {
                    eventTypes.push(event.type);
                },
            },
        });
        const database = moduleDatabase(workspaces.migrations, "workspaces-rename-test");
        await database.ready;

        try {
            await workspaces.create(database.context, "agent-a", {
                id: "workspace-rename",
                operationId: "create-rename",
                name: "Placeholder",
                path: "/tmp/rename-workspace",
            });
            const renamed = await workspaces.rename(database.context, "agent-a", {
                workspaceId: "workspace-rename",
                operationId: "rename-workspace",
                name: "Actual name",
            });
            expect(renamed).toMatchObject({
                id: "workspace-rename",
                name: "Actual name",
                path: "/tmp/rename-workspace",
            });
            expect(eventTypes).toEqual(["workspace_created", "workspace_renamed"]);

            const fresh = new WorkspacesModule({});
            await expect(
                fresh.get(database.context, "agent-a", "workspace-rename"),
            ).resolves.toMatchObject({
                name: "Actual name",
                path: "/tmp/rename-workspace",
            });
            await expect(
                fresh.transfer(database.context, "agent-a", {
                    workspaceId: "workspace-rename",
                    targetProjectRef: "project-new",
                    operationId: "transfer-project",
                }),
            ).resolves.toMatchObject({
                state: "transferred",
                workspace: {
                    path: "/tmp/rename-workspace",
                },
            });
        } finally {
            database.close();
        }
    });

    it("reviews archive and transfer without requesting Full access", async () => {
        const workspaces = new WorkspacesModule({});
        const database = moduleDatabase(workspaces.migrations, "workspaces-review-test");
        await database.ready;

        try {
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<WorkspacesModule["tools"]>[1];
            const tools = workspaces.tools(database.context, scope);
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
});

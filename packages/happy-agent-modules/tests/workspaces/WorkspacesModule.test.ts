import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    workspaceMigrations,
    workspaceModuleOptionsSchema,
    workspaceSchema,
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
});

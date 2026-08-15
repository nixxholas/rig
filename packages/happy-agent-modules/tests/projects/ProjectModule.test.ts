import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabaseRows,
    type AgentDatabase,
} from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import {
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectMigrations,
    projectModuleOptionsSchema,
    projectRenameInputSchema,
    projectSchema,
    projectSettingsUpdateInputSchema,
    ProjectsModule,
    archiveProjectTool,
    createProjectTool,
    ensureProjectTool,
    renameProjectTool,
    updateProjectSettingsTool,
} from "../../sources/projects/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("ProjectsModule", () => {
    it("owns its catalog migration and does not require an injected store", () => {
        const module = new ProjectsModule({});

        expect(module.name).toBe("projects");
        expect(module.migrations).toEqual(projectMigrations);
        expect(Value.Check(projectModuleOptionsSchema, {})).toBe(true);
        expect(Value.Check(projectModuleOptionsSchema, { store: {} })).toBe(false);
        expect(Value.Check(projectModuleOptionsSchema, { transaction: () => undefined })).toBe(
            false,
        );
    });

    it("keeps project rows runtime-validated", () => {
        expect(
            Value.Check(projectSchema, {
                id: "project-1",
                ownerAgentId: "agent-1",
                repositoryRef: "repo:1",
                name: "Project",
                status: "active",
                createdAt: 1,
                updatedAt: 1,
            }),
        ).toBe(true);
    });

    it("does not accept caller-owned operation identities", () => {
        expect(
            Value.Check(projectCreateInputSchema, {
                repositoryRef: "repo:1",
                name: "Project",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectEnsureInputSchema, {
                repositoryRef: "repo:1",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectRenameInputSchema, {
                projectId: "project-1",
                name: "Renamed",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectSettingsUpdateInputSchema, {
                projectId: "project-1",
                settings: {},
                operationId: "legacy-operation",
            }),
        ).toBe(false);
    });

    it("marks every durable catalog mutation tool transactional", () => {
        const projects = new ProjectsModule({});
        const tools = [
            createProjectTool(projects, "agent-a"),
            ensureProjectTool(projects, "agent-a"),
            renameProjectTool(projects, "agent-a"),
            archiveProjectTool(projects, "agent-a"),
            updateProjectSettingsTool(projects, "agent-a"),
        ];

        expect(tools.every((tool) => tool.durable === true && tool.transactional === true)).toBe(
            true,
        );
    });

    it("uses the context transaction for direct catalog mutations", async () => {
        const database = moduleDatabase([], "projects-tool-commit-test");
        for (const [, migrate] of projectMigrations) {
            await migrate(database.context, database.database);
        }
        let identity = 0;
        const projects = new ProjectsModule({
            idFactory: () => `project-${++identity}`,
            eventIdFactory: () => `event-${identity}`,
            clock: () => 123,
        });

        try {
            const created = await projects.create(
                database.context,
                "agent-a",
                { repositoryRef: "repo:1", name: "Project" },
            );
            await projects.ensure(
                database.context,
                "agent-a",
                { repositoryRef: "repo:1" },
            );
            while (Date.now() <= created.updatedAt) {
                // The store timestamps catalog updates with wall-clock milliseconds.
            }
            await projects.rename(
                database.context,
                "agent-a",
                { projectId: created.id, name: "Renamed" },
            );
            await projects.updateSettings(
                database.context,
                "agent-a",
                { projectId: created.id, settings: { theme: "dark" } },
            );
            await projects.archive(database.context, "agent-a", created.id);

            expect(await projects.get(database.context, "agent-a", created.id)).toMatchObject({
                name: "Renamed",
                status: "archived",
            });
        } finally {
            database.close();
        }
    });

    it("drops the obsolete project replay tables in a new migration", async () => {
        const database = moduleDatabase([], "projects-drop-idempotency-test");
        try {
            for (const [, migrate] of projectMigrations) {
                await migrate(database.context, database.database);
            }
            const tables = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table'
                      AND name IN (
                          'happy_agent_module_project_operation_receipts',
                          'happy_agent_module_project_mutation_proofs'
                      )`,
            );
            expect(tables).toEqual([]);
            expect(projectMigrations.map(([key]) => key)).toEqual([
                "001-projects-catalog",
                "002-drop-project-idempotency-tables",
            ]);
        } finally {
            database.close();
        }
    });
});

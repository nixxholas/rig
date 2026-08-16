import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import {
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectMigrations,
    projectModuleOptionsSchema,
    projectSetAvatarInputSchema,
    projectRenameInputSchema,
    projectSchema,
    projectSettingsUpdateInputSchema,
    ProjectsModule,
    archiveProjectTool,
    clearProjectAvatarTool,
    createProjectTool,
    ensureProjectTool,
    reorderProjectTool,
    renameProjectTool,
    setProjectAvatarTool,
    updateProjectSettingsTool,
    unarchiveProjectTool,
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
                orderKey: "00000000000000000001",
                version: 1,
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
            unarchiveProjectTool(projects, "agent-a"),
            reorderProjectTool(projects, "agent-a"),
            setProjectAvatarTool(projects, "agent-a"),
            clearProjectAvatarTool(projects, "agent-a"),
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
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "repo:1",
                name: "Project",
            });
            await projects.ensure(database.context, "agent-a", { repositoryRef: "repo:1" });
            while (Date.now() <= created.updatedAt) {
                // The store timestamps catalog updates with wall-clock milliseconds.
            }
            await projects.rename(database.context, "agent-a", {
                projectId: created.id,
                name: "Renamed",
            });
            await projects.updateSettings(database.context, "agent-a", {
                projectId: created.id,
                settings: { theme: "dark" },
            });
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
                "003-project-order-version-avatar",
            ]);
        } finally {
            database.close();
        }
    });

    it("restores archived projects through ensure and the explicit unarchive operation", async () => {
        const database = await migratedProjectDatabase("projects-restore-test");
        try {
            const projects = new ProjectsModule({
                idFactory: () => "project-restore",
                eventIdFactory: () => "event-restore",
                clock: () => 1,
            });
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "repo:restore",
                name: "Restore me",
            });
            const archived = await projects.archive(database.context, "agent-a", created.id);
            expect(archived.status).toBe("archived");
            expect(archived.version).toBe(created.version + 1);

            const ensured = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "repo:restore",
            });
            expect(ensured.created).toBe(false);
            expect(ensured.changed).toBe(true);
            expect(ensured.project.status).toBe("active");
            expect(ensured.project.version).toBe(archived.version + 1);

            const archivedAgain = await projects.archive(database.context, "agent-a", created.id);
            const restored = await projects.unarchive(database.context, "agent-a", created.id);
            expect(restored.status).toBe("active");
            expect(restored.version).toBe(archivedAgain.version + 1);
            await expect(
                projects.unarchive(database.context, "agent-a", created.id),
            ).resolves.toEqual(restored);
        } finally {
            database.close();
        }
    });

    it("keeps an independent project order and reorders the main catalog", async () => {
        const database = await migratedProjectDatabase("projects-order-test");
        try {
            let nextId = 0;
            const projects = new ProjectsModule({
                idFactory: () => `project-${++nextId}`,
                eventIdFactory: () => `event-${nextId}`,
                clock: () => 1,
            });
            const first = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "repo:first",
                name: "First",
            });
            const second = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "repo:second",
                name: "Second",
            });
            const third = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "repo:third",
                name: "Third",
            });

            expect(
                (await projects.list(database.context, "agent-a")).map((project) => project.id),
            ).toEqual([first.project.id, second.project.id, third.project.id]);
            await projects.reorder(database.context, "agent-a", {
                afterId: null,
                projectId: third.project.id,
            });
            expect(
                (await projects.list(database.context, "agent-a")).map((project) => project.id),
            ).toEqual([third.project.id, first.project.id, second.project.id]);
            await projects.reorder(database.context, "agent-a", {
                afterId: second.project.id,
                expectedVersion: first.project.version,
                projectId: first.project.id,
            });
            expect(
                (await projects.list(database.context, "agent-a")).map((project) => project.id),
            ).toEqual([third.project.id, second.project.id, first.project.id]);
        } finally {
            database.close();
        }
    });

    it("stores avatar metadata, reads optional host bytes, and clears the avatar", async () => {
        const database = await migratedProjectDatabase("projects-avatar-test");
        try {
            const hash = "a".repeat(64);
            const avatar = {
                hash,
                height: 128,
                mediaType: "image/webp" as const,
                source: "user" as const,
                url: `/project-assets/${hash}`,
                width: 128,
            };
            expect(
                Value.Check(projectSetAvatarInputSchema, {
                    avatar,
                    projectId: "project-avatar",
                }),
            ).toBe(true);
            const projects = new ProjectsModule({
                idFactory: () => "project-avatar",
                eventIdFactory: () => "event-avatar",
                clock: () => 1,
            });
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "repo:avatar",
                name: "Avatar",
            });
            const updated = await projects.setAvatar(database.context, "agent-a", {
                avatar,
                expectedVersion: created.version,
                projectId: created.id,
            });
            expect(updated.avatar).toEqual(avatar);
            await expect(
                projects.avatarAsset(database.context, "agent-a", hash),
            ).resolves.toBeUndefined();

            const readerProjects = new ProjectsModule({
                avatarAssetReader: {
                    read: async (_ctx, _agentId, requestedHash) => ({
                        bytes: Uint8Array.from([1, 2, 3]),
                        hash: requestedHash,
                        mediaType: "image/webp" as const,
                    }),
                },
            });
            await expect(
                readerProjects.avatarAsset(database.context, "agent-a", hash),
            ).resolves.toMatchObject({ hash, mediaType: "image/webp" });
            await expect(
                readerProjects.avatarAsset(database.context, "agent-b", hash),
            ).rejects.toThrow("not authorized");

            const cleared = await projects.clearAvatar(database.context, "agent-a", {
                expectedVersion: updated.version,
                projectId: created.id,
            });
            expect(cleared.avatar).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rejects stale rename and settings writes with expected versions", async () => {
        const database = await migratedProjectDatabase("projects-concurrency-test");
        try {
            const projects = new ProjectsModule({
                idFactory: () => "project-concurrency",
                eventIdFactory: () => "event-concurrency",
                clock: () => 1,
            });
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "repo:concurrency",
                name: "Original",
            });
            const renamed = await projects.rename(database.context, "agent-a", {
                expectedVersion: created.version,
                name: "Renamed",
                projectId: created.id,
            });
            await expect(
                projects.rename(database.context, "agent-a", {
                    expectedVersion: created.version,
                    name: "Stale rename",
                    projectId: created.id,
                }),
            ).rejects.toThrow("changed before it could be renamed");

            const configured = await projects.updateSettings(database.context, "agent-a", {
                expectedVersion: renamed.version,
                projectId: created.id,
                settings: { theme: "dark" },
            });
            expect(configured.changed).toBe(true);
            await expect(
                projects.updateSettings(database.context, "agent-a", {
                    expectedVersion: renamed.version,
                    projectId: created.id,
                    settings: { theme: "light" },
                }),
            ).rejects.toThrow("changed before its settings could be saved");
        } finally {
            database.close();
        }
    });
});

async function migratedProjectDatabase(name: string) {
    const database = moduleDatabase([], name);
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    return database;
}

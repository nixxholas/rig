import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import {
    MAX_PROJECT_ERROR_LENGTH,
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectMigrations,
    projectModuleOptionsSchema,
    projectSetAvatarInputSchema,
    projectRemoteSourceSchema,
    projectRenameInputSchema,
    projectSchema,
    projectSettingsSchema,
    projectSettingsUpdateInputSchema,
    ProjectsModule,
    archiveProjectTool,
    clearProjectAvatarTool,
    createProjectTool,
    ensureProjectTool,
    reorderProjectTool,
    renameProjectTool,
    restoreProjectTool,
    setProjectAvatarTool,
    updateProjectSettingsTool,
} from "../../sources/projects/index.js";
import { writeGuardedProject } from "../../sources/projects/store/projectRecords.js";
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

    it("keeps project rows runtime-validated around the real folder record", () => {
        const record = {
            id: "project-1",
            ownerAgentId: "agent-1",
            repositoryRef: "/tmp/projects/one",
            kind: "regular",
            storageKey: "one",
            name: "Project",
            nameSource: "folder",
            status: "active",
            presence: "present",
            initializationStatus: "ready",
            initializationAttempt: 0,
            worktreeSupport: "unknown",
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            orderKey: "00000000000000000001",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        };

        expect(Value.Check(projectSchema, record)).toBe(true);
        // A project is its folder, so an opaque reference is no longer a project.
        expect(Value.Check(projectSchema, { ...record, repositoryRef: "repo:1" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, storageKey: "Not A Key" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, kind: "worktree" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, initializationStatus: "pending" })).toBe(
            false,
        );
    });

    it("accepts only the bounded workspace compute settings", () => {
        expect(Value.Check(projectSettingsSchema, {})).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, { defaultWorkspaceCompute: { type: "local" } }),
        ).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: { image: "node:22", type: "docker" },
            }),
        ).toBe(true);
        expect(Value.Check(projectSettingsSchema, { theme: "dark" })).toBe(false);
        expect(
            Value.Check(projectSettingsSchema, { defaultWorkspaceCompute: { type: "docker" } }),
        ).toBe(false);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: { image: "node:22", type: "local" },
            }),
        ).toBe(false);
        expect(
            Value.Check(projectSettingsSchema, { defaultWorkspaceCompute: { type: "remote" } }),
        ).toBe(false);
    });

    it("does not accept caller-owned operation identities", () => {
        expect(
            Value.Check(projectCreateInputSchema, {
                repositoryRef: "/tmp/projects/one",
                name: "Project",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectEnsureInputSchema, {
                repositoryRef: "/tmp/projects/one",
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
            restoreProjectTool(projects, "agent-a"),
            reorderProjectTool(projects, "agent-a"),
            setProjectAvatarTool(projects, "agent-a"),
            clearProjectAvatarTool(projects, "agent-a"),
            updateProjectSettingsTool(projects, "agent-a"),
        ];

        expect(tools.every((tool) => tool.durable === true && tool.transactional === true)).toBe(
            true,
        );
    });

    it("reviews archival in Auto mode and discloses the host cleanup it starts", () => {
        const projects = new ProjectsModule({});
        const archive = archiveProjectTool(projects, "agent-a");
        const rename = renameProjectTool(projects, "agent-a");
        const context = { agent: { id: "agent-a" } } as never;

        expect(archive.shouldReviewInAutoMode({ projectId: "project-1" }, context)).toBe(true);
        const disclosure = archive.describeAutoPermissionAction!({ projectId: "project-1" }, context);
        expect(disclosure).toContain("project-1");
        expect(disclosure).toContain("folder");
        expect(disclosure).toContain("worktree");
        // Reviewing archival must not drag the call into Full access.
        expect("shouldRunInFullAccessInAutoMode" in archive).toBe(false);
        expect(rename.shouldReviewInAutoMode({ projectId: "project-1", name: "N" }, context)).toBe(
            false,
        );
    });

    it("uses the context transaction for direct catalog mutations", async () => {
        const database = await migratedProjectDatabase("projects-tool-commit-test");
        let identity = 0;
        const projects = new ProjectsModule({
            idFactory: () => `project-${++identity}`,
            eventIdFactory: () => `event-${identity}`,
            clock: () => 123,
        });

        try {
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/one",
                name: "Project",
            });
            await projects.ensure(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/one",
            });
            while (Date.now() <= created.updatedAt) {
                // The store timestamps catalog updates with wall-clock milliseconds.
            }
            await projects.rename(database.context, "agent-a", {
                projectId: created.id,
                name: "Renamed",
            });
            await projects.updateSettings(database.context, "agent-a", {
                projectId: created.id,
                settings: { defaultWorkspaceCompute: { type: "local" } },
            });
            await projects.archive(database.context, "agent-a", created.id);

            expect(await projects.get(database.context, "agent-a", created.id)).toMatchObject({
                name: "Renamed",
                nameSource: "user",
                status: "archived",
            });
            expect(
                await projects.readSettings(database.context, "agent-a", created.id),
            ).toEqual({ defaultWorkspaceCompute: { type: "local" } });
        } finally {
            database.close();
        }
    });

    it("drops the obsolete project replay tables and rebuilds the catalog as folders", async () => {
        const database = await migratedProjectDatabase("projects-drop-idempotency-test");
        try {
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
                "004-project-folder-record",
            ]);
        } finally {
            database.close();
        }
    });

    it("finds a project by its folder and refuses anything that is not a path", async () => {
        const database = await migratedProjectDatabase("projects-by-path-test");
        try {
            const projects = new ProjectsModule({
                idFactory: () => "project-path",
                eventIdFactory: () => "event-path",
                clock: () => 1,
            });
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/by-path",
                name: "By path",
            });

            expect(
                await projects.getByPath(database.context, "agent-a", "/tmp/projects/by-path"),
            ).toMatchObject({ id: created.id, repositoryRef: "/tmp/projects/by-path" });
            expect(
                await projects.getByPath(database.context, "agent-a", "/tmp/projects/elsewhere"),
            ).toBeUndefined();
            await expect(
                projects.getByPath(database.context, "agent-a", "repo:by-path"),
            ).rejects.toThrow("absolute path");
        } finally {
            database.close();
        }
    });

    it("registers the home directory as the never-initialized home project", async () => {
        const database = await migratedProjectDatabase("projects-home-test");
        try {
            const projects = new ProjectsModule({
                idFactory: () => "project-home",
                eventIdFactory: () => "event-home",
                clock: () => 1,
            });
            const home = await projects.ensure(database.context, "agent-a", {
                kind: "home",
                repositoryRef: "/Users/person",
            });

            expect(home.created).toBe(true);
            expect(home.project).toMatchObject({
                kind: "home",
                name: "Home",
                storageKey: "home",
                initializationStatus: "ready",
                presence: "present",
            });
            // Nothing sets the home directory up, so a refresh is a no-op.
            const refreshed = await projects.refresh(
                database.context,
                "agent-a",
                home.project.id,
            );
            expect(refreshed).toEqual(home.project);
        } finally {
            database.close();
        }
    });

    it("converges on the folder through ensure and restores an archived project", async () => {
        const database = await migratedProjectDatabase("projects-restore-test");
        try {
            let nextId = 0;
            const projects = new ProjectsModule({
                idFactory: () => `project-${++nextId}`,
                eventIdFactory: () => `event-${nextId}`,
                clock: () => 1,
            });
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/restore",
                name: "Restore me",
            });

            const converged = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/restore",
            });
            expect(converged.created).toBe(false);
            expect(converged.changed).toBe(false);
            expect(converged.project.version).toBe(created.version);

            const archived = await projects.archive(database.context, "agent-a", created.id);
            expect(archived.status).toBe("archived");
            expect(archived.version).toBe(created.version + 1);

            const ensured = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/restore",
            });
            expect(ensured.created).toBe(false);
            expect(ensured.changed).toBe(true);
            expect(ensured.project.id).toBe(created.id);
            expect(ensured.project.status).toBe("active");
            expect(ensured.project.version).toBe(archived.version + 1);

            const archivedAgain = await projects.archive(database.context, "agent-a", created.id);
            const restored = await projects.restore(database.context, "agent-a", created.id);
            expect(restored.status).toBe("active");
            expect(restored.version).toBe(archivedAgain.version + 1);
            await expect(
                projects.restore(database.context, "agent-a", created.id),
            ).resolves.toEqual(restored);
        } finally {
            database.close();
        }
    });

    it("lets a remote replace a folder-derived name but never a name a person chose", async () => {
        const database = await migratedProjectDatabase("projects-name-source-test");
        try {
            let nextId = 0;
            const projects = new ProjectsModule({
                idFactory: () => `project-${++nextId}`,
                eventIdFactory: () => `event-${nextId}`,
                clock: () => 1,
            });
            const derived = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/happy-agent",
            });
            expect(derived.project.name).toBe("happy-agent");
            expect(derived.project.nameSource).toBe("folder");

            const adopted = await projects.adoptRemoteName(database.context, "agent-a", {
                name: "Happy Agent",
                projectId: derived.project.id,
            });
            expect(adopted.name).toBe("Happy Agent");
            expect(adopted.nameSource).toBe("remote");

            // A remote name is not a folder name, so the next remote does not win.
            const ignored = await projects.adoptRemoteName(database.context, "agent-a", {
                name: "Something else",
                projectId: derived.project.id,
            });
            expect(ignored).toEqual(adopted);

            const chosen = await projects.rename(database.context, "agent-a", {
                name: "My project",
                projectId: derived.project.id,
            });
            expect(chosen.nameSource).toBe("user");
            const stillChosen = await projects.adoptRemoteName(database.context, "agent-a", {
                name: "Remote name",
                projectId: derived.project.id,
            });
            expect(stillChosen).toEqual(chosen);
        } finally {
            database.close();
        }
    });

    it("walks a project through every initialization transition", async () => {
        const database = await migratedProjectDatabase("projects-initialization-test");
        try {
            let nextId = 0;
            const projects = new ProjectsModule({
                idFactory: () => `project-${++nextId}`,
                eventIdFactory: () => `event-${nextId}`,
                clock: () => 1,
            });
            const cloned = await projects.create(database.context, "agent-a", {
                name: "Cloned",
                remoteSource: { kind: "github", repository: "slopus/happy" },
                repositoryRef: "/tmp/projects/cloned",
                requiredSecretKind: "github",
            });
            expect(cloned).toMatchObject({
                presence: "missing",
                initializationStatus: "initializing",
                initializationAttempt: 0,
            });

            const landed = await projects.markCloneReady(
                database.context,
                "agent-a",
                cloned.id,
            );
            expect(landed.presence).toBe("present");

            const failed = await projects.markInitializationFailed(database.context, "agent-a", {
                error: "The install script exited with status 1.",
                projectId: cloned.id,
            });
            expect(failed).toMatchObject({
                initializationStatus: "failed",
                initializationAttempt: 1,
                initializationError: "The install script exited with status 1.",
            });

            // A failure is only recorded while the project is still initializing.
            expect(
                await projects.markInitializationFailed(database.context, "agent-a", {
                    error: "A second failure.",
                    projectId: cloned.id,
                }),
            ).toEqual(failed);

            const retried = await projects.retryInitialization(
                database.context,
                "agent-a",
                cloned.id,
            );
            expect(retried.initializationStatus).toBe("initializing");
            expect(retried.initializationError).toBeUndefined();

            const ready = await projects.markInitializationReady(
                database.context,
                "agent-a",
                cloned.id,
            );
            expect(ready).toMatchObject({
                initializationStatus: "ready",
                initializationAttempt: 2,
            });
            expect(ready.initializationError).toBeUndefined();
            expect(
                await projects.markCloneReady(database.context, "agent-a", cloned.id),
            ).toEqual(ready);

            const refreshed = await projects.refresh(database.context, "agent-a", cloned.id);
            expect(refreshed).toMatchObject({
                initializationStatus: "initializing",
                initializationAttempt: 3,
            });

            await expect(
                projects.markInitializationFailed(database.context, "agent-a", {
                    error: "e".repeat(MAX_PROJECT_ERROR_LENGTH + 1),
                    projectId: cloned.id,
                }),
            ).rejects.toThrow("initialization failure input is invalid");
        } finally {
            database.close();
        }
    });

    it("writes probes and Git facts only when the observation actually changed", async () => {
        const database = await migratedProjectDatabase("projects-probe-test");
        try {
            let nextId = 0;
            const projects = new ProjectsModule({
                idFactory: () => `project-${++nextId}`,
                eventIdFactory: () => `event-${nextId}`,
                clock: () => 1,
            });
            const created = await projects.create(database.context, "agent-a", {
                name: "Probed",
                repositoryRef: "/tmp/projects/probed",
            });

            // The project already looks like this, so the probe writes nothing.
            const unchanged = await projects.applyProbe(database.context, "agent-a", {
                presence: "present",
                projectId: created.id,
                worktreeSupport: "unknown",
            });
            expect(unchanged).toEqual(created);

            const probed = await projects.applyProbe(database.context, "agent-a", {
                presence: "present",
                projectId: created.id,
                worktreeSupport: "unsupported",
                worktreeUnsupportedReason: "The folder is not a Git repository.",
            });
            expect(probed.version).toBe(created.version + 1);
            expect(probed.worktreeSupport).toBe("unsupported");
            expect(probed.worktreeUnsupportedReason).toBe("The folder is not a Git repository.");
            expect(
                await projects.applyProbe(database.context, "agent-a", {
                    presence: "present",
                    projectId: created.id,
                    worktreeSupport: "unsupported",
                    worktreeUnsupportedReason: "The folder is not a Git repository.",
                }),
            ).toEqual(probed);

            const facts = {
                ahead: 2,
                behind: 1,
                branch: "main",
                detached: false,
                head: "0123456789abcdef",
                upstream: "origin/main",
            } as const;
            const untouched = await projects.applyGitFacts(database.context, "agent-a", {
                git: { ahead: 0, behind: 0, detached: false },
                projectId: created.id,
            });
            expect(untouched).toEqual(probed);

            const withFacts = await projects.applyGitFacts(database.context, "agent-a", {
                git: facts,
                projectId: created.id,
            });
            expect(withFacts.version).toBe(probed.version + 1);
            expect(withFacts).toMatchObject({
                gitAhead: 2,
                gitBehind: 1,
                gitBranch: "main",
                gitDetached: false,
                gitHead: "0123456789abcdef",
                gitUpstream: "origin/main",
            });
            expect(
                await projects.applyGitFacts(database.context, "agent-a", {
                    git: facts,
                    projectId: created.id,
                }),
            ).toEqual(withFacts);

            // The trunk workspaces fork from is decided once.
            const branched = await projects.setDefaultBranch(database.context, "agent-a", {
                branch: "main",
                projectId: created.id,
            });
            expect(branched.defaultBranch).toBe("main");
            expect(
                await projects.setDefaultBranch(database.context, "agent-a", {
                    branch: "develop",
                    projectId: created.id,
                }),
            ).toEqual(branched);

            // An archived project no longer takes host observations.
            const archived = await projects.archive(database.context, "agent-a", created.id);
            expect(
                await projects.applyProbe(database.context, "agent-a", {
                    presence: "missing",
                    projectId: created.id,
                    worktreeSupport: "supported",
                }),
            ).toEqual(archived);
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
                repositoryRef: "/tmp/projects/first",
                name: "First",
            });
            const second = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/second",
                name: "Second",
            });
            const third = await projects.ensure(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/third",
                name: "Third",
            });

            expect(await projectIds(projects, database.context)).toEqual([
                first.project.id,
                second.project.id,
                third.project.id,
            ]);
            await projects.reorder(database.context, "agent-a", {
                afterId: null,
                projectId: third.project.id,
            });
            expect(await projectIds(projects, database.context)).toEqual([
                third.project.id,
                first.project.id,
                second.project.id,
            ]);
            await projects.reorder(database.context, "agent-a", {
                afterId: second.project.id,
                expectedVersion: first.project.version,
                projectId: first.project.id,
            });
            expect(await projectIds(projects, database.context)).toEqual([
                third.project.id,
                second.project.id,
                first.project.id,
            ]);
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
                repositoryRef: "/tmp/projects/avatar",
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
                repositoryRef: "/tmp/projects/concurrency",
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
                settings: { defaultWorkspaceCompute: { image: "node:22", type: "docker" } },
            });
            expect(configured.changed).toBe(true);
            await expect(
                projects.updateSettings(database.context, "agent-a", {
                    expectedVersion: renamed.version,
                    projectId: created.id,
                    settings: { defaultWorkspaceCompute: { type: "local" } },
                }),
            ).rejects.toThrow("changed before its settings could be saved");
        } finally {
            database.close();
        }
    });

    it("ignores every observation that arrives after a project was archived", async () => {
        const events: string[] = [];
        const projects = new ProjectsModule({
            eventIdFactory: () => `event-${String(events.length + 1)}`,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event.type);
                },
            },
        });
        const database = await migratedProjectDatabase("projects-late-observation-test");

        try {
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/late",
                name: "Late",
            });
            const archived = await projects.archive(database.context, "agent-a", created.id);
            const settledEvents = [...events];

            // Setup, probes and refreshes that were already running describe a project nobody has
            // any more. None of them may touch the row, its version, or the log.
            const late = [
                await projects.markCloneReady(database.context, "agent-a", created.id),
                await projects.markInitializationReady(database.context, "agent-a", created.id),
                await projects.markInitializationFailed(database.context, "agent-a", {
                    projectId: created.id,
                    error: "The clone gave up.",
                }),
                await projects.retryInitialization(database.context, "agent-a", created.id),
                await projects.refresh(database.context, "agent-a", created.id),
                await projects.applyProbe(database.context, "agent-a", {
                    projectId: created.id,
                    presence: "missing",
                    worktreeSupport: "unsupported",
                }),
                await projects.applyGitFacts(database.context, "agent-a", {
                    projectId: created.id,
                    git: { ahead: 4, behind: 2, detached: true },
                }),
                await projects.adoptRemoteName(database.context, "agent-a", {
                    projectId: created.id,
                    name: "Named too late",
                }),
            ];

            for (const observed of late) expect(observed).toEqual(archived);
            expect(events).toEqual(settledEvents);
        } finally {
            database.close();
        }
    });

    it("refuses a guarded write that would land on a row something else moved", async () => {
        const projects = new ProjectsModule({});
        const database = await migratedProjectDatabase("projects-guarded-write-test");

        try {
            const created = await projects.create(database.context, "agent-a", {
                repositoryRef: "/tmp/projects/guarded",
                name: "Guarded",
            });

            const rename = async (expectedVersion: number) =>
                await writeGuardedProject(
                    database.database,
                    created.id,
                    expectedVersion,
                    sql`UPDATE happy_agent_module_projects
                        SET name = 'Renamed', updated_at = 2, version = version + 1
                        WHERE id = ${created.id} AND version = ${expectedVersion}
                        RETURNING id`,
                    "The project changed before it could be renamed.",
                );

            // A write decided against a version the row has already left touches nothing, and the
            // caller is told rather than handed a result it did not cause.
            await expect(rename(created.version + 5)).rejects.toThrow(
                "changed before it could be renamed",
            );
            await expect(projects.get(database.context, "agent-a", created.id)).resolves.toEqual(
                created,
            );

            const stored = await rename(created.version);
            expect(stored).toMatchObject({ name: "Renamed", version: created.version + 1 });
        } finally {
            database.close();
        }
    });

    it("does not offer a cursor to a page that has already shown everything", async () => {
        const projects = new ProjectsModule({});
        const database = await migratedProjectDatabase("projects-exact-page-test");

        try {
            for (const folder of ["/tmp/projects/one", "/tmp/projects/two"]) {
                await projects.create(database.context, "agent-a", {
                    repositoryRef: folder,
                    name: folder,
                });
            }

            const exact = await projects.list(database.context, "agent-a", { limit: 2 });
            expect(exact.projects).toHaveLength(2);
            expect(exact.nextCursor).toBeUndefined();
            expect(projects.formatPageForModel(exact)).not.toContain("More projects");

            const partial = await projects.list(database.context, "agent-a", { limit: 1 });
            expect(partial.nextCursor).toBe("1");
        } finally {
            database.close();
        }
    });

    it("accepts only the remote URLs a clone would actually run", () => {
        const remote = (url: string) =>
            Value.Check(projectRemoteSourceSchema, { kind: "git", url });

        expect(remote("https://github.com/acme/retry-policy.git")).toBe(true);
        expect(remote("https://git.example.com:8443/acme/retry-policy.git")).toBe(true);

        // The clone boundary refuses each of these, so a project that recorded one could never
        // finish being set up.
        expect(remote("http://github.com/acme/retry-policy.git")).toBe(false);
        expect(remote("git@github.com:acme/retry-policy.git")).toBe(false);
        expect(remote("ssh://git@github.com/acme/retry-policy.git")).toBe(false);
        expect(remote("file:///tmp/acme/retry-policy")).toBe(false);
        expect(remote("https://token:x@github.com/acme/retry-policy.git")).toBe(false);
        expect(remote("https://")).toBe(false);
        expect(remote(" https://github.com/acme/retry-policy.git")).toBe(false);
    });

    it("refuses text a person could not have typed and folders a host did not normalize", () => {
        const record = {
            id: "project-1",
            ownerAgentId: "agent-1",
            repositoryRef: "/tmp/projects/one",
            kind: "regular",
            storageKey: "one",
            name: "Project",
            nameSource: "folder",
            status: "active",
            presence: "present",
            initializationStatus: "ready",
            initializationAttempt: 0,
            worktreeSupport: "unknown",
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            orderKey: "00000000000000000001",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        };
        expect(Value.Check(projectSchema, record)).toBe(true);

        // Control characters reach a terminal as an escape sequence rather than as text.
        expect(Value.Check(projectSchema, { ...record, name: "Retry\u0007policy" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, name: "Retry\tpolicy" })).toBe(false);

        // A project is one canonical folder, already resolved by the host.
        for (const repositoryRef of [
            "projects/one",
            "/tmp/projects/../one",
            "/tmp/projects/./one",
            "/tmp/projects/one/",
        ]) {
            expect(Value.Check(projectSchema, { ...record, repositoryRef })).toBe(false);
        }
        expect(Value.Check(projectSchema, { ...record, repositoryRef: "C:\\projects\\one" })).toBe(
            true,
        );

        // Git refuses these itself, so a row that holds one describes a branch that cannot exist.
        for (const gitBranch of ["main..old", "main~1", "refs/heads/main.lock", "@{now}"]) {
            expect(Value.Check(projectSchema, { ...record, gitBranch })).toBe(false);
        }
        expect(Value.Check(projectSchema, { ...record, gitBranch: "refs/heads/main" })).toBe(true);
    });
});

async function migratedProjectDatabase(name: string) {
    const database = moduleDatabase([], name);
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    return database;
}

async function projectIds(
    projects: ProjectsModule,
    context: Parameters<ProjectsModule["list"]>[0],
): Promise<readonly string[]> {
    const page = await projects.list(context, "agent-a");
    return page.projects.map((project) => project.id);
}

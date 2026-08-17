import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    MAX_PROJECT_AVATAR_BYTES,
    MAX_PROJECT_REPOSITORY_REF_LENGTH,
    projectByIdInputSchema,
    projectCreateInputSchema,
    projectMigrations,
    projectRemoteSourceSchema,
    projectSchema,
    projectSettingsSchema,
    projectStateChangeReasonSchema,
    ProjectsModule,
    type ProjectAvatar,
} from "../../sources/projects/index.js";
import {
    PROJECTS_TABLE,
    PROJECT_SETTINGS_TABLE,
} from "../../sources/projects/ProjectMigrations.js";
import { readProjectGitFacts } from "../../sources/projects/impl/probeProjectRepository.js";
import { remoteProjectName } from "../../sources/projects/impl/remoteProjectName.js";
import { runProjectGit } from "../../sources/projects/impl/runProjectGit.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("ProjectsModule edge cases", () => {
    it("preserves the documented singleton home-project invariant", async () => {
        const database = await migratedProjectDatabase("projects-home-singleton-edge");
        try {
            const projects = new ProjectsModule({
                idFactory: (() => {
                    let next = 0;
                    return () => `project-home-${++next}`;
                })(),
            });
            await projects.ensure(database.context, "agent-a", {
                kind: "home",
                repositoryRef: "/Users/person",
            });

            await expect(
                projects.ensure(database.context, "agent-a", {
                    kind: "home",
                    repositoryRef: "/Users/another-person",
                }),
            ).rejects.toThrow(/single home project|home project already exists/i);
        } finally {
            database.close();
        }
    });

    it("treats equivalent settings with different object key order as a no-op", async () => {
        const database = await migratedProjectDatabase("projects-settings-order-edge");
        try {
            const projects = new ProjectsModule({ idFactory: () => "project-settings-order" });
            const created = await projects.create(database.context, "agent-a", {
                name: "Settings order",
                repositoryRef: "/tmp/projects/settings-order",
            });
            const first = await projects.updateSettings(database.context, "agent-a", {
                projectId: created.id,
                settings: {
                    defaultWorkspaceCompute: {
                        type: "docker",
                        image: "node:22",
                    },
                },
            });

            const equivalent = await projects.updateSettings(database.context, "agent-a", {
                projectId: created.id,
                settings: {
                    defaultWorkspaceCompute: {
                        image: "node:22",
                        type: "docker",
                    },
                },
            });

            expect(equivalent.changed).toBe(false);
            expect(equivalent.version).toBe(first.version);
            expect(await projects.get(database.context, "agent-a", created.id)).toMatchObject({
                version: first.version,
            });
        } finally {
            database.close();
        }
    });

    it("treats equivalent avatar metadata with different key order as a no-op", async () => {
        const database = await migratedProjectDatabase("projects-avatar-order-edge");
        try {
            const projects = new ProjectsModule({ idFactory: () => "project-avatar-order" });
            const created = await projects.create(database.context, "agent-a", {
                name: "Avatar order",
                repositoryRef: "/tmp/projects/avatar-order",
            });
            const avatar: ProjectAvatar = {
                hash: "a".repeat(64),
                height: 64,
                mediaType: "image/webp",
                source: "user",
                url: "/assets/avatar",
                width: 64,
            };
            const first = await projects.setAvatar(database.context, "agent-a", {
                projectId: created.id,
                avatar,
            });

            const equivalent: ProjectAvatar = {
                width: avatar.width,
                url: avatar.url,
                source: avatar.source,
                mediaType: avatar.mediaType,
                height: avatar.height,
                hash: avatar.hash,
            };
            const second = await projects.setAvatar(database.context, "agent-a", {
                projectId: created.id,
                avatar: equivalent,
            });

            expect(second.version).toBe(first.version);
            expect(second).toEqual(first);
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted boolean values instead of coercing them", async () => {
        const database = await migratedProjectDatabase("projects-malformed-boolean-edge");
        try {
            const projects = new ProjectsModule({ idFactory: () => "project-malformed-boolean" });
            const created = await projects.create(database.context, "agent-a", {
                name: "Malformed boolean",
                repositoryRef: "/tmp/projects/malformed-boolean",
            });
            await agentDatabaseRun(
                database.database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET git_detached = 2
                    WHERE id = ${created.id}`,
            );

            await expect(projects.get(database.context, "agent-a", created.id)).rejects.toThrow(
                /invalid project|storage/i,
            );
        } finally {
            database.close();
        }
    });

    it("keeps a legal maximum-length folder actionable at the minimum output budget", async () => {
        const database = await migratedProjectDatabase("projects-min-output-path-edge");
        try {
            const projects = new ProjectsModule({
                idFactory: () => "project-long-folder",
                maxOutputCharacters: 256,
            });
            const repositoryRef = `/${"x".repeat(MAX_PROJECT_REPOSITORY_REF_LENGTH - 1)}`;
            await projects.create(database.context, "agent-a", {
                name: "Long folder",
                repositoryRef,
            });

            const page = await projects.list(database.context, "agent-a", { limit: 1 });
            expect(page.projects).toHaveLength(1);
            expect(projects.formatPageForModel(page)).toContain("Project ID:");
        } finally {
            database.close();
        }
    });

    it("accepts expected-version guards on archival and restoration inputs", () => {
        expect(Value.Check(projectByIdInputSchema, { projectId: "project-1" })).toBe(true);
        expect(
            Value.Check(projectByIdInputSchema, {
                expectedVersion: 1,
                projectId: "project-1",
            }),
        ).toBe(true);
    });

    it("does not require compute when a resolved remote name cannot apply", async () => {
        const database = await migratedProjectDatabase("projects-remote-name-no-compute-edge");
        try {
            const projects = new ProjectsModule({ idFactory: () => "project-user-name" });
            const created = await projects.create(database.context, "agent-a", {
                name: "Chosen name",
                repositoryRef: "/tmp/projects/user-name",
            });
            const renamed = await projects.rename(database.context, "agent-a", {
                name: "Person chosen",
                projectId: created.id,
            });

            await expect(
                projects.resolveRemoteName(database.context, "agent-a", created.id),
            ).resolves.toEqual(renamed);
        } finally {
            database.close();
        }
    });

    it("publishes one frozen event after the outer transaction commits", async () => {
        const transactional: object[] = [];
        const postCommit: object[] = [];
        const projects = new ProjectsModule({
            idFactory: () => "project-event-boundary",
            eventIdFactory: () => "event-event-boundary",
            clock: () => 123,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                    expect(Object.isFrozen(event)).toBe(true);
                    if ("project" in event) expect(Object.isFrozen(event.project)).toBe(true);
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event);
                },
            },
        });
        const database = await migratedProjectDatabase("projects-event-boundary-edge");
        try {
            const [outerContext, drain] = withAfterCommit(database.context);
            await projects.create(outerContext, "agent-a", {
                name: "Event boundary",
                repositoryRef: "/tmp/projects/event-boundary",
            });
            expect(transactional).toHaveLength(1);
            expect(postCommit).toHaveLength(0);

            await drain();
            expect(postCommit).toHaveLength(1);
            expect(postCommit[0]).toBe(transactional[0]);
        } finally {
            database.close();
        }
    });

    it("rolls back durable state when a transactional listener rejects", async () => {
        const projects = new ProjectsModule({
            idFactory: () => "project-listener-rollback",
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject project mutation");
                },
            },
        });
        const database = await migratedProjectDatabase("projects-listener-rollback-edge");
        try {
            await expect(
                projects.create(database.context, "agent-a", {
                    name: "Rolled back",
                    repositoryRef: "/tmp/projects/listener-rollback",
                }),
            ).rejects.toThrow("reject project mutation");
            await expect(
                projects.get(database.context, "agent-a", "project-listener-rollback"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains hostile post-commit observer failures", async () => {
        const reports: string[] = [];
        const hostile = {
            [Symbol.toPrimitive](): never {
                throw new Error("cannot stringify observer failure");
            },
        };
        const projects = new ProjectsModule({
            idFactory: () => "project-post-commit-hostile",
            listener: {
                onEvent: () => {
                    throw hostile;
                },
            },
            onPostCommitError: (_ctx, _event, message) => {
                reports.push(typeof message === "string" ? message : "not-string");
            },
        });
        const database = await migratedProjectDatabase("projects-post-commit-hostile-edge");
        try {
            await expect(
                projects.create(database.context, "agent-a", {
                    name: "Post commit",
                    repositoryRef: "/tmp/projects/post-commit-hostile",
                }),
            ).resolves.toMatchObject({ id: "project-post-commit-hostile" });
            expect(reports).toEqual(["Unknown project observer error."]);
        } finally {
            database.close();
        }
    });

    it("uses class-backed listeners with their owning receiver", async () => {
        class Listener {
            readonly #seen: string[] = [];

            onEventTransactional(_ctx: Context, event: { readonly type: string }): void {
                this.#seen.push(event.type);
            }

            get seen(): readonly string[] {
                return this.#seen;
            }
        }
        const listener = new Listener();
        const projects = new ProjectsModule({
            idFactory: () => "project-class-listener",
            listener,
        });
        const database = await migratedProjectDatabase("projects-class-listener-edge");
        try {
            await projects.create(database.context, "agent-a", {
                name: "Class listener",
                repositoryRef: "/tmp/projects/class-listener",
            });
            expect(listener.seen).toEqual(["project_created"]);
        } finally {
            database.close();
        }
    });

    it("supports asynchronous identity factories and rejects invalid event identities", async () => {
        const projects = new ProjectsModule({
            idFactory: async () => "project-async-factory",
            eventIdFactory: async () => "event-async-factory",
            clock: () => 123,
        });
        const database = await migratedProjectDatabase("projects-async-factory-edge");
        try {
            const created = await projects.create(database.context, "agent-a", {
                name: "Async factory",
                repositoryRef: "/tmp/projects/async-factory",
            });
            expect(created.id).toBe("project-async-factory");

            const invalid = new ProjectsModule({
                idFactory: () => "project-invalid-event",
                eventIdFactory: async () => "",
            });
            const invalidDatabase = await migratedProjectDatabase("projects-invalid-event-edge");
            try {
                await expect(
                    invalid.create(invalidDatabase.context, "agent-a", {
                        name: "Invalid event",
                        repositoryRef: "/tmp/projects/invalid-event",
                    }),
                ).rejects.toThrow(/event ID factory/);
                await expect(
                    invalid.get(invalidDatabase.context, "agent-a", "project-invalid-event"),
                ).resolves.toBeUndefined();
            } finally {
                invalidDatabase.close();
            }
        } finally {
            database.close();
        }
    });

    it("returns an empty settings object when its companion row is absent", async () => {
        const database = await migratedProjectDatabase("projects-missing-settings-edge");
        try {
            const projects = new ProjectsModule({ idFactory: () => "project-missing-settings" });
            const created = await projects.create(database.context, "agent-a", {
                name: "Missing settings",
                repositoryRef: "/tmp/projects/missing-settings",
            });
            await agentDatabaseRun(
                database.database,
                sql`DELETE FROM ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    WHERE project_id = ${created.id}`,
            );

            await expect(
                projects.readSettings(database.context, "agent-a", created.id),
            ).resolves.toEqual({});
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted settings JSON", async () => {
        const database = await migratedProjectDatabase("projects-malformed-settings-edge");
        try {
            const projects = new ProjectsModule({ idFactory: () => "project-malformed-settings" });
            const created = await projects.create(database.context, "agent-a", {
                name: "Malformed settings",
                repositoryRef: "/tmp/projects/malformed-settings",
            });
            await agentDatabaseRun(
                database.database,
                sql`UPDATE ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    SET settings_json = '{ "not_a_setting": true }'
                    WHERE project_id = ${created.id}`,
            );

            await expect(
                projects.readSettings(database.context, "agent-a", created.id),
            ).rejects.toThrow(/settings/i);
        } finally {
            database.close();
        }
    });

    it("keeps archived rows out of the default list and supports status pages", async () => {
        const database = await migratedProjectDatabase("projects-list-status-edge");
        try {
            let next = 0;
            const projects = new ProjectsModule({
                idFactory: () => `project-list-${++next}`,
            });
            const active = await projects.create(database.context, "agent-a", {
                name: "Active",
                repositoryRef: "/tmp/projects/list-active",
            });
            const archived = await projects.create(database.context, "agent-a", {
                name: "Archived",
                repositoryRef: "/tmp/projects/list-archived",
            });
            await projects.archive(database.context, "agent-a", archived.id);

            await expect(projects.list(database.context, "agent-a")).resolves.toMatchObject({
                projects: [{ id: active.id }],
            });
            await expect(
                projects.list(database.context, "agent-a", { status: "archived" }),
            ).resolves.toMatchObject({
                projects: [{ id: archived.id, status: "archived" }],
            });
            await expect(
                projects.list(database.context, "agent-a", { includeArchived: true }),
            ).resolves.toMatchObject({
                projects: [{ id: active.id }, { id: archived.id }],
            });
        } finally {
            database.close();
        }
    });

    it("survives a fresh module instance over the same database", async () => {
        const database = await migratedProjectDatabase("projects-reload-edge");
        try {
            const first = new ProjectsModule({ idFactory: () => "project-reload" });
            const created = await first.create(database.context, "agent-a", {
                name: "Reloaded",
                repositoryRef: "/tmp/projects/reloaded",
            });
            const second = new ProjectsModule({});
            await expect(second.get(database.context, "agent-a", created.id)).resolves.toEqual(
                created,
            );
            await expect(
                second.readSettings(database.context, "agent-a", created.id),
            ).resolves.toEqual({});
        } finally {
            database.close();
        }
    });

    it("validates bounded public schemas at their dangerous edges", () => {
        expect(
            Value.Check(projectCreateInputSchema, {
                name: "Project",
                repositoryRef: "/tmp/project",
            }),
        ).toBe(true);
        expect(
            Value.Check(projectCreateInputSchema, {
                name: "Project",
                repositoryRef: `/tmp/${"x".repeat(MAX_PROJECT_REPOSITORY_REF_LENGTH)}`,
            }),
        ).toBe(false);
        expect(
            Value.Check(projectSchema, {
                id: "project",
                ownerAgentId: "agent",
                repositoryRef: "/tmp/project",
                kind: "regular",
                storageKey: "project",
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
                avatar: {
                    hash: "a".repeat(64),
                    height: 1,
                    mediaType: "image/webp",
                    source: "user",
                    url: "/avatar",
                    width: 1,
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: {
                    type: "docker",
                    image: `node:${"x".repeat(507)}`,
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: {
                    type: "docker",
                    image: `node:${"x".repeat(508)}`,
                },
            }),
        ).toBe(false);
        expect(MAX_PROJECT_AVATAR_BYTES).toBe(8 * 1024 * 1024);
        expect(
            Value.Check(projectRemoteSourceSchema, {
                kind: "git",
                url: "https://github.com:bad/repo",
            }),
        ).toBe(false);
        expect(Value.Check(projectStateChangeReasonSchema, "probe")).toBe(true);
    });
});

describe("Projects Git helper boundaries", () => {
    it("quotes Git arguments as data and converts timeout to a failure result", async () => {
        const run = vi.fn().mockResolvedValue({
            exitCode: null,
            stderr: "",
            stdout: "ignored",
            timedOut: true,
        });
        const compute = {
            shell: { run },
        } as never;

        const result = await runProjectGit(
            {} as Context,
            compute,
            "/tmp/project",
            ["show", "branch'name"],
            { timeoutMs: 7, maxOutputBytes: 11 },
        );

        expect(result).toEqual({
            code: 124,
            stderr: "Git did not finish in time.",
            stdout: "ignored",
        });
        expect(run).toHaveBeenCalledWith(
            expect.objectContaining({
                command: expect.stringContaining("'branch'\\''name'"),
                cwd: "/tmp/project",
                maxOutputBytes: 11,
                timeoutMs: 7,
            }),
        );
    });

    it("reads branch facts and remote names without inventing missing values", async () => {
        const outputs = new Map<string, string | undefined>([
            ["rev-parse --verify HEAD", "0123456789abcdef"],
            ["symbolic-ref --quiet --short HEAD", "main"],
            ["rev-parse --abbrev-ref --symbolic-full-name @{upstream}", "origin/main"],
            ["rev-list --left-right --count origin/main...HEAD", "2\t3"],
        ]);
        const read = async (args: readonly string[]) => outputs.get(args.join(" "));
        await expect(readProjectGitFacts(read)).resolves.toEqual({
            ahead: 3,
            behind: 2,
            branch: "main",
            detached: false,
            head: "0123456789abcdef",
            upstream: "origin/main",
        });
        expect(remoteProjectName("https://github.com/slopus/happy.git")).toBe("happy");
        expect(remoteProjectName("git@github.com:slopus/happy.git")).toBe("happy");
        expect(remoteProjectName("/tmp/local-repository")).toBeUndefined();
        expect(remoteProjectName("https://github.com/slopus/%E2%98%83.git")).toBe("☃");
    });
});

async function migratedProjectDatabase(name: string) {
    const database = moduleDatabase([], name);
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    return database;
}

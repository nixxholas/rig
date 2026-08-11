import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { execFile as execFileCallback } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import {
    access,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import {
    defineProvider,
    modelOpenaiGpt56Sol,
    type AssistantMessage,
    type InferenceStream,
} from "@slopus/rig-execution";
import { createClient } from "@libsql/client";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { PersistentGlobalEventQueue } from "../../global-event/PersistentGlobalEventQueue.js";
import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { assertCanWritePath } from "../../agent/context/assertCanWritePath.js";
import { isProtectedPath } from "../../permissions/index.js";
import { resolveProtectedPaths } from "../../config/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import type { InMemorySession, InMemorySessionOptions } from "../../session/InMemorySession.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { NativeProcessManager } from "../../processes/index.js";
import type { GitCommandRunner } from "../../git/types.js";
import { RigProfileStore } from "../../profiles/index.js";
import {
    ProjectRegistrationError,
    ProjectRepository,
    type ProjectRepositoryOptions,
} from "../ProjectRepository.js";

const execFile = promisify(execFileCallback);
const TEST_LOCAL_INSTANCE_ID = "alocalprojecttest000000001";
const cleanups: (() => Promise<void>)[] = [];
const testContext = () => createTestRootContext();

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("projects", () => {
    it("drains owned project initialization before closing", async () => {
        const cloneStarted = deferred<void>();
        const releaseClone = deferred<void>();
        const root = await mkdtemp(join(tmpdir(), "rig-project-close-test-"));
        const rootCtx = createTestRootContext();
        const opened = await openSessionDatabase(rootCtx, ":memory:");
        await migrateSessionDatabase(opened.ctx);
        const repository = new ProjectRepository({
            cloneRemote: async () => {
                cloneStarted.resolve();
                await releaseClone.promise;
            },
            database: opened.database,
            homeDirectory: root,
            localInstanceId: TEST_LOCAL_INSTANCE_ID,
            resolveProfile: () => ({
                createdAt: 1,
                email: "steve@example.test",
                id: "aclosingprofile00000000001",
                name: "Steve Korshakov",
                parentInstanceId: TEST_LOCAL_INSTANCE_ID,
                updatedAt: 1,
                version: 1,
            }),
            stateDirectory: join(root, "state"),
        });
        cleanups.push(async () => {
            releaseClone.resolve();
            await repository.close(testContext());
            await opened.database.close(opened.ctx);
            await rm(root, { force: true, recursive: true });
        });

        const profileId = "aclosingprofile00000000001";
        await repository.createRemoteProject(
            testContext(),
            {
                identity: profileId,
                name: "Closing Project",
                source: { kind: "github", repository: "slopus/rig" },
            },
            {
                createdBy: {
                    instanceId: TEST_LOCAL_INSTANCE_ID,
                    profileId,
                },
            },
        );
        await cloneStarted.promise;

        let closed = false;
        const closing = repository.close(testContext()).then(() => {
            closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);

        releaseClone.resolve();
        await closing;
        expect(closed).toBe(true);
    });

    it("creates one managed project immediately while its repository clones in the background", async () => {
        const clones: {
            gitAuthentication?: {
                environment: Readonly<Record<string, string>>;
                loopbackPort: number;
            };
            destination: string;
            gitIdentity: { email: string; name: string };
        }[] = [];
        const fixture = await createFixture({
            durableGlobalEventQueue: true,
            projectClone: async ({ destination, gitAuthentication, gitIdentity }) => {
                clones.push({
                    destination,
                    ...(gitAuthentication === undefined ? {} : { gitAuthentication }),
                    gitIdentity,
                });
                await createRepository(dirname(destination), basename(destination));
            },
        });
        const profile = await createLocalProfile(fixture.store);
        await fixture.store.registerSpecialSecret(testContext(), {
            kind: "github",
            token: "temporary-token",
        });
        const projectId = createId();

        await expect(
            fixture.store.createRemoteProject(testContext(), {
                identity: profile.id,
                name: ".rig",
                secret: { kind: "github" },
                source: { kind: "github", repository: "slopus/rig" },
            }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const created = await fixture.store.createRemoteProject(testContext(), {
            identity: profile.id,
            name: "Managed Repository",
            projectId,
            secret: { kind: "github" },
            source: { kind: "github", repository: "slopus/rig" },
        });

        expect(created).toMatchObject({
            id: projectId,
            initializationStatus: "initializing",
            path: join(await realpath(fixture.home), "Happy", "Projects", "Managed Repository"),
            presence: "missing",
            remoteSource: { kind: "github", repository: "slopus/rig" },
            requiredSecretKind: "github",
        });
        const ready = await waitForProject(
            fixture.store,
            projectId,
            (project) => project.initializationStatus === "ready",
        );
        expect(ready.presence).toBe("present");
        expect(clones).toHaveLength(1);
        expect(clones[0]).toMatchObject({
            destination: join(
                await realpath(fixture.home),
                "Happy",
                "Projects",
                ".rig",
                "clones",
                projectId,
            ),
            gitAuthentication: {
                environment: {
                    GIT_CONFIG_VALUE_1: "https://github.com/slopus/rig.git",
                },
                loopbackPort: expect.any(Number),
            },
            gitIdentity: {
                email: "steve@example.test",
                name: "Steve Korshakov",
            },
        });
        expect(JSON.stringify(clones)).not.toContain("temporary-token");

        await expect(
            fixture.store.createWorkspace(testContext(), projectId, {
                baseRef: "HEAD",
                name: "Unattributed workspace",
            }),
        ).rejects.toThrow("GitHub credentials are unavailable for this workspace creator.");

        const repeated = await fixture.store.createRemoteProject(testContext(), {
            identity: profile.id,
            name: "Managed Repository",
            projectId,
            secret: { kind: "github" },
            source: { kind: "github", repository: "slopus/rig" },
        });
        expect(repeated.id).toBe(projectId);
        expect(clones).toHaveLength(1);
        await expect(
            fixture.store.createRemoteProject(
                testContext(),
                {
                    identity: profile.id,
                    name: "Managed Repository",
                    projectId,
                    secret: { kind: "github" },
                    source: { kind: "github", repository: "slopus/rig" },
                },
                {
                    createdBy: {
                        instanceId: "aanotherinstance0000000001",
                        profileId: profile.id,
                    },
                    githubToken: "other-instance-token",
                },
            ),
        ).rejects.toMatchObject({ code: "project_id_conflict" });
        const workspaceCreator = {
            instanceId: "aworkspacepeer00000000001",
            profileId: "aworkspaceprofile0000000001",
        };
        const workspace = await fixture.store.createWorkspace(
            testContext(),
            projectId,
            {
                baseRef: "HEAD",
                identity: workspaceCreator.profileId,
                name: "Peer-owned workspace",
                secret: { kind: "github" },
            },
            {
                createdBy: workspaceCreator,
                githubToken: "workspace-creator-token",
            },
        );
        expect(workspace?.createdBy).toEqual(workspaceCreator);
        await expect
            .poll(
                async () =>
                    (await fixture.store.getWorkspace(testContext(), projectId, workspace!.id))
                        ?.status,
            )
            .toBe("ready");
        expect(JSON.stringify(await fixture.store.listProjects(testContext()))).not.toContain(
            "temporary-token",
        );
        expect(
            JSON.stringify(await fixture.store.listWorkspaces(testContext(), projectId)),
        ).not.toContain("workspace-creator-token");
        expect(
            JSON.stringify(await fixture.store.globalEventQueue.list(testContext())),
        ).not.toContain("temporary-token");
    });

    it("does not use this Rig's native GitHub secret for another Rig's managed project", async () => {
        let clones = 0;
        const fixture = await createFixture({
            projectClone: async () => {
                clones += 1;
            },
        });
        const profiles = new RigProfileStore({
            database: fixture.store,
            localInstanceId: TEST_LOCAL_INSTANCE_ID,
            publish: () => undefined,
        });
        await profiles.replicate(
            testContext(),
            {
                createdAt: 1,
                email: "steve@example.test",
                id: "asteveprofile",
                name: "Steve Korshakov",
                parentInstanceId: "aremoteinstance000000001",
                updatedAt: 1,
                version: 1,
            },
            "aremoteinstance000000001",
        );
        await fixture.store.registerSpecialSecret(testContext(), {
            kind: "github",
            token: "local-token",
        });
        const request = {
            identity: "asteveprofile",
            name: "Peer Repository",
            secret: { kind: "github" as const },
            source: { kind: "github" as const, repository: "slopus/private" },
        };
        const creator = {
            instanceId: "aremoteinstance000000001",
            profileId: "asteveprofile",
        };
        const project = await fixture.store.createRemoteProject(testContext(), request, {
            createdBy: creator,
        });

        const failed = await waitForProject(
            fixture.store,
            project.id,
            (candidate) => candidate.initializationStatus === "failed",
        );
        expect(failed.createdBy).toEqual({
            instanceId: "aremoteinstance000000001",
            profileId: "asteveprofile",
        });
        expect(failed.initializationError).toContain("GitHub credentials are unavailable");
        expect(clones).toBe(0);
        const repeated = await fixture.store.createRemoteProject(
            testContext(),
            { ...request, projectId: project.id },
            { createdBy: creator },
        );
        expect(repeated).toMatchObject({
            initializationAttempt: failed.initializationAttempt,
            initializationError: failed.initializationError,
            initializationStatus: "failed",
        });
        const session = await fixture.store.create(
            testContext(),
            {
                cwd: project.path,
                identity: creator.profileId,
                projectId: project.id,
            },
            { ownerInstanceId: creator.instanceId, profileId: creator.profileId },
        );
        await fixture.store.refreshSessionGitCredential(
            testContext(),
            session.id,
            creator,
            "peer-refresh-token",
        );
        await expect.poll(() => clones).toBe(1);
    });

    it("does not adopt a different repository that appears during clone recovery", async () => {
        let cloneAttempts = 0;
        const fixture = await createFixture({
            projectClone: async () => {
                cloneAttempts += 1;
                const wrong = await createRepository(
                    join(await realpath(fixture.home), "Happy", "Projects"),
                    "Interrupted clone",
                );
                await git(wrong, [
                    "remote",
                    "add",
                    "origin",
                    "https://github.com/someone/else.git",
                ]);
                throw new Error("Clone stopped after the final folder appeared.");
            },
        });
        const profile = await createLocalProfile(fixture.store);
        await fixture.store.registerSpecialSecret(testContext(), {
            kind: "github",
            token: "temporary-token",
        });
        const request = {
            identity: profile.id,
            name: "Interrupted clone",
            projectId: createId(),
            secret: { kind: "github" as const },
            source: { kind: "github" as const, repository: "slopus/rig" },
        };
        const project = await fixture.store.createRemoteProject(testContext(), request);
        await waitForProject(
            fixture.store,
            project.id,
            (candidate) => candidate.initializationStatus === "failed",
        );

        await fixture.store.createRemoteProject(testContext(), request);
        const retried = await waitForProject(
            fixture.store,
            project.id,
            (candidate) =>
                candidate.initializationStatus === "failed" &&
                candidate.initializationError?.includes("different origin repository") === true,
        );

        expect(retried.initializationError).toContain("different origin repository");
        expect(cloneAttempts).toBe(1);
    });

    it("reconciles concurrent managed project reservations by identity and path", async () => {
        const releaseClone = deferred<void>();
        cleanups.push(async () => releaseClone.resolve());
        const fixture = await createFixture({
            projectClone: async () => await releaseClone.promise,
        });
        const profile = await createLocalProfile(fixture.store);
        const projectId = createId();
        const request = {
            identity: profile.id,
            name: "Concurrent retry",
            projectId,
            source: { kind: "github" as const, repository: "slopus/rig" },
        };

        const repeated = await Promise.all([
            fixture.store.createRemoteProject(testContext(), request),
            fixture.store.createRemoteProject(testContext(), request),
        ]);
        expect(repeated.map((project) => project.id)).toEqual([projectId, projectId]);

        const pathRace = await Promise.allSettled([
            fixture.store.createRemoteProject(testContext(), {
                identity: profile.id,
                name: "Concurrent path",
                projectId: createId(),
                source: request.source,
            }),
            fixture.store.createRemoteProject(testContext(), {
                identity: profile.id,
                name: "Concurrent path",
                projectId: createId(),
                source: request.source,
            }),
        ]);
        expect(pathRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = pathRace.find((result) => result.status === "rejected");
        expect(rejected?.reason).toMatchObject({ code: "project_path_conflict" });
    });

    it("validates every project registration path failure before importing it", async () => {
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (args[0] !== "rev-parse" || args[1] !== "--show-toplevel") {
                    throw new Error("Unexpected Git command.");
                }
                if (cwd.endsWith("inaccessible")) {
                    const error = new Error("fatal: Permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                if (cwd.endsWith("not-git")) throw new Error("fatal: not a git repository");
                if (cwd.endsWith("nested")) return join(cwd, "..");
                return cwd;
            },
        });
        const file = join(fixture.root, "file");
        const inaccessible = join(fixture.root, "inaccessible");
        const notGit = join(fixture.root, "not-git");
        const nested = join(fixture.root, "repository", "nested");
        await Promise.all([
            writeFile(file, "not a directory"),
            mkdir(inaccessible),
            mkdir(notGit),
            mkdir(nested, { recursive: true }),
        ]);

        const expected = [
            [join(fixture.root, "missing"), "path_missing"],
            [file, "not_directory"],
            [inaccessible, "path_inaccessible"],
            [notGit, "not_git_repository"],
            [nested, "not_git_top_level"],
        ] as const;
        for (const [path, code] of expected) {
            await expect(
                fixture.store.registerProject(testContext(), { path }),
            ).rejects.toMatchObject({
                code,
                name: "ProjectRegistrationError",
            } satisfies Partial<ProjectRegistrationError>);
        }
        expect(await fixture.store.listProjects(testContext())).toEqual([]);
    });

    it("registers Git roots and lets remote profiles create attributed workspaces", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const repository = await createRepository(fixture.root, "registered-project");
        const linkedWorktree = join(fixture.root, "linked-worktree");
        await git(repository, ["worktree", "add", "-q", "-b", "linked-worktree", linkedWorktree]);
        const projectId = createId();

        const [first, repeated] = await Promise.all([
            fixture.store.registerProject(testContext(), { path: repository, projectId }),
            fixture.store.registerProject(testContext(), { path: repository, projectId }),
        ]);
        const worktree = await fixture.store.registerProject(testContext(), {
            path: linkedWorktree,
        });

        expect(first).toEqual(repeated);
        expect(first).toMatchObject({ id: projectId });
        expect(first.path).toBe(await realpath(repository));
        expect(worktree.path).toBe(await realpath(linkedWorktree));
        expect(worktree.id).not.toBe(first.id);
        expect(await fixture.store.listProjects(testContext())).toHaveLength(2);
        expect(await fixture.store.listWorkspaces(testContext())).toEqual([]);
        const remoteWorkspace = await fixture.store.createWorkspace(
            testContext(),
            first.id,
            {
                identity: "aremoteprofile000000000001",
                name: "Remote workspace",
            },
            {
                createdBy: {
                    instanceId: "aremoteinstance000000001",
                    profileId: "aremoteprofile000000000001",
                },
            },
        );
        expect(remoteWorkspace).toMatchObject({
            createdBy: {
                instanceId: "aremoteinstance000000001",
                profileId: "aremoteprofile000000000001",
            },
            name: "Remote workspace",
            projectId: first.id,
        });
        expect(await fixture.store.list(testContext())).toEqual([]);
        expect(
            (await fixture.store.globalEventQueue.list(testContext()))?.filter(
                (entry) => entry.event.type === "project_created",
            ),
        ).toHaveLength(2);
    });

    it("answers an ambiguous registration retry with the existing project and restores it once", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const repository = await createRepository(fixture.root, "registered-retry");
        const projectId = createId();
        const created = await fixture.store.registerProject(testContext(), {
            path: repository,
            projectId,
        });
        const archived = await fixture.store.archiveProject(
            testContext(),
            created.id,
            created.version,
        );
        if (archived === undefined) throw new Error("Expected the project to be archived.");

        const restored = await fixture.store.registerProject(testContext(), {
            path: repository,
            projectId,
        });
        const repeated = await fixture.store.registerProject(testContext(), {
            path: repository,
            projectId: createId(),
        });

        expect(restored.archivedAt).toBeUndefined();
        expect(repeated.id).toBe(restored.id);
        expect(repeated.path).toBe(restored.path);
        expect(await fixture.store.listProjects(testContext())).toHaveLength(1);
        const events =
            (await fixture.store.globalEventQueue.list(testContext()))?.map(
                (entry) => entry.event,
            ) ?? [];
        expect(events.filter((event) => event.type === "project_created")).toHaveLength(1);
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    data: { project: expect.objectContaining({ archivedAt: expect.any(Number) }) },
                    type: "project_updated",
                }),
                expect.objectContaining({
                    data: {
                        project: expect.not.objectContaining({ archivedAt: expect.anything() }),
                    },
                    type: "project_updated",
                }),
            ]),
        );
    });

    it("returns typed conflicts and resolves only ready managed workspace paths", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "managed-registration");
        const owner = await fixture.store.registerProject(testContext(), { path: repository });
        const workspace = await fixture.store.createWorkspace(testContext(), owner.id, {
            baseRef: "HEAD",
            name: "Managed Registration",
        });
        if (workspace === undefined) throw new Error("Expected a managed workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            owner.id,
            workspace.id,
            (value) => value.status === "ready",
        );

        await expect(
            fixture.store.registerProject(testContext(), { path: ready.path }),
        ).resolves.toMatchObject({
            id: owner.id,
        });

        const database = createClient({ url: pathToFileURL(fixture.databasePath).href });
        try {
            await database.execute({
                args: [ready.id],
                sql: "UPDATE project_workspaces SET status = 'failed' WHERE id = ?",
            });
        } finally {
            await database.close();
        }
        await expect(
            fixture.store.registerProject(testContext(), { path: ready.path }),
        ).rejects.toMatchObject({
            code: "managed_workspace_unavailable",
            name: "ProjectRegistrationError",
        } satisfies Partial<ProjectRegistrationError>);

        const otherRepository = await createRepository(fixture.root, "conflicting-registration");
        await expect(
            fixture.store.registerProject(testContext(), {
                path: otherRepository,
                projectId: owner.id,
            }),
        ).rejects.toMatchObject({
            code: "project_id_conflict",
            name: "ProjectRegistrationError",
        } satisfies Partial<ProjectRegistrationError>);
        expect(await fixture.store.listProjects(testContext())).toHaveLength(1);
    });

    it("rolls back a project mutation when its durable event cannot be stored", async () => {
        const rootCtx = createTestRootContext();
        const opened = await openSessionDatabase(rootCtx, ":memory:");
        await migrateSessionDatabase(opened.ctx);
        const queue = await PersistentGlobalEventQueue.open(rootCtx, opened.database);
        await opened.client.execute(`
            CREATE TRIGGER reject_project_event
            BEFORE INSERT ON durable_global_events
            BEGIN
                SELECT RAISE(ABORT, 'event insert failed');
            END
        `);
        const repository = new ProjectRepository({
            database: opened.database,
            homeDirectory: "/home",
            onEvent: async (eventCtx, event) => {
                await queue.append(eventCtx, event);
            },
            stateDirectory: "/state",
        });

        try {
            await expect(repository.resolve(testContext(), "/workspace")).rejects.toThrow(
                'insert into "durable_global_events"',
            );
            expect((await opened.client.execute("SELECT * FROM projects")).rows).toEqual([]);
        } finally {
            await repository.close(testContext());
            queue.deactivate();
            await opened.database.close(opened.ctx);
        }
    });

    it("assigns canonical directories immediately and distinguishes nested projects", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const projectDirectory = join(fixture.root, "project");
        const nestedDirectory = join(projectDirectory, "nested");
        const alias = join(fixture.root, "alias");
        await mkdir(nestedDirectory, { recursive: true });
        await symlink(projectDirectory, alias);

        const first = await fixture.store.create(testContext(), { cwd: projectDirectory });
        const second = await fixture.store.create(testContext(), { cwd: alias });
        const nested = await fixture.store.create(testContext(), { cwd: nestedDirectory });

        expect(first.snapshot().projectId!).toBe(second.snapshot().projectId!);
        expect(nested.snapshot().projectId!).not.toBe(first.snapshot().projectId!);
        expect(
            (await fixture.store.listProjects(testContext())).map((project) => project.id),
        ).toEqual([nested.snapshot().projectId!, first.snapshot().projectId!]);
        expect(
            (await fixture.store.list(testContext()))
                .filter((session) => session.projectId === first.snapshot().projectId!)
                .map((session) => session.id),
        ).toEqual([first.id, second.id]);

        const movedProject = await fixture.store.reorderProject(
            testContext(),
            nested.snapshot().projectId!,
            { afterId: first.snapshot().projectId! },
            (await fixture.store.getProject(testContext(), nested.snapshot().projectId!))!.version,
        );
        expect(movedProject).toBeDefined();
        expect(
            (await fixture.store.listProjects(testContext())).map((project) => project.id),
        ).toEqual([first.snapshot().projectId!, nested.snapshot().projectId!]);

        await fixture.store.reorderSession(testContext(), second.id, { afterId: null });
        expect(
            (await fixture.store.list(testContext()))
                .filter((session) => session.projectId === first.snapshot().projectId!)
                .map((session) => session.id),
        ).toEqual([second.id, first.id]);
        expect(
            (await fixture.store.globalEventQueue.list(testContext()))?.map(
                (entry) => entry.event.type,
            ),
        ).toEqual([
            "project_created",
            "session_created",
            "session_created",
            "project_created",
            "session_created",
            "project_updated",
            "session_updated",
        ]);
    });

    it("creates a ready Home project with its built-in visual", async () => {
        const fixture = await createFixture();
        const session = await fixture.store.create(testContext(), { cwd: fixture.home });
        expect(
            await fixture.store.getProject(testContext(), session.snapshot().projectId!),
        ).toMatchObject({
            avatarBuiltin: "home",
            initializationStatus: "ready",
            kind: "home",
            name: "Home",
        });
    });

    it("keeps stale settings saves as conflicts after user project mutations", async () => {
        const fixture = await createFixture();
        const session = await fixture.store.create(testContext(), { cwd: fixture.home });
        const project = (await fixture.store.getProject(
            testContext(),
            session.snapshot().projectId!,
        ))!;
        const renamed = (await fixture.store.renameProject(
            testContext(),
            project.id,
            "Renamed project",
            project.version,
        ))!;

        await expect(
            fixture.store.setProjectSettings(
                testContext(),
                project.id,
                { defaultWorkspaceCompute: { type: "local" } },
                project.version,
            ),
        ).rejects.toThrow("changed before its settings could be saved");

        const configured = (await fixture.store.setProjectSettings(
            testContext(),
            project.id,
            { defaultWorkspaceCompute: { type: "local" } },
            renamed.version,
        ))!;
        await expect(
            fixture.store.setProjectSettings(
                testContext(),
                project.id,
                {
                    defaultWorkspaceCompute: {
                        image: "workspace-dev:latest",
                        type: "docker",
                    },
                },
                renamed.version,
            ),
        ).rejects.toThrow("changed before its settings could be saved");
        expect(await fixture.store.getProject(testContext(), project.id)).toMatchObject({
            settings: { defaultWorkspaceCompute: { generation: 1, type: "local" } },
            version: configured.version,
        });
    });

    it("rejects impossible future versions for settings and archive", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "future-version");
        await mkdir(directory);
        const projectId = (await fixture.store.create(testContext(), { cwd: directory })).snapshot()
            .projectId!;
        const project = (await fixture.store.getProject(testContext(), projectId))!;
        const futureVersion = project.version + 1_000_000;

        await expect(
            fixture.store.setProjectSettings(
                testContext(),
                projectId,
                { defaultWorkspaceCompute: { type: "local" } },
                futureVersion,
            ),
        ).rejects.toThrow("The project changed before its settings could be saved.");
        await expect(
            fixture.store.archiveProject(testContext(), projectId, futureVersion),
        ).rejects.toThrow("The project changed before it could be archived.");
    });

    it("renames after enrichment but rejects a concurrent user mutation", async () => {
        const fixture = await createFixture();
        const session = await fixture.store.create(testContext(), { cwd: fixture.home });
        const project = (await fixture.store.getProject(
            testContext(),
            session.snapshot().projectId!,
        ))!;

        await fixture.store.applyGitFacts(
            testContext(),
            { projectId: project.id },
            {
                ahead: 0,
                behind: 0,
                branch: "main",
                detached: false,
                head: "a".repeat(40),
            },
        );
        expect(
            (await fixture.store.getProject(testContext(), project.id))?.version,
        ).toBeGreaterThan(project.version);

        const renamed = (await fixture.store.renameProject(
            testContext(),
            project.id,
            "Renamed after enrichment",
            project.version,
        ))!;
        expect(renamed.name).toBe("Renamed after enrichment");

        await fixture.store.setProjectSettings(
            testContext(),
            project.id,
            { defaultWorkspaceCompute: { type: "local" } },
            renamed.version,
        );
        await expect(
            fixture.store.renameProject(
                testContext(),
                project.id,
                "Overlapping rename",
                renamed.version,
            ),
        ).rejects.toThrow("The project changed before it could be renamed.");
    });

    it("enriches a Git top-level project from its upstream and repository logo", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "local-folder");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);
        await git(repository, [
            "remote",
            "add",
            "origin",
            "git@github.com:slopus/upstream-name.git",
        ]);
        await sharp({
            create: {
                background: { alpha: 1, b: 90, g: 40, r: 200 },
                channels: 4,
                height: 512,
                width: 512,
            },
        })
            .png()
            .toFile(join(repository, "logo.png"));

        const session = await fixture.store.create(testContext(), { cwd: repository });
        const project = await waitForProject(
            fixture.store,
            session.snapshot().projectId!,
            (value) => value.initializationStatus === "ready",
        );
        expect(project).toMatchObject({
            initializationStatus: "ready",
            name: "upstream-name",
            nameSource: "git_remote",
        });
        expect(project.avatar).toMatchObject({
            height: 256,
            mediaType: "image/webp",
            source: "repository",
            width: 256,
        });
        await expect(
            fixture.store.getProjectAvatar(testContext(), project.avatar!.hash),
        ).resolves.toMatchObject({
            hash: project.avatar!.hash,
            mediaType: "image/webp",
        });
    });

    it("creates a managed Git worktree and archives its attached sessions", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const sourceSession = await fixture.store.create(testContext(), { cwd: repository });
        const workspace = await fixture.store.createWorkspace(
            testContext(),
            sourceSession.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Feature Work",
            },
        );
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/feature-work");
        expect(await git(repository, ["rev-parse", "worktree/feature-work"])).toBe(
            ready.baseCommit,
        );

        const workspaceSession = await fixture.store.create(testContext(), {
            cwd: ready.path,
            workspaceId: ready.id,
        });
        const workspaceFork = await fixture.store.fork(testContext(), workspaceSession.id);
        if (workspaceFork === undefined) throw new Error("Expected a workspace session fork.");
        expect(workspaceSession.snapshot()).toMatchObject({
            projectId: sourceSession.snapshot().projectId!,
            workspaceId: ready.id,
        });

        const archived = await fixture.store.archiveWorkspace(
            testContext(),
            ready.projectId,
            ready.id,
            ready.version,
        );
        expect(archived?.status).toBe("archiving");
        expect(workspaceSession.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect(workspaceFork.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        await expect(
            workspaceSession.submit(testContext(), { text: "Do not run." }),
        ).rejects.toThrow("archived");
        await expect(fixture.store.fork(testContext(), workspaceSession.id)).rejects.toThrow(
            "archived",
        );
        await waitForWorkspace(
            fixture.store,
            ready.projectId,
            ready.id,
            (value) => value.status === "archived",
        );
        await expect(access(ready.path)).rejects.toThrow();
        await mkdir(ready.path, { recursive: true });
        await expect(fixture.store.create(testContext(), { cwd: ready.path })).rejects.toThrow(
            "archived",
        );
    });

    it("transfers the commit, working files, ignored files, and .context with .happyignore", async () => {
        const transfer = await createTransferFixture();
        await writeFile(join(transfer.source.path, "committed.txt"), "committed\n");
        await writeFile(join(transfer.source.path, "tracked-excluded.txt"), "committed overlay\n");
        await git(transfer.source.path, ["add", "committed.txt", "tracked-excluded.txt"]);
        await git(transfer.source.path, ["commit", "-m", "Source commit"]);
        const commit = await git(transfer.source.path, ["rev-parse", "HEAD"]);
        await writeFile(join(transfer.source.path, "dirty.txt"), "dirty\n");
        await writeFile(join(transfer.source.path, "ignored.txt"), "ignored\n");
        await writeFile(join(transfer.source.path, "excluded.txt"), "excluded\n");
        await writeFile(
            join(transfer.source.path, ".happyignore"),
            "excluded.txt\ntracked-excluded.txt\n",
        );
        await rm(join(transfer.source.path, "tracked-excluded.txt"));
        await execFile("mkfifo", [join(transfer.source.path, "runtime.fifo")]);
        await mkdir(join(transfer.source.path, ".context"));
        await writeFile(join(transfer.source.path, ".context", "handoff.md"), "context\n");

        const result = await transfer.fixture.store.transferSession(
            testContext(),
            transfer.session.id,
            {
                targetWorkspaceId: transfer.target.id,
            },
        );

        expect(result).toMatchObject({
            commit,
            session: {
                id: transfer.session.id,
                workspaceId: transfer.target.id,
                cwd: transfer.target.path,
            },
            state: "succeeded",
        });
        const transferEvent = transfer.session.events
            .all()
            .findLast(
                (event) =>
                    event.type === "session_updated" &&
                    event.data.appendedContextMessage !== undefined,
            );
        expect(transferEvent?.type).toBe("session_updated");
        if (transferEvent?.type !== "session_updated") {
            throw new Error("Expected the workspace transfer state event.");
        }
        expect(transferEvent.data.session.snapshot.messages).toEqual([]);
        expect(transferEvent.data.session.snapshot.contextMessages).toBeUndefined();
        expect(transferEvent.data.appendedContextMessage).toMatchObject({
            internal: true,
            role: "system",
        });
        expect(JSON.stringify(transferEvent).length).toBeLessThan(32 * 1_024);
        await expect(readFile(join(transfer.target.path, "committed.txt"), "utf8")).resolves.toBe(
            "committed\n",
        );
        await expect(readFile(join(transfer.target.path, "dirty.txt"), "utf8")).resolves.toBe(
            "dirty\n",
        );
        await expect(readFile(join(transfer.target.path, "ignored.txt"), "utf8")).resolves.toBe(
            "ignored\n",
        );
        await expect(
            readFile(join(transfer.target.path, ".context", "handoff.md"), "utf8"),
        ).resolves.toBe("context\n");
        await expect(access(join(transfer.target.path, "excluded.txt"))).rejects.toThrow();
        await expect(access(join(transfer.target.path, "tracked-excluded.txt"))).rejects.toThrow();
        await expect(access(join(transfer.target.path, "runtime.fifo"))).rejects.toThrow();
        expect(await git(transfer.target.path, ["rev-parse", "HEAD"])).toBe(commit);
    });

    it("rejects a transfer while the session has an active turn", async () => {
        const transfer = await createTransferFixture();
        await transfer.session.submit(testContext(), { text: "Keep this turn busy." });

        await expect(
            transfer.fixture.store.transferSession(testContext(), transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("active response");
    });

    it("executes a requested mid-turn transfer after the turn and shows the notice next turn", async () => {
        const firstStarted = deferred<void>();
        const finishFirst = deferred<void>();
        let response = 0;
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_ctx, _model, _context, options) {
                if (options?.sessionId?.endsWith(":title")) {
                    return transferResponseStream(
                        "<title>Transfer test</title>\n<recap>Transfer test.</recap>",
                    );
                }
                response += 1;
                if (response === 1) {
                    firstStarted.resolve();
                    return transferResponseStream("First turn complete.", finishFirst.promise);
                }
                return transferResponseStream("Second turn complete.");
            },
        });
        const transfer = await createTransferFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
        });
        const run = await transfer.session.submit(testContext(), { text: "Move this session." });
        await firstStarted.promise;
        const workspaceContext = runtimeOptions[0]?.workspaces;
        if (workspaceContext === undefined) throw new Error("Expected workspace tools.");

        await expect(workspaceContext.transfer(transfer.target.id)).resolves.toEqual({
            state: "scheduled",
            targetWorkspaceId: transfer.target.id,
        });
        await expect(workspaceContext.transfer(transfer.target.id)).rejects.toThrow(
            "already has a workspace transfer in progress",
        );
        await expect(
            transfer.fixture.store.create(testContext(), {
                cwd: transfer.target.path,
                workspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("receiving a session transfer");
        expect(transfer.session.workspaceTransferState()).toEqual({
            status: "scheduled",
            targetWorkspaceId: transfer.target.id,
        });
        expect(transfer.session.snapshot()).toMatchObject({
            cwd: transfer.source.path,
            workspaceId: transfer.source.id,
        });
        await writeFile(join(transfer.source.path, "after-request.txt"), "included later\n");
        await expect(access(join(transfer.target.path, "after-request.txt"))).rejects.toThrow();

        finishFirst.resolve();
        await transfer.session.waitForRun(testContext(), run.runId);
        await waitFor(
            () => transfer.session.snapshot(),
            (snapshot) => snapshot.workspaceId === transfer.target.id,
        );
        await expect(
            readFile(join(transfer.target.path, "after-request.txt"), "utf8"),
        ).resolves.toBe("included later\n");

        const next = await transfer.session.submit(testContext(), { text: "Where am I now?" });
        await transfer.session.waitForRun(testContext(), next.runId);
        const nextOptions = runtimeOptions[1];
        expect(nextOptions?.cwd).toBe(transfer.target.path);
        const noticeText = nextOptions?.contextMessages
            ?.flatMap((message) =>
                message.role === "system"
                    ? message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    : [],
            )
            .find((text) => text.includes("<session-transfer-notice>"));
        expect(noticeText).toContain(transfer.target.path);
        expect(noticeText).toContain("working-tree overlay");
        expect(noticeText).toContain("Subagents spawned earlier");
    });

    it("records a durable failure notice when a turn-end transfer fails", async () => {
        const started = deferred<void>();
        const finish = deferred<void>();
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        let failSourceLsTree = true;
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_ctx, _model, _context, options) {
                if (options?.sessionId?.endsWith(":title")) {
                    return transferResponseStream(
                        "<title>Transfer test</title>\n<recap>Transfer test.</recap>",
                    );
                }
                started.resolve();
                return transferResponseStream("Turn complete.", finish.promise);
            },
        });
        const transfer = await createTransferFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
            projectGit: async (cwd, args) => {
                if (failSourceLsTree && cwd.includes("source") && args[0] === "ls-tree") {
                    failSourceLsTree = false;
                    throw new Error("Injected turn-end transfer failure.");
                }
                return git(cwd, args);
            },
        });
        const run = await transfer.session.submit(testContext(), { text: "Move after this turn." });
        await started.promise;
        const workspaceContext = runtimeOptions[0]?.workspaces;
        if (workspaceContext === undefined) throw new Error("Expected workspace tools.");
        await workspaceContext.transfer(transfer.target.id);

        finish.resolve();
        await transfer.session.waitForRun(testContext(), run.runId);
        await waitFor(
            () => transfer.session.workspaceTransferState(),
            (state) => state.status === "failed",
        );
        expect(transfer.session.workspaceTransferState()).toMatchObject({
            errorMessage: "Injected turn-end transfer failure.",
            status: "failed",
        });
        expect(
            transfer.session.events
                .all()
                .some(
                    (event) =>
                        event.type === "run_error" &&
                        event.data.errorMessage.includes("Session transfer failed"),
                ),
        ).toBe(true);

        const next = await transfer.session.submit(testContext(), { text: "Did the move work?" });
        await transfer.session.waitForRun(testContext(), next.runId);
        const failureNotice = transfer.session
            .state()
            .contextMessages?.flatMap((message) =>
                message.role === "system"
                    ? message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    : [],
            )
            .find((text) => text.includes("<session-transfer-failure-notice>"));
        expect(failureNotice).toContain("FAILED");
        expect(failureNotice).toContain(transfer.source.path);
        expect(failureNotice).toContain("Injected turn-end transfer failure.");
    });

    it("restores the target commit clean and keeps the source untouched when applying fails", async () => {
        let failSourceLsTree = false;
        const transfer = await createTransferFixture({
            projectGit: async (cwd, args) => {
                if (failSourceLsTree && cwd.includes("source") && args[0] === "ls-tree") {
                    failSourceLsTree = false;
                    throw new Error("Injected transfer failure.");
                }
                return git(cwd, args);
            },
        });
        const targetCommit = await git(transfer.target.path, ["rev-parse", "HEAD"]);
        await writeFile(join(transfer.target.path, "target-only.txt"), "preserve me\n");
        await writeFile(join(transfer.source.path, "dirty.txt"), "source change\n");
        failSourceLsTree = true;

        await expect(
            transfer.fixture.store.transferSession(testContext(), transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("Injected transfer failure");

        expect(transfer.session.snapshot()).toMatchObject({
            cwd: transfer.source.path,
            workspaceId: transfer.source.id,
        });
        expect(transfer.session.workspaceTransferState()).toMatchObject({
            status: "failed",
            targetWorkspaceId: transfer.target.id,
        });
        expect(await git(transfer.target.path, ["rev-parse", "HEAD"])).toBe(targetCommit);
        await expect(access(join(transfer.target.path, "target-only.txt"))).rejects.toThrow();
        await expect(access(join(transfer.target.path, "dirty.txt"))).rejects.toThrow();
        await expect(readFile(join(transfer.source.path, "dirty.txt"), "utf8")).resolves.toBe(
            "source change\n",
        );
    });

    it("quarantines and names a target workspace when restoring it fails", async () => {
        let applyingFailed = false;
        const transfer = await createTransferFixture({
            projectGit: async (cwd, args) => {
                if (cwd.includes("source") && args[0] === "ls-tree") {
                    applyingFailed = true;
                    throw new Error("Original apply failure.");
                }
                if (applyingFailed && cwd.includes("target") && args[0] === "reset") {
                    throw new Error("Target restore failure.");
                }
                return git(cwd, args);
            },
        });

        await expect(
            transfer.fixture.store.transferSession(testContext(), transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow(
            "workspace 'Transfer Target': Original apply failure. The workspace could not be restored: Target restore failure.",
        );
        expect(transfer.session.workspaceTransferState()).toMatchObject({
            errorMessage: expect.stringContaining("Original apply failure."),
            status: "failed",
            target: "restore_failed",
        });
        expect(
            await transfer.fixture.store.getWorkspace(
                testContext(),
                transfer.target.projectId,
                transfer.target.id,
            ),
        ).toMatchObject({
            error: expect.stringContaining("Target restore failure."),
            status: "failed",
        });
        await expect(
            transfer.fixture.store.create(testContext(), {
                cwd: transfer.target.path,
                workspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("is failed");
    });

    it("rejects a target workspace that already has an attached session", async () => {
        const transfer = await createTransferFixture();
        await transfer.fixture.store.create(testContext(), {
            cwd: transfer.target.path,
            workspaceId: transfer.target.id,
        });

        await expect(
            transfer.fixture.store.transferSession(testContext(), transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("no attached sessions");
        expect(transfer.session.snapshot()).toMatchObject({
            cwd: transfer.source.path,
            workspaceId: transfer.source.id,
        });
    });

    it("accepts a target workspace whose only attached sessions are archived", async () => {
        const transfer = await createTransferFixture();
        const archived = await transfer.fixture.store.create(testContext(), {
            cwd: transfer.target.path,
            workspaceId: transfer.target.id,
        });
        await archived.setArchived(testContext(), true);

        await expect(
            transfer.fixture.store.transferSession(testContext(), transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).resolves.toMatchObject({ state: "succeeded" });
    });

    it("abandons a persisted pending transfer on restart with a failure notice", async () => {
        const started = deferred<void>();
        const neverFinish = deferred<void>();
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_ctx, _model, _context, options) {
                if (options?.sessionId?.endsWith(":title")) {
                    return transferResponseStream(
                        "<title>Transfer test</title>\n<recap>Transfer test.</recap>",
                    );
                }
                started.resolve();
                return transferResponseStream("Still running.", neverFinish.promise);
            },
        });
        const transfer = await createTransferFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
        });
        await transfer.session.submit(testContext(), { text: "Schedule and crash." });
        await started.promise;
        const workspaceContext = runtimeOptions[0]?.workspaces;
        if (workspaceContext === undefined) throw new Error("Expected workspace tools.");
        await workspaceContext.transfer(transfer.target.id);
        await transfer.fixture.store.close(testContext());

        const restarted = await transfer.fixture.restart();
        const restored = await restarted.get(testContext(), transfer.session.id);
        if (restored === undefined) throw new Error("Expected restored session.");
        expect(restored.workspaceTransferState()).toMatchObject({
            errorMessage: expect.stringContaining("local server stopped"),
            status: "failed",
            target: "not_touched",
            targetWorkspaceId: transfer.target.id,
        });
        const failureNotice = restored
            .state()
            .contextMessages?.flatMap((message) =>
                message.role === "system"
                    ? message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    : [],
            )
            .find((text) => text.includes("<session-transfer-failure-notice>"));
        expect(failureNotice).toContain("FAILED");
        expect(failureNotice).toContain(transfer.source.path);
        expect(failureNotice).toContain("local server stopped");
    });

    it("persists an internal move notice for the next turn", async () => {
        const transfer = await createTransferFixture();
        const commit = await git(transfer.source.path, ["rev-parse", "HEAD"]);

        await transfer.fixture.store.transferSession(testContext(), transfer.session.id, {
            targetWorkspaceId: transfer.target.id,
        });

        await transfer.fixture.store.close(testContext());
        const restarted = await transfer.fixture.restart();
        const restored = await restarted.get(testContext(), transfer.session.id);
        if (restored === undefined) throw new Error("Expected the transferred session.");
        const notice = restored
            .state()
            .contextMessages?.findLast(
                (message) =>
                    message.role === "system" &&
                    message.blocks.some(
                        (block) =>
                            block.type === "text" &&
                            block.text.includes("<session-transfer-notice>"),
                    ),
            );
        const noticeText = notice?.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
        expect(notice).toMatchObject({ internal: true, role: "system" });
        expect(noticeText).toContain(transfer.target.path);
        expect(noticeText).toContain(commit);
    });

    it("archives a workspace while an observer writes on its own connection", async () => {
        // Happy sync attaches to a session the moment the store hands it out, and writes through a
        // second connection to the same file. A workspace archival that holds the write lock while
        // it looks up its sessions can never let that write through, so the daemon deadlocks
        // against itself until the busy timeout reports "database is locked".
        let observe = false;
        const observed: string[] = [];
        const fixture = await createFixture({
            onSessionAccess: async (session) => {
                if (!observe) return;
                observed.push(session.id);
                await writeOnSeparateConnection(fixture.databasePath);
            },
        });
        const repository = await createRepository(fixture.root, "observed-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const workspace = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Observed Work",
            },
        );
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");
        const workspaceSession = await fixture.store.create(testContext(), {
            cwd: ready.path,
            workspaceId: ready.id,
        });

        observe = true;
        const archived = await fixture.store.archiveWorkspace(
            testContext(),
            ready.projectId,
            ready.id,
        );

        expect(archived?.status).toBe("archiving");
        expect(observed).toContain(workspaceSession.id);
        expect(workspaceSession.snapshot()).toMatchObject({ archived: true, status: "archived" });
        await waitForWorkspace(
            fixture.store,
            ready.projectId,
            ready.id,
            (value) => value.status === "archived",
        );
    });

    it("runs configured workspace setup commands in order before becoming ready", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "setup-source");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                "setup_commands = [",
                '    "printf first > workspace-setup-order.txt",',
                '    "test \\"$(cat workspace-setup-order.txt)\\" = first && printf -- \\"\\\\nsecond\\\\n\\" >> workspace-setup-order.txt",',
                "]",
                "",
            ].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure workspace setup"]);
        const source = await fixture.store.create(testContext(), { cwd: repository });

        const created = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Configured Setup",
            },
        );
        if (created === undefined) throw new Error("Expected a workspace.");
        const initialized = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (workspace) => workspace.status === "ready" || workspace.status === "failed",
        );

        expect(initialized.status).toBe("ready");
        await expect(
            readFile(join(initialized.path, "workspace-setup-order.txt"), "utf8"),
        ).resolves.toBe("first\nsecond\n");
        expect(
            (
                await fixture.store.create(testContext(), {
                    cwd: initialized.path,
                    workspaceId: initialized.id,
                })
            ).snapshot(),
        ).toMatchObject({
            workspaceId: initialized.id,
        });
    });

    it("replicates configured project files into a workspace and follows root changes", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "sync-source");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                'sync = [".env"]',
                'protected_sync = [".env.production"]',
                'setup_commands = ["cat .env > env-during-setup.txt"]',
                "",
            ].join("\n"),
        );
        await writeFile(join(repository, ".gitignore"), ".env\n.env.production\n");
        await git(repository, ["add", "rig.toml", ".gitignore"]);
        await git(repository, ["commit", "-m", "Configure workspace sync"]);
        // Gitignored files never reach the checkout, so only sync can provide them.
        await writeFile(join(repository, ".env"), "KEY=value\n");
        await writeFile(join(repository, ".env.production"), "SECRET=1\n");
        const source = await fixture.store.create(testContext(), { cwd: repository });

        const created = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Synced Files",
            },
        );
        if (created === undefined) throw new Error("Expected a workspace.");
        const initialized = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (workspace) => workspace.status === "ready" || workspace.status === "failed",
        );

        expect(initialized.status).toBe("ready");
        await expect(readFile(join(initialized.path, ".env"), "utf8")).resolves.toBe("KEY=value\n");
        expect((await lstat(join(initialized.path, ".env"))).isSymbolicLink()).toBe(false);
        await expect(readFile(join(initialized.path, ".env.production"), "utf8")).resolves.toBe(
            "SECRET=1\n",
        );
        await expect(
            readFile(join(initialized.path, "env-during-setup.txt"), "utf8"),
        ).resolves.toBe("KEY=value\n");

        // The protected sync file joins the protected paths a session resolves for this
        // workspace, and the real write boundary refuses to modify it; the unprotected sync file
        // and ordinary workspace files stay writable.
        const protectedPaths = resolveProtectedPaths(initialized.path, []);
        expect(protectedPaths).toContain(".env.production");
        expect(protectedPaths).not.toContain(".env");
        const absoluteProtectedPaths = protectedPaths.map((path) => join(initialized.path, path));
        expect(
            isProtectedPath(join(initialized.path, ".env.production"), absoluteProtectedPaths),
        ).toBe(true);
        await expect(
            assertCanWritePath(
                initialized.path,
                join(initialized.path, ".env.production"),
                "auto",
                absoluteProtectedPaths,
            ),
        ).rejects.toThrow("protected workspace path");
        await expect(
            assertCanWritePath(
                initialized.path,
                join(initialized.path, ".env"),
                "auto",
                absoluteProtectedPaths,
            ),
        ).resolves.toBeUndefined();

        // A change to the root copy reaches the ready workspace. The watch and the replication
        // are best-effort and debounced, so the root write is repeated until it converges.
        const deadline = Date.now() + 15_000;
        let replicated = "";
        while (Date.now() < deadline) {
            await writeFile(join(repository, ".env"), "KEY=changed\n");
            await new Promise((resolveWait) => setTimeout(resolveWait, 500));
            replicated = await readFile(join(initialized.path, ".env"), "utf8");
            if (replicated === "KEY=changed\n") break;
        }
        expect(replicated).toBe("KEY=changed\n");
    });

    it("fails workspace initialization on the first failed setup command", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "failed-setup-source");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                "setup_commands = [",
                '    "printf before > setup-before.txt",',
                '    "printf setup-failed >&2; exit 7",',
                '    "printf after > setup-after.txt",',
                "]",
                "",
            ].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure failing workspace setup"]);
        const source = await fixture.store.create(testContext(), { cwd: repository });

        const created = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Failed Setup",
            },
        );
        if (created === undefined) throw new Error("Expected a workspace.");
        const initialized = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (workspace) => workspace.status === "ready" || workspace.status === "failed",
        );

        expect(initialized).toMatchObject({
            error: expect.stringContaining("setup-failed"),
            status: "failed",
        });
        await expect(readFile(join(initialized.path, "setup-before.txt"), "utf8")).resolves.toBe(
            "before",
        );
        await expect(readFile(join(initialized.path, "setup-after.txt"), "utf8")).rejects.toThrow();
        await expect(
            fixture.store.create(testContext(), {
                cwd: initialized.path,
                workspaceId: initialized.id,
            }),
        ).rejects.toThrow("failed");
    });

    it("serializes same-project Git work without serializing workspace setup", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "parallel-setup-source");
        const releasePath = join(repository, "release-workspace-setup");
        const setupCommand = [
            "printf started > setup-started.txt",
            `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        ].join("; ");
        await writeFile(
            join(repository, "rig.toml"),
            ["[workspace]", `setup_commands = [${JSON.stringify(setupCommand)}]`, ""].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure parallel workspace setup"]);
        const source = await fixture.store.create(testContext(), { cwd: repository });

        const first = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "First Setup",
            },
        );
        if (first === undefined) throw new Error("Expected the first workspace.");
        await waitForPath(join(first.path, "setup-started.txt"));
        const second = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Second Setup",
            },
        );
        if (second === undefined) throw new Error("Expected the second workspace.");
        try {
            await waitForPath(join(second.path, "setup-started.txt"), 1_000);
        } finally {
            await writeFile(releasePath, "release\n");
        }

        await Promise.all([
            waitForWorkspace(
                fixture.store,
                first.projectId,
                first.id,
                (workspace) => workspace.status === "ready",
            ),
            waitForWorkspace(
                fixture.store,
                second.projectId,
                second.id,
                (workspace) => workspace.status === "ready",
            ),
        ]);
    });

    it("bounds recovery setup work while retaining per-project Git serialization", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "bounded-recovery-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const reserved = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
                fixture.store.createWorkspace(testContext(), source.snapshot().projectId!, {
                    baseRef: "HEAD",
                    name: `Recovery ${index + 1}`,
                }),
            ),
        );
        if (reserved.some((workspace) => workspace === undefined)) {
            throw new Error("Expected recovery workspaces.");
        }
        const workspaces = await Promise.all(
            reserved.map(async (workspace) => {
                const value = workspace;
                if (value === undefined) throw new Error("Expected a recovery workspace.");
                return await waitForWorkspace(
                    fixture.store,
                    value.projectId,
                    value.id,
                    (candidate) => candidate.status === "ready",
                );
            }),
        );
        const releasePath = join(fixture.root, "release-recovery-setup");
        const setupCommand = [
            "printf started > recovery-setup-started.txt",
            `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        ].join("; ");
        await Promise.all(
            workspaces.map((workspace) =>
                writeFile(
                    join(workspace.path, "rig.toml"),
                    ["[workspace]", `setup_commands = [${JSON.stringify(setupCommand)}]`, ""].join(
                        "\n",
                    ),
                ),
            ),
        );

        await fixture.store.close(testContext());
        const opened = await openSessionDatabase(createTestRootContext(), fixture.databasePath);
        await opened.client.execute({
            args: [source.snapshot().projectId!],
            sql: "UPDATE project_workspaces SET status = 'initializing' WHERE project_id = ?",
        });
        await opened.database.close(opened.ctx);

        const recovered = await fixture.restart();
        try {
            const markerPaths = workspaces.map((workspace) =>
                join(workspace.path, "recovery-setup-started.txt"),
            );
            const deadline = Date.now() + 10_000;
            let started = 0;
            while (started < 4) {
                started = (
                    await Promise.all(
                        markerPaths.map(async (path) => {
                            try {
                                await access(path);
                                return true;
                            } catch {
                                return false;
                            }
                        }),
                    )
                ).filter(Boolean).length;
                if (Date.now() >= deadline) {
                    throw new Error("Timed out waiting for bounded recovery setup work.");
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 20));
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            const startedBeforeRelease = (
                await Promise.all(
                    markerPaths.map(async (path) => {
                        try {
                            await access(path);
                            return true;
                        } catch {
                            return false;
                        }
                    }),
                )
            ).filter(Boolean).length;
            expect(startedBeforeRelease).toBe(4);

            await writeFile(releasePath, "release\n");
            await Promise.all(
                workspaces.map((workspace) =>
                    waitForWorkspace(
                        recovered,
                        workspace.projectId,
                        workspace.id,
                        (candidate) => candidate.status === "ready",
                    ),
                ),
            );
        } finally {
            await writeFile(releasePath, "release\n");
            await recovered.close(testContext());
        }
    });

    it("reserves an initializing workspace before base preparation finishes and retries it idempotently", async () => {
        const baseResolutionStarted = deferred<void>();
        const releaseBaseResolution = deferred<void>();
        let blockBaseResolution = false;
        const fixture = await createFixture({
            durableGlobalEventQueue: true,
            projectGit: async (cwd, args) => {
                if (
                    blockBaseResolution &&
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    baseResolutionStarted.resolve(undefined);
                    await releaseBaseResolution.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "reserved-before-base");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const projectId = source.snapshot().projectId!;
        const workspaceId = createId();
        blockBaseResolution = true;

        const creating = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Reserved Before Base",
        });
        await baseResolutionStarted.promise;

        try {
            expect(
                await fixture.store.getWorkspace(testContext(), projectId, workspaceId),
            ).toMatchObject({
                id: workspaceId,
                status: "initializing",
            });
            expect(
                (await fixture.store.globalEventQueue.list(testContext()))?.filter(
                    (entry) => entry.event.type === "workspace_created",
                ),
            ).toHaveLength(1);

            const created = await creating;
            expect(created).toMatchObject({ id: workspaceId, status: "initializing" });
            await expect(
                fixture.store.createWorkspace(testContext(), projectId, {
                    baseRef: "HEAD",
                    id: workspaceId,
                    name: "Reserved Before Base",
                }),
            ).resolves.toMatchObject({ id: workspaceId, status: "initializing" });
            expect(await fixture.store.listWorkspaces(testContext(), projectId)).toHaveLength(1);
        } finally {
            releaseBaseResolution.resolve(undefined);
        }

        await expect(
            waitForWorkspace(
                fixture.store,
                projectId,
                workspaceId,
                (workspace) => workspace.status === "ready",
            ),
        ).resolves.toMatchObject({ status: "ready" });
    });

    it("keeps a reservation and marks it failed when delayed base preparation fails", async () => {
        const baseResolutionStarted = deferred<void>();
        const failBaseResolution = deferred<void>();
        let blockBaseResolution = false;
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (
                    blockBaseResolution &&
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    baseResolutionStarted.resolve(undefined);
                    await failBaseResolution.promise;
                    throw new Error("Injected base preparation failure.");
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "reserved-base-failure");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const projectId = source.snapshot().projectId!;
        const workspaceId = createId();
        blockBaseResolution = true;

        const creating = fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Reserved Base Failure",
        });
        await baseResolutionStarted.promise;

        try {
            expect(
                await fixture.store.getWorkspace(testContext(), projectId, workspaceId),
            ).toMatchObject({
                id: workspaceId,
                status: "initializing",
            });
            await expect(creating).resolves.toMatchObject({
                id: workspaceId,
                status: "initializing",
            });
        } finally {
            failBaseResolution.resolve(undefined);
        }

        await expect(
            waitForWorkspace(
                fixture.store,
                projectId,
                workspaceId,
                (workspace) => workspace.status === "failed",
            ),
        ).resolves.toMatchObject({
            error: expect.stringContaining('The workspace base "HEAD" did not resolve'),
            status: "failed",
        });
    });

    it("versions and publishes resolved initialization facts before materialization", async () => {
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const fixture = await createFixture({
            durableGlobalEventQueue: true,
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve(undefined);
                    await releaseWorktreeAdd.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "versioned-initialization");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const workspace = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Versioned Initialization",
            },
        );
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await worktreeAddStarted.promise;

        try {
            const recorded = await fixture.store.getWorkspace(
                testContext(),
                workspace.projectId,
                workspace.id,
            );
            expect(recorded).toMatchObject({
                baseCommit: expect.any(String),
                baseRef: "HEAD",
                gitCommonDir: expect.any(String),
                id: workspace.id,
                status: "initializing",
                version: workspace.version + 1,
            });
            const initializationUpdates =
                (await fixture.store.globalEventQueue.list(testContext()))?.flatMap((entry) => {
                    if (
                        entry.event.type !== "workspace_updated" ||
                        !("workspace" in entry.event.data)
                    ) {
                        return [];
                    }
                    const eventWorkspace = entry.event.data.workspace;
                    return eventWorkspace.id === workspace.id &&
                        eventWorkspace.status === "initializing"
                        ? [eventWorkspace]
                        : [];
                }) ?? [];
            expect(initializationUpdates.at(-1)?.version).toBe(workspace.version + 1);
        } finally {
            releaseWorktreeAdd.resolve(undefined);
        }

        await expect(
            waitForWorkspace(
                fixture.store,
                workspace.projectId,
                workspace.id,
                (value) => value.status === "ready",
            ),
        ).resolves.toMatchObject({ version: workspace.version + 2 });
    });

    it("serializes initialization Git work within one project while other projects continue", async () => {
        const firstBaseResolutionStarted = deferred<void>();
        const otherBaseResolutionStarted = deferred<void>();
        const releaseFirstBaseResolution = deferred<void>();
        let serializedRepositoryName: string | undefined;
        let baseResolutions = 0;
        let otherBaseResolutions = 0;
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    if (basename(cwd) === serializedRepositoryName) {
                        baseResolutions += 1;
                        if (baseResolutions === 1) {
                            firstBaseResolutionStarted.resolve(undefined);
                            await releaseFirstBaseResolution.promise;
                        }
                    } else {
                        otherBaseResolutions += 1;
                        otherBaseResolutionStarted.resolve(undefined);
                    }
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "serialized-initialization");
        serializedRepositoryName = basename(repository);
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const first = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "First",
            },
        );
        if (first === undefined) throw new Error("Expected the first workspace.");
        await firstBaseResolutionStarted.promise;
        const second = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Second",
            },
        );
        if (second === undefined) throw new Error("Expected the second workspace.");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(baseResolutions).toBe(1);

        const otherRepository = await createRepository(fixture.root, "parallel-initialization");
        const otherSource = await fixture.store.create(testContext(), { cwd: otherRepository });
        const other = await fixture.store.createWorkspace(
            testContext(),
            otherSource.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Other Project",
            },
        );
        if (other === undefined) throw new Error("Expected the other workspace.");
        const startedInParallel = await Promise.race([
            otherBaseResolutionStarted.promise.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        releaseFirstBaseResolution.resolve(undefined);
        expect(startedInParallel).toBe(true);
        expect(otherBaseResolutions).toBe(1);
        const initialized = await Promise.all([
            waitForWorkspace(
                fixture.store,
                first.projectId,
                first.id,
                (value) => value.status === "ready" || value.status === "failed",
            ),
            waitForWorkspace(
                fixture.store,
                second.projectId,
                second.id,
                (value) => value.status === "ready" || value.status === "failed",
            ),
            waitForWorkspace(
                fixture.store,
                other.projectId,
                other.id,
                (value) => value.status === "ready" || value.status === "failed",
            ),
        ]);
        expect(initialized.map((workspace) => workspace.status)).toEqual([
            "ready",
            "ready",
            "ready",
        ]);
        expect(baseResolutions).toBe(2);
    });

    it("starts every waiting session automatically and preserves each session's submission order", async () => {
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        const submissionOrder: string[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_ctx, _model, context, options) {
                if (!options?.sessionId?.endsWith(":title")) {
                    const message = context.messages.findLast(
                        (candidate) => candidate.role === "user",
                    );
                    const text =
                        message?.role === "user" && Array.isArray(message.content)
                            ? message.content
                                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                                  .join("\n")
                            : "";
                    submissionOrder.push(text);
                }
                return transferResponseStream("Completed.");
            },
        });
        const fixture = await createFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve();
                    await releaseWorktreeAdd.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "waiting-sessions");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const workspace = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            name: "Waiting Sessions",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await worktreeAddStarted.promise;

        const first = await fixture.store.create(testContext(), {
            cwd: workspace.path,
            workspaceId: workspace.id,
        });
        const second = await fixture.store.create(testContext(), {
            cwd: workspace.path,
            workspaceId: workspace.id,
        });
        const equivalentPath = await fixture.store.create(testContext(), {
            cwd: `${workspace.path}/.`,
            workspaceId: workspace.id,
        });
        const firstRun = await first.submit(testContext(), { text: "First submission." });
        const secondRun = await first.submit(testContext(), { text: "Second submission." });
        const otherRun = await second.submit(testContext(), { text: "Other session." });
        const equivalentPathRun = await equivalentPath.submit(testContext(), {
            text: "Equivalent path.",
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(runtimeOptions).toEqual([]);
        expect(first.state().queuedRuns).toHaveLength(2);
        expect(second.state().queuedRuns).toHaveLength(1);

        releaseWorktreeAdd.resolve();
        await Promise.all([
            first.waitForRun(testContext(), firstRun.runId),
            first.waitForRun(testContext(), secondRun.runId),
            second.waitForRun(testContext(), otherRun.runId),
            equivalentPath.waitForRun(testContext(), equivalentPathRun.runId),
        ]);

        expect(submissionOrder).toEqual(
            expect.arrayContaining([
                "First submission.",
                "Second submission.",
                "Other session.",
                "Equivalent path.",
            ]),
        );
        expect(submissionOrder.indexOf("First submission.")).toBeLessThan(
            submissionOrder.indexOf("Second submission."),
        );
        expect(runtimeOptions).toHaveLength(3);
    });

    it("fails a waiting run durably without removing its session or user message", async () => {
        const baseResolutionStarted = deferred<void>();
        const failBaseResolution = deferred<void>();
        let runtimes = 0;
        const fixture = await createFixture({
            createRuntime: () => {
                runtimes += 1;
                throw new Error("A failed workspace must not create a runtime.");
            },
            projectGit: async (cwd, args) => {
                if (
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    baseResolutionStarted.resolve();
                    await failBaseResolution.promise;
                    throw new Error("Injected unavailable base.");
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "waiting-failure");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const workspace = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            name: "Waiting Failure",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await baseResolutionStarted.promise;
        const session = await fixture.store.create(testContext(), {
            cwd: workspace.path,
            workspaceId: workspace.id,
        });
        const submitted = await session.submit(testContext(), {
            clientSubmissionId: "waiting-failure-message",
            debug: true,
            text: "Keep this message.",
        });

        failBaseResolution.resolve();
        await session.waitForRun(testContext(), submitted.runId);

        expect(await fixture.store.get(testContext(), session.id)).toBe(session);
        expect(session.state().queuedRuns).toEqual([]);
        expect(session.state().messages).toMatchObject([
            { message: { id: "waiting-failure-message", role: "user" } },
        ]);
        expect(
            session.events
                .since(undefined)
                ?.find(
                    (event) => event.type === "run_error" && event.data.runId === submitted.runId,
                ),
        ).toMatchObject({
            data: { errorMessage: expect.stringContaining("workspace initialization failed") },
            type: "run_error",
        });
        await expect(access(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(runtimes).toBe(0);
    });

    it("resumes a waiting workspace run after daemon restart", async () => {
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const worktreeAddFinished = deferred<void>();
        const providerRuns: string[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_ctx, _model, context, options) {
                if (!options?.sessionId?.endsWith(":title")) {
                    const message = context.messages.findLast(
                        (candidate) => candidate.role === "user",
                    );
                    if (message?.role === "user" && Array.isArray(message.content)) {
                        providerRuns.push(
                            message.content
                                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                                .join("\n"),
                        );
                    }
                }
                return transferResponseStream("Recovered.");
            },
        });
        let blockFirstAdd = true;
        const fixture = await createFixture({
            createRuntime: (options) => createTransferTestRuntime(options, provider),
            projectGit: async (cwd, args) => {
                if (blockFirstAdd && args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve();
                    await releaseWorktreeAdd.promise;
                    try {
                        return await git(cwd, args);
                    } finally {
                        blockFirstAdd = false;
                        worktreeAddFinished.resolve();
                    }
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "waiting-restart");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const workspace = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            name: "Waiting Restart",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await worktreeAddStarted.promise;
        const session = await fixture.store.create(testContext(), {
            cwd: workspace.path,
            workspaceId: workspace.id,
        });
        const submitted = await session.submit(testContext(), {
            clientSubmissionId: "waiting-restart-message",
            text: "Resume after restart.",
        });
        const closing = fixture.store.close(testContext());
        releaseWorktreeAdd.resolve();
        await worktreeAddFinished.promise;
        await closing;

        const restarted = await fixture.restart();
        const restored = await restarted.get(testContext(), session.id);
        if (restored === undefined) throw new Error("Expected the waiting session.");
        await restored.waitForRun(testContext(), submitted.runId);

        expect(providerRuns).toEqual(["Resume after restart."]);
        expect(restored.state().messages).toMatchObject([
            { message: { id: "waiting-restart-message", role: "user" } },
            { message: { role: "agent" } },
        ]);
        expect(restored.state().interruption).toBeUndefined();
    });

    it("skips workspace storage keys already occupied on disk or in packed Git refs", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "collision-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const project = await fixture.store.getProject(testContext(), source.snapshot().projectId!);
        if (project === undefined) throw new Error("Expected a project.");
        await mkdir(join(fixture.state, "workspaces", project.storageKey, "workspace"), {
            recursive: true,
        });
        await git(repository, ["branch", "worktree/workspace-2"]);
        await git(repository, ["pack-refs", "--all", "--prune"]);

        const created = await fixture.store.createWorkspace(testContext(), project.id, {
            baseRef: "HEAD",
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            project.id,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );

        expect(ready).toMatchObject({
            status: "ready",
            storageKey: "workspace-3",
        });
        // The folder and the branch avoid collisions separately: the occupied folder and the
        // packed `worktree/workspace-2` ref move the storage key on, while the branch the
        // workspace name asks for is free.
        expect(ready.branch).toBe("worktree/workspace");
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/workspace");
        expect(
            (await fixture.store.create(testContext(), { cwd: ready.path })).snapshot(),
        ).toMatchObject({
            projectId: project.id,
            workspaceId: ready.id,
        });
    });

    it("finds packed workspace branches through a linked worktree gitdir", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "linked-collision-source");
        const linkedWorktree = join(fixture.root, "linked-collision-worktree");
        await git(repository, [
            "worktree",
            "add",
            "-q",
            "-b",
            "linked-collision-worktree",
            linkedWorktree,
        ]);
        await git(repository, ["branch", "worktree/workspace"]);
        await git(repository, ["pack-refs", "--all", "--prune"]);

        const source = await fixture.store.create(testContext(), { cwd: linkedWorktree });
        const project = await fixture.store.getProject(testContext(), source.snapshot().projectId!);
        if (project === undefined) throw new Error("Expected a project.");
        const created = await fixture.store.createWorkspace(testContext(), project.id, {
            baseRef: "HEAD",
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            project.id,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );

        expect(ready).toMatchObject({
            status: "ready",
            storageKey: "workspace-2",
        });
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/workspace-2");
    });

    it("keeps human-readable workspace keys when packed refs exceed 256 KiB", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "large-packed-refs-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const project = await fixture.store.getProject(testContext(), source.snapshot().projectId!);
        if (project === undefined) throw new Error("Expected a project.");
        const commit = await git(repository, ["rev-parse", "HEAD"]);
        const packedRefs = [
            `${commit} refs/heads/worktree/workspace`,
            ...Array.from(
                { length: 5_000 },
                (_value, index) =>
                    `${commit} refs/heads/generated/ref-${String(index).padStart(5, "0")}`,
            ),
        ].join("\n");
        await writeFile(join(repository, ".git", "packed-refs"), `${packedRefs}\n`);
        const id = createId();

        const created = await fixture.store.createWorkspace(testContext(), project.id, {
            baseRef: "HEAD",
            id,
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        expect(created).toMatchObject({
            id,
            status: "initializing",
            storageKey: "workspace-2",
        });

        const ready = await waitForWorkspace(
            fixture.store,
            project.id,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");
    });

    it("uses a collision-safe identity when Git metadata cannot be inspected", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "unreadable-git-metadata");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const projectId = source.snapshot().projectId!;
        const realGitDirectory = join(repository, ".git-real");
        await rename(join(repository, ".git"), realGitDirectory);
        await writeFile(join(repository, ".git"), "not-a-gitdir\n");
        const id = createId();

        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            id,
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        expect(created.storageKey).toBe(`workspace-${id}`);

        // Restore the repository without yielding to the setImmediate initialization callback.
        // An asynchronous rm followed by rename lets Linux begin initialization between them.
        rmSync(join(repository, ".git"), { force: true });
        renameSync(realGitDirectory, join(repository, ".git"));
        await expect(
            waitForWorkspace(
                fixture.store,
                projectId,
                id,
                (workspace) => workspace.status === "ready" || workspace.status === "failed",
            ),
        ).resolves.toMatchObject({ status: "ready" });
    });

    it("keeps archival committed when physical workspace cleanup fails", async () => {
        let failRemoval = false;
        const cleanupErrors: unknown[] = [];
        const fixture = await createFixture({
            onWorkspaceCleanupError: (error) => cleanupErrors.push(error),
            projectGit: async (cwd, args) => {
                if (failRemoval && args[0] === "worktree" && args[1] === "remove") {
                    throw new Error("Injected worktree cleanup failure.");
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "cleanup-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const created = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Cleanup Failure",
            },
        );
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (value) => value.status === "ready",
        );

        failRemoval = true;
        const response = await fixture.store.archiveWorkspace(
            testContext(),
            ready.projectId,
            ready.id,
            ready.version,
        );
        expect(response?.status).toBe("archiving");
        const archived = await waitForWorkspace(
            fixture.store,
            ready.projectId,
            ready.id,
            (value) => value.status === "archived",
        );

        expect(archived).not.toHaveProperty("error");
        expect(cleanupErrors).toHaveLength(1);
        await expect(access(ready.path)).resolves.toBeUndefined();
    });

    it("refuses cleanup after a managed workspace ancestor is replaced by a symlink", async () => {
        const cleanupErrors: unknown[] = [];
        const workspacesDirectory = await mkdtemp(join(tmpdir(), "rig-managed-workspaces-test-"));
        cleanups.push(() => rm(workspacesDirectory, { force: true, recursive: true }));
        const fixture = await createFixture({
            onWorkspaceCleanupError: (error) => cleanupErrors.push(error),
            workspacesDirectory,
        });
        const repository = await createRepository(fixture.root, "symlink-cleanup-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const created = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Protected Cleanup",
            },
        );
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (value) => value.status === "ready",
        );
        const project = await fixture.store.getProject(testContext(), created.projectId);
        if (project === undefined) throw new Error("Expected a project.");

        await Promise.all([
            rm(repository, { force: true, recursive: true }),
            rm(workspacesDirectory, { force: true, recursive: true }),
        ]);
        const substitutedRoot = join(fixture.root, "substituted-workspaces");
        const substitutedWorkspace = join(
            substitutedRoot,
            project.storageKey,
            workspace.storageKey,
        );
        const protectedFile = join(substitutedWorkspace, "must-survive.txt");
        await mkdir(substitutedWorkspace, { recursive: true });
        await writeFile(protectedFile, "not managed by Rig\n");
        await symlink(substitutedRoot, workspacesDirectory);

        await fixture.store.archiveWorkspace(
            testContext(),
            workspace.projectId,
            workspace.id,
            workspace.version,
        );
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archived",
        );

        await expect(readFile(protectedFile, "utf8")).resolves.toBe("not managed by Rig\n");
        expect(cleanupErrors.map(String)).toContain(
            "Error: The workspace path does not match its managed storage identity.",
        );
    });

    it("stops instead of reporting cleanup when workspace archival hits the database", async () => {
        const databaseError = await captureDriverError();
        let failRemoval = false;
        const cleanupErrors: unknown[] = [];
        const fixture = await createFixture({
            onWorkspaceCleanupError: (error) => cleanupErrors.push(error),
            projectGit: async (cwd, args) => {
                if (failRemoval && args[0] === "worktree" && args[1] === "remove") {
                    throw databaseError;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "database-failure-source");
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const created = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Database Failure",
            },
        );
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (value) => value.status === "ready",
        );

        failRemoval = true;
        const escaped = await captureUnhandledRejection(async () => {
            await fixture.store.archiveWorkspace(
                testContext(),
                ready.projectId,
                ready.id,
                ready.version,
            );
        });

        // Residue left on disk is worth a warning because the next attempt can still remove it.
        // A database that cannot answer is neither reportable nor retryable.
        expect(escaped).toBe(databaseError);
        expect(cleanupErrors).toEqual([]);
    });

    it("reconciles interrupted workspace creation and archival after restart", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await writeFile(
            join(repository, "rig.toml"),
            '[workspace]\nsetup_commands = ["printf recovered > workspace-setup-recovered.txt"]\n',
        );
        await git(repository, ["add", "README.md", "rig.toml"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const source = await fixture.store.create(testContext(), { cwd: repository });
        const first = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Recovered Create",
            },
        );
        const second = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Recovered Archive",
            },
        );
        if (first === undefined || second === undefined) {
            throw new Error("Expected recovery workspaces.");
        }
        const [readyFirst, readySecond] = await Promise.all([
            waitForWorkspace(
                fixture.store,
                first.projectId,
                first.id,
                (value) => value.status === "ready",
            ),
            waitForWorkspace(
                fixture.store,
                second.projectId,
                second.id,
                (value) => value.status === "ready",
            ),
        ]);
        expect(
            (await fixture.store.listWorkspaces(testContext(), source.snapshot().projectId!)).map(
                (workspace) => workspace.id,
            ),
        ).toEqual([readySecond.id, readyFirst.id]);
        await fixture.store.reorderWorkspace(
            testContext(),
            source.snapshot().projectId!,
            readyFirst.id,
            { afterId: null },
            readyFirst.version,
        );
        expect(
            (await fixture.store.listWorkspaces(testContext(), source.snapshot().projectId!)).map(
                (workspace) => workspace.id,
            ),
        ).toEqual([readyFirst.id, readySecond.id]);
        const attached = await fixture.store.create(testContext(), {
            cwd: readySecond.path,
            workspaceId: readySecond.id,
        });
        await fixture.store.close(testContext());
        await rm(join(readyFirst.path, "workspace-setup-recovered.txt"));

        const opened = await openSessionDatabase(createTestRootContext(), fixture.databasePath);
        await opened.client.execute({
            args: [readyFirst.id],
            sql: "UPDATE project_workspaces SET status = 'initializing' WHERE id = ?",
        });
        await opened.client.execute({
            args: [readySecond.id],
            sql: "UPDATE project_workspaces SET status = 'archiving' WHERE id = ?",
        });
        await opened.database.close(opened.ctx);

        const recovered = await PersistentSessionStore.open(testContext(), {
            databasePath: fixture.databasePath,
            homeDirectory: fixture.home,
            stateDirectory: fixture.state,
        });
        try {
            expect(
                (
                    await waitForWorkspace(
                        recovered,
                        first.projectId,
                        first.id,
                        (value) => value.status === "ready" || value.status === "failed",
                    )
                ).status,
            ).toBe("ready");
            await expect(
                readFile(join(readyFirst.path, "workspace-setup-recovered.txt"), "utf8"),
            ).resolves.toBe("recovered");
            expect(
                (
                    await waitForWorkspace(
                        recovered,
                        second.projectId,
                        second.id,
                        (value) => value.status === "archived",
                    )
                ).status,
            ).toBe("archived");
            expect((await recovered.get(testContext(), attached.id))?.snapshot().status).toBe(
                "archived",
            );
            await expect(access(readySecond.path)).rejects.toThrow();
        } finally {
            await recovered.close(testContext());
        }
    });

    it("cannot become ready after archival starts during worktree creation", async () => {
        const addStarted = deferred<void>();
        const releaseAdd = deferred<void>();
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    addStarted.resolve(undefined);
                    await releaseAdd.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const source = await fixture.store.create(testContext(), { cwd: repository });
        const workspace = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Archive During Create",
            },
        );
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await addStarted.promise;
        const current = await fixture.store.getWorkspace(
            testContext(),
            workspace.projectId,
            workspace.id,
        );
        if (current === undefined) throw new Error("Expected recorded initialization facts.");

        const archive = await fixture.store.archiveWorkspace(
            testContext(),
            workspace.projectId,
            workspace.id,
            current.version,
        );
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archiving",
        );
        releaseAdd.resolve(undefined);

        const archiving = await archive;
        expect(archiving?.status).toBe("archiving");
        const archived = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archived",
        );
        expect(archived.status).toBe("archived");
        await expect(access(workspace.path)).rejects.toThrow();
        const observedStates =
            (await fixture.store.globalEventQueue.list(testContext()))?.flatMap((entry) =>
                entry.event.type === "workspace_created" || entry.event.type === "workspace_updated"
                    ? [entry.event.data.workspace.status]
                    : [],
            ) ?? [];
        expect(observedStates).toContain("archiving");
        expect(observedStates).toContain("archived");
        expect(observedStates).not.toContain("ready");
    });

    it("stops a running setup command when the workspace is archived", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "archive-during-setup");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                'setup_commands = ["printf started > setup-started.txt; sleep 30; printf finished > setup-finished.txt"]',
                "",
            ].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure long workspace setup"]);
        const source = await fixture.store.create(testContext(), { cwd: repository });
        const workspace = await fixture.store.createWorkspace(
            testContext(),
            source.snapshot().projectId!,
            {
                baseRef: "HEAD",
                name: "Archive During Setup",
            },
        );
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await waitForPath(join(workspace.path, "setup-started.txt"));
        const current = await fixture.store.getWorkspace(
            testContext(),
            workspace.projectId,
            workspace.id,
        );
        if (current === undefined) throw new Error("Expected recorded initialization facts.");

        const archiving = await fixture.store.archiveWorkspace(
            testContext(),
            workspace.projectId,
            workspace.id,
            current.version,
        );
        expect(archiving?.status).toBe("archiving");
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archived",
        );

        await expect(access(workspace.path)).rejects.toThrow();
        expect(
            (await fixture.store.globalEventQueue.list(testContext()))?.some(
                (entry) =>
                    (entry.event.type === "workspace_created" ||
                        entry.event.type === "workspace_updated") &&
                    entry.event.data.workspace.status === "ready" &&
                    entry.event.data.workspace.id === workspace.id,
            ),
        ).toBe(false);
    });

    it("archives its chats and workspaces, and returns when the folder is used again", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const root = await fixture.store.create(testContext(), { cwd: repository });
        const projectId = root.snapshot().projectId!;
        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            name: "Feature",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.status === "ready",
        );
        const attached = await fixture.store.create(testContext(), {
            cwd: workspace.path,
            workspaceId: workspace.id,
        });

        const archived = await fixture.store.archiveProject(
            testContext(),
            projectId,
            (await fixture.store.getProject(testContext(), projectId))!.version,
        );

        expect(archived?.archivedAt).toBeGreaterThan(0);
        expect((await fixture.store.get(testContext(), root.id))?.snapshot().archived).toBe(true);
        expect((await fixture.store.get(testContext(), attached.id))?.snapshot().status).toBe(
            "archived",
        );
        expect(
            (await fixture.store.getWorkspace(testContext(), projectId, workspace.id))?.status,
        ).toBe("archived");
        await expect(access(workspace.path)).rejects.toThrow();

        const resumed = await fixture.store.create(testContext(), { cwd: repository });
        expect(resumed.snapshot().projectId!).toBe(projectId);
        expect(
            (await fixture.store.getProject(testContext(), projectId))?.archivedAt,
        ).toBeUndefined();
    });

    it("does not let delayed archive cleanup overtake a later unarchive", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "archive-race");
        await mkdir(directory);
        const session = await fixture.store.create(testContext(), { cwd: directory });
        const projectId = session.snapshot().projectId!;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        fixture.store.remoteTerminals.closeProject = () => held;

        const archiving = fixture.store.archiveProject(
            testContext(),
            projectId,
            (await fixture.store.getProject(testContext(), projectId))!.version,
        );
        await waitFor(
            () => session.snapshot(),
            (value) => value.archived,
        );
        expect(session.snapshot().archived).toBe(true);
        await session.setArchived(testContext(), false);
        await fixture.store.unarchiveProject(testContext(), projectId);
        release();
        await archiving;

        expect(
            (await fixture.store.getProject(testContext(), projectId))?.archivedAt,
        ).toBeUndefined();
        expect(session.snapshot().archived).toBe(false);
    });

    it("refuses to archive against a stale version and repeats without effect", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "folder");
        await mkdir(directory);
        const session = await fixture.store.create(testContext(), { cwd: directory });
        const projectId = session.snapshot().projectId!;
        const staleVersion = (await fixture.store.getProject(testContext(), projectId))!.version;
        await fixture.store.renameProject(testContext(), projectId, "Renamed folder", staleVersion);

        await expect(
            fixture.store.archiveProject(testContext(), projectId, staleVersion),
        ).rejects.toThrow(/changed before it could be archived/);

        const archived = await fixture.store.archiveProject(
            testContext(),
            projectId,
            (await fixture.store.getProject(testContext(), projectId))!.version,
        );
        const repeated = await fixture.store.archiveProject(testContext(), projectId, 999);
        expect(repeated?.archivedAt).toBe(archived?.archivedAt);
        expect(repeated?.version).toBe(archived?.version);
    });
    it("records presence and worktree capability for every project at startup", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "tracked");
        const plain = join(fixture.root, "plain");
        await mkdir(plain);

        const repositoryProject = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const plainProject = (await fixture.store.create(testContext(), { cwd: plain })).snapshot()
            .projectId!;

        const tracked = await waitForProject(
            fixture.store,
            repositoryProject,
            (project) => project.worktreeSupport !== "unknown",
        );
        expect(tracked).toMatchObject({ presence: "present", worktreeSupport: "supported" });
        expect(tracked.git?.branch).toBe("main");

        const unsupported = await waitForProject(
            fixture.store,
            plainProject,
            (project) => project.worktreeSupport !== "unknown",
        );
        expect(unsupported).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is not a Git repository.",
        });
    });

    it("reports a project whose directory disappeared as missing after a restart", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "vanishing");
        await mkdir(directory);
        const projectId = (await fixture.store.create(testContext(), { cwd: directory })).snapshot()
            .projectId!;
        await waitForProject(fixture.store, projectId, (p) => p.worktreeSupport !== "unknown");
        await fixture.store.close(testContext());
        await rm(directory, { force: true, recursive: true });

        const restarted = await fixture.restart();

        const project = await waitForProject(
            restarted,
            projectId,
            (value) => value.presence === "missing",
        );
        expect(project.worktreeSupportReason).toBe("This folder no longer exists.");
    });

    it("refuses immediate checkout operations when a ready workspace directory is missing", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "missing-workspace-source");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const sourceReservation = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            name: "Missing Source",
        });
        const targetReservation = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            name: "Available Target",
        });
        if (sourceReservation === undefined || targetReservation === undefined) {
            throw new Error("Expected workspace reservations.");
        }
        const [source, target] = await Promise.all([
            waitForWorkspace(
                fixture.store,
                projectId,
                sourceReservation.id,
                (workspace) => workspace.status === "ready",
            ),
            waitForWorkspace(
                fixture.store,
                projectId,
                targetReservation.id,
                (workspace) => workspace.status === "ready",
            ),
        ]);
        const session = await fixture.store.create(testContext(), {
            cwd: source.path,
            workspaceId: source.id,
        });
        await fixture.store.close(testContext());
        await rm(source.path, { force: true, recursive: true });

        const restarted = await fixture.restart();
        await waitForWorkspace(
            restarted,
            projectId,
            source.id,
            (workspace) => workspace.presence === "missing",
        );

        await expect(restarted.fork(testContext(), session.id)).rejects.toThrow(
            "unavailable workspace",
        );
        await expect(
            restarted.remoteTerminals.create(
                testContext(),
                { projectId, workspaceId: source.id },
                { command: "pwd" },
            ),
        ).rejects.toThrow("ready, available");
        await expect(
            restarted.transferSession(testContext(), session.id, { targetWorkspaceId: target.id }),
        ).rejects.toThrow("not ready and available");
    });

    it("persists the resolved base commit so a moving base ref cannot rewrite history", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "based");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const expected = await git(repository, ["rev-parse", "HEAD"]);

        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "main",
            name: "Based",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.baseCommit !== undefined,
        );

        expect(workspace.baseRef).toBe("main");
        expect(workspace.baseCommit).toBe(expected.toLowerCase());
    });

    it("forks the remote trunk instead of the project's local branch", async () => {
        const gitCalls: { args: readonly string[]; cwd: string }[] = [];
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                gitCalls.push({ args, cwd });
                return git(cwd, args);
            },
        });
        const remote = join(fixture.root, "remote.git");
        const upstream = await createRepository(fixture.root, "upstream");
        await mkdir(remote);
        await git(remote, ["init", "--bare"]);
        await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
        await git(upstream, ["remote", "add", "origin", remote]);
        await git(upstream, ["push", "-u", "origin", "main"]);
        const repository = join(fixture.root, "clone");
        await git(fixture.root, ["clone", remote, repository]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);

        await writeFile(join(upstream, "REMOTE.md"), "new upstream commit\n");
        await git(upstream, ["add", "REMOTE.md"]);
        await git(upstream, ["commit", "-m", "Advance origin"]);
        await git(upstream, ["push", "origin", "main"]);
        const expected = (await git(upstream, ["rev-parse", "HEAD"])).toLowerCase();

        // The project folder is left on a commit that exists nowhere but here.
        await writeFile(join(repository, "LOCAL.md"), "local only\n");
        await git(repository, ["add", "LOCAL.md"]);
        await git(repository, ["commit", "-m", "Local only"]);
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;

        const workspace = await fixture.store.createWorkspace(testContext(), projectId, {
            name: "Fresh Origin",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );

        expect(ready.status).toBe("ready");
        expect(ready.baseRef).toBe("origin/main");
        expect(ready.baseCommit).toBe(expected);
        expect(await git(ready.path, ["rev-parse", "HEAD"])).toBe(expected);
        await expect(access(join(ready.path, "REMOTE.md"))).resolves.toBeUndefined();
        await expect(access(join(ready.path, "LOCAL.md"))).rejects.toThrow();
        const fetches = gitCalls.filter(
            (call) => call.args[0] === "fetch" && call.args[1] === "origin",
        );
        expect(fetches).not.toHaveLength(0);
        // Fetching happens in the project, before the worktree exists, and never inside it.
        expect(fetches.every((call) => call.cwd !== ready.path)).toBe(true);
    });

    it("records the trunk a project was added on and reuses it for every workspace", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "trunk-named");
        await git(repository, ["branch", "-m", "main", "release"]);
        await git(repository, ["update-ref", "refs/remotes/origin/release", "HEAD"]);
        await git(repository, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/release",
        ]);
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        await waitForProject(fixture.store, projectId, (p) => p.defaultBranch !== undefined);
        expect((await fixture.store.getProject(testContext(), projectId))?.defaultBranch).toBe(
            "release",
        );

        // A project folder that later moves to another branch keeps forking its trunk.
        await git(repository, ["checkout", "-q", "-b", "sidetrack"]);
        await writeFile(join(repository, "SIDE.md"), "side\n");
        await git(repository, ["add", "SIDE.md"]);
        await git(repository, ["commit", "-m", "Side"]);

        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            name: "From Trunk",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(workspace.status).toBe("ready");
        expect(workspace.baseRef).toBe("origin/release");
    });

    it("keeps a client-chosen workspace identity honest about the base it was built on", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "retry-base");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const id = createId();

        const first = await fixture.store.createWorkspace(testContext(), projectId, {
            id,
            name: "Retried",
        });
        if (first === undefined) throw new Error("Expected a workspace.");
        // The same request, repeated because the caller never learned it landed.
        const repeated = await fixture.store.createWorkspace(testContext(), projectId, {
            id,
            name: "Retried",
        });
        expect(repeated?.id).toBe(first.id);
        expect(await fixture.store.listWorkspaces(testContext(), projectId)).toHaveLength(1);

        await expect(
            fixture.store.createWorkspace(testContext(), projectId, {
                baseRef: "HEAD~0",
                id,
                name: "Retried",
            }),
        ).rejects.toThrow(/different base/);
    });

    it("takes the name of its first chat and moves its branch to match", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "workspace-naming");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "main",
            name: "Workspace 12",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (workspace) => workspace.status === "ready",
        );
        expect(ready.branch).toBe("worktree/workspace-12");
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/workspace-12");

        const events: string[] = [];
        const projects = await openProjects(fixture, (event) => events.push(event.type));
        try {
            const named = await projects.repository.inheritWorkspaceName(
                testContext(),
                projectId,
                ready.id,
                "Fix Title Inheritance",
            );
            expect(named).toMatchObject({
                branch: "worktree/fix-title-inheritance",
                name: "Fix Title Inheritance",
            });
            // The folder never moves: a chat is already working inside it.
            expect(named?.path).toBe(ready.path);
            expect(events).toEqual(["workspace_updated"]);
            await waitForBranch(ready.path, "worktree/fix-title-inheritance");
        } finally {
            await projects.close();
        }
    });

    it("leaves the branch alone when a new name spells the same branch", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "workspace-same-branch");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "main",
            name: "Release prep",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (workspace) => workspace.status === "ready",
        );
        expect(ready.branch).toBe("worktree/release-prep");

        // Only the capitals change, so the branch the workspace is already on still spells it.
        expect(
            await fixture.store.renameWorkspace(testContext(), projectId, ready.id, "Release Prep"),
        ).toMatchObject({
            branch: "worktree/release-prep",
            name: "Release Prep",
        });
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/release-prep");
    });

    it("leaves a workspace its owner has named alone, and moves the branch they chose", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "workspace-user-named");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "main",
            name: "Workspace 13",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (workspace) => workspace.status === "ready",
        );

        expect(
            await fixture.store.renameWorkspace(testContext(), projectId, ready.id, "Release Prep"),
        ).toMatchObject({
            branch: "worktree/release-prep",
            name: "Release Prep",
        });
        await waitForBranch(ready.path, "worktree/release-prep");

        const projects = await openProjects(fixture);
        try {
            expect(
                await projects.repository.inheritWorkspaceName(
                    testContext(),
                    projectId,
                    ready.id,
                    "First Chat Name",
                ),
            ).toMatchObject({ branch: "worktree/release-prep", name: "Release Prep" });
        } finally {
            await projects.close();
        }
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/release-prep");
    });

    it("keeps the name an agent chose when it asked for the workspace", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "workspace-agent-named");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "main",
            name: "Investigate Parser",
            nameConfigured: true,
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (workspace) => workspace.status === "ready",
        );
        expect(ready.branch).toBe("worktree/investigate-parser");

        const projects = await openProjects(fixture);
        try {
            expect(
                await projects.repository.inheritWorkspaceName(
                    testContext(),
                    projectId,
                    ready.id,
                    "First Chat Name",
                ),
            ).toMatchObject({ branch: "worktree/investigate-parser", name: "Investigate Parser" });
        } finally {
            await projects.close();
        }
        expect(await git(ready.path, ["branch", "--show-current"])).toBe(
            "worktree/investigate-parser",
        );
    });

    it("keeps two workspaces named the same apart, in the name and in the branch", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "workspace-name-clash");
        const projectId = (
            await fixture.store.create(testContext(), { cwd: repository })
        ).snapshot().projectId!;
        const ready = [];
        for (const name of ["Workspace 14", "Workspace 15"]) {
            const created = await fixture.store.createWorkspace(testContext(), projectId, {
                baseRef: "main",
                name,
            });
            if (created === undefined) throw new Error("Expected a workspace.");
            ready.push(
                await waitForWorkspace(
                    fixture.store,
                    projectId,
                    created.id,
                    (workspace) => workspace.status === "ready",
                ),
            );
        }

        const projects = await openProjects(fixture);
        try {
            expect(
                await projects.repository.inheritWorkspaceName(
                    testContext(),
                    projectId,
                    ready[0]!.id,
                    "Shared Name",
                ),
            ).toMatchObject({ branch: "worktree/shared-name", name: "Shared Name" });
            expect(
                await projects.repository.inheritWorkspaceName(
                    testContext(),
                    projectId,
                    ready[1]!.id,
                    "Shared Name",
                ),
            ).toMatchObject({ branch: "worktree/shared-name-2", name: "Shared Name (2)" });
            await waitForBranch(ready[0]!.path, "worktree/shared-name");
            await waitForBranch(ready[1]!.path, "worktree/shared-name-2");
        } finally {
            await projects.close();
        }
    });

    it("lets a client name what it creates, and refuses a name that means something else", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "client-named");
        const other = await createRepository(fixture.root, "client-named-other");
        const projectId = createId();
        const workspaceId = createId();

        const session = await fixture.store.createWithId(testContext(), createId(), {
            cwd: repository,
            projectId,
        });
        expect(session.snapshot().projectId!).toBe(projectId);

        const created = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Client Named",
        });
        expect(created?.id).toBe(workspaceId);

        // The request is answered again rather than creating a second workspace,
        // which is what makes a retry safe.
        const repeated = await fixture.store.createWorkspace(testContext(), projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Client Named",
        });
        expect(repeated?.id).toBe(workspaceId);
        expect(await fixture.store.listWorkspaces(testContext(), projectId)).toHaveLength(1);

        const otherProjectId = (
            await fixture.store.create(testContext(), { cwd: other })
        ).snapshot().projectId!;
        await expect(
            fixture.store.createWorkspace(testContext(), otherProjectId, {
                baseRef: "HEAD",
                id: workspaceId,
                name: "Elsewhere",
            }),
        ).rejects.toThrow("another project");
        await expect(
            fixture.store.createWorkspace(testContext(), projectId, {
                baseRef: "HEAD~0",
                id: workspaceId,
                name: "Rebased",
            }),
        ).rejects.toThrow("different base");
        await expect(
            fixture.store.createWorkspace(testContext(), projectId, {
                baseRef: "HEAD",
                id: "Not A Cuid2",
                name: "Invalid",
            }),
        ).rejects.toThrow("cuid2");

        // A directory Rig already knows keeps the identity it has, so importing
        // it again is answered rather than renamed, and reusing that identity
        // for a different folder is refused.
        const reimported = await fixture.store.createWithId(testContext(), createId(), {
            cwd: repository,
            projectId: createId(),
        });
        expect(reimported.snapshot().projectId!).toBe(projectId);
        await expect(
            fixture.store.createWithId(testContext(), createId(), { cwd: other, projectId }),
        ).rejects.toThrow("another folder");
    });

    it("answers a repeated session create instead of creating a second session", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "retried-session");
        await mkdir(directory, { recursive: true });
        const sessionId = createId();

        const created = await fixture.store.createWithId(testContext(), sessionId, {
            cwd: directory,
        });
        const repeated = await fixture.store.createWithId(testContext(), sessionId, {
            cwd: directory,
        });

        expect(repeated.id).toBe(created.id);
        expect(
            (await fixture.store.list(testContext())).filter(
                (session) => session.cwd === directory,
            ),
        ).toHaveLength(1);
        await expect(
            fixture.store.createWithId(testContext(), sessionId, { cwd: fixture.root }),
        ).rejects.toThrow("another directory");
    });
});

/**
 * Takes the write lock the way any observer with its own connection does. The short timeout keeps
 * a deadlock quick to report; a healthy archival never contends for the lock at all.
 */
async function writeOnSeparateConnection(databasePath: string): Promise<void> {
    const client = createClient({
        timeout: 250,
        url: pathToFileURL(databasePath).href,
    });
    try {
        await client.execute("BEGIN IMMEDIATE");
        await client.execute("COMMIT");
    } finally {
        await client.close();
    }
}

async function createFixture(
    options: {
        durableGlobalEventQueue?: boolean;
        onSessionAccess?: (session: InMemorySession) => void;
        onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
        projectGit?: GitCommandRunner;
        projectClone?: ProjectRepositoryOptions["cloneRemote"];
        createRuntime?: InMemorySessionOptions["createRuntime"];
        workspacesDirectory?: string;
    } = {},
): Promise<{
    home: string;
    databasePath: string;
    restart: () => Promise<PersistentSessionStore>;
    root: string;
    state: string;
    store: PersistentSessionStore;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-projects-test-"));
    const home = join(root, "home");
    const state = join(root, "state");
    await Promise.all([mkdir(home), mkdir(state)]);
    const databasePath = join(state, "sessions.sqlite");
    const open = () =>
        PersistentSessionStore.open(testContext(), {
            ...(options.createRuntime === undefined
                ? {}
                : { createRuntime: options.createRuntime }),
            databasePath,
            localInstanceId: TEST_LOCAL_INSTANCE_ID,
            ...(options.durableGlobalEventQueue === undefined
                ? {}
                : { durableGlobalEventQueue: options.durableGlobalEventQueue }),
            homeDirectory: home,
            ...(options.onSessionAccess === undefined
                ? {}
                : { onSessionAccess: options.onSessionAccess }),
            ...(options.onWorkspaceCleanupError === undefined
                ? {}
                : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
            ...(options.projectGit === undefined ? {} : { projectGit: options.projectGit }),
            ...(options.projectClone === undefined ? {} : { projectClone: options.projectClone }),
            stateDirectory: state,
            ...(options.workspacesDirectory === undefined
                ? {}
                : { workspacesDirectory: options.workspacesDirectory }),
        });
    const stores = [await open()];
    cleanups.push(async () => {
        try {
            for (const store of stores) await store.close(testContext());
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
    const restart = async () => {
        const next = await open();
        stores.push(next);
        return next;
    };
    return { databasePath, home, restart, root, state, store: stores[0]! };
}

async function createLocalProfile(store: PersistentSessionStore) {
    return new RigProfileStore({
        database: store,
        localInstanceId: TEST_LOCAL_INSTANCE_ID,
        publish: () => undefined,
    }).create(testContext(), {
        email: "steve@example.test",
        name: "Steve Korshakov",
    });
}

async function createTransferFixture(
    options: {
        createRuntime?: InMemorySessionOptions["createRuntime"];
        projectGit?: GitCommandRunner;
    } = {},
): Promise<{
    fixture: Awaited<ReturnType<typeof createFixture>>;
    session: InMemorySession;
    source: NonNullable<Awaited<ReturnType<PersistentSessionStore["createWorkspace"]>>>;
    target: NonNullable<Awaited<ReturnType<PersistentSessionStore["createWorkspace"]>>>;
}> {
    const fixture = await createFixture(options);
    const repository = await createRepository(fixture.root, "transfer-source");
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
    await git(repository, ["add", ".gitignore"]);
    await git(repository, ["commit", "-m", "Ignore fixture"]);
    const rootSession = await fixture.store.create(testContext(), { cwd: repository });
    const projectId = rootSession.snapshot().projectId!;
    await waitForProject(
        fixture.store,
        projectId,
        (project) => project.initializationStatus === "ready",
    );
    const sourceReserved = await fixture.store.createWorkspace(testContext(), projectId, {
        baseRef: "HEAD",
        name: "Transfer Source",
    });
    const targetReserved = await fixture.store.createWorkspace(testContext(), projectId, {
        baseRef: "HEAD",
        name: "Transfer Target",
    });
    if (sourceReserved === undefined || targetReserved === undefined) {
        throw new Error("Expected transfer workspaces.");
    }
    const source = await waitForWorkspace(
        fixture.store,
        projectId,
        sourceReserved.id,
        (workspace) => workspace.status === "ready",
    );
    const target = await waitForWorkspace(
        fixture.store,
        projectId,
        targetReserved.id,
        (workspace) => workspace.status === "ready",
    );
    const session = await fixture.store.create(testContext(), {
        cwd: source.path,
        workspaceId: source.id,
    });
    return { fixture, session, source, target };
}

function createTransferTestRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: options.cwd,
        processManager,
    });
    if (options.workspaces !== undefined) context.workspaces = options.workspaces;
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? modelOpenaiGpt56Sol.id,
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function transferResponseStream(text: string, release = Promise.resolve()): InferenceStream {
    const message: AssistantMessage = {
        api: "test",
        content: [{ text, type: "text" }],
        model: modelOpenaiGpt56Sol.id,
        provider: "codex",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 0,
                output: 0,
                total: 0,
            },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
    return {
        async *[Symbol.asyncIterator]() {
            await release;
            yield { partial: message, type: "start" as const };
            yield { message, reason: "stop" as const, type: "done" as const };
        },
        async result() {
            await release;
            return message;
        },
    };
}

/** Uses a real driver fault so the test cannot drift from what SQLite actually throws. */
async function captureDriverError(): Promise<unknown> {
    const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
    try {
        await opened.client.execute("select * from missing_table");
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        await opened.database.close(opened.ctx);
    }
}

/**
 * Observes the process-level hard failure a database fault is supposed to become, and answers
 * `undefined` when nothing escaped. Rig's own listeners are lifted for the duration so the
 * deliberate rejection is not also reported as a failure of the surrounding suite.
 */
async function captureUnhandledRejection(run: () => Promise<void>): Promise<unknown> {
    const installed = process.listeners("unhandledRejection");
    for (const listener of installed) process.off("unhandledRejection", listener);
    let captured: unknown;
    const observe = (reason: unknown): void => {
        captured ??= reason;
    };
    process.on("unhandledRejection", observe);
    try {
        await run();
        for (let attempt = 0; attempt < 200 && captured === undefined; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return captured;
    } finally {
        process.off("unhandledRejection", observe);
        for (const listener of installed) process.on("unhandledRejection", listener);
    }
}

async function createRepository(root: string, name: string): Promise<string> {
    const repository = join(root, name);
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "rig@example.test"]);
    await git(repository, ["config", "user.name", "Rig Test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    return repository;
}

async function openProjects(
    fixture: { databasePath: string; home: string; state: string },
    onEvent?: (event: Parameters<NonNullable<ProjectRepositoryOptions["onEvent"]>>[1]) => void,
): Promise<{ close: () => Promise<void>; repository: ProjectRepository }> {
    const opened = await openSessionDatabase(createTestRootContext(), fixture.databasePath);
    const options: ProjectRepositoryOptions = {
        database: opened.database,
        homeDirectory: fixture.home,
        stateDirectory: fixture.state,
    };
    if (onEvent !== undefined) options.onEvent = (_ctx, event) => onEvent(event);
    const repository = new ProjectRepository(options);
    return {
        close: async () => {
            await repository.close(testContext());
            await opened.database.close(opened.ctx);
        },
        repository,
    };
}

async function waitForBranch(workspacePath: string, branch: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        if ((await git(workspacePath, ["branch", "--show-current"])) === branch) return;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for branch ${branch}.`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 5_000,
    });
    return result.stdout.trim();
}

async function waitForProject(
    store: PersistentSessionStore,
    projectId: string,
    predicate: (
        project: NonNullable<Awaited<ReturnType<PersistentSessionStore["getProject"]>>>,
    ) => boolean,
) {
    return await waitFor(() => store.getProject(testContext(), projectId), predicate);
}

async function waitForWorkspace(
    store: PersistentSessionStore,
    projectId: string,
    workspaceId: string,
    predicate: (
        workspace: NonNullable<Awaited<ReturnType<PersistentSessionStore["getWorkspace"]>>>,
    ) => boolean,
) {
    return await waitFor(
        () => store.getWorkspace(testContext(), projectId, workspaceId),
        predicate,
    );
}

function deferred<T>(): {
    promise: Promise<T>;
    reject: (reason?: unknown) => void;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let reject!: (reason?: unknown) => void;
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

async function waitFor<T>(
    read: () => T | PromiseLike<T | undefined> | undefined,
    predicate: (value: T) => boolean,
): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = await read();
        if (value !== undefined && predicate(value)) return value;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for project state.");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await access(path);
            return;
        } catch {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
    }
}

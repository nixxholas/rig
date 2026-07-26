import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { PersistentSessionStore } from "./PersistentSessionStore.js";
import type { ProjectGitRunner } from "./ProjectRepository.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("projects", () => {
    it("assigns canonical directories immediately and distinguishes nested projects", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const projectDirectory = join(fixture.root, "project");
        const nestedDirectory = join(projectDirectory, "nested");
        const alias = join(fixture.root, "alias");
        await mkdir(nestedDirectory, { recursive: true });
        await symlink(projectDirectory, alias);

        const first = fixture.store.create({ cwd: projectDirectory });
        const second = fixture.store.create({ cwd: alias });
        const nested = fixture.store.create({ cwd: nestedDirectory });

        expect(first.snapshot().projectId).toBe(second.snapshot().projectId);
        expect(nested.snapshot().projectId).not.toBe(first.snapshot().projectId);
        expect(fixture.store.listProjects().map((project) => project.id)).toEqual([
            nested.snapshot().projectId,
            first.snapshot().projectId,
        ]);
        expect(
            fixture.store
                .list()
                .filter((session) => session.projectId === first.snapshot().projectId)
                .map((session) => session.id),
        ).toEqual([first.id, second.id]);

        const movedProject = fixture.store.reorderProject(
            nested.snapshot().projectId,
            { afterId: first.snapshot().projectId },
            fixture.store.getProject(nested.snapshot().projectId)!.version,
        );
        expect(movedProject).toBeDefined();
        expect(fixture.store.listProjects().map((project) => project.id)).toEqual([
            first.snapshot().projectId,
            nested.snapshot().projectId,
        ]);

        fixture.store.reorderSession(second.id, { afterId: null });
        expect(
            fixture.store
                .list()
                .filter((session) => session.projectId === first.snapshot().projectId)
                .map((session) => session.id),
        ).toEqual([second.id, first.id]);
        expect(fixture.store.globalEventQueue.list()?.map((entry) => entry.event.type)).toEqual([
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
        const session = fixture.store.create({ cwd: fixture.home });
        expect(fixture.store.getProject(session.snapshot().projectId)).toMatchObject({
            avatarBuiltin: "home",
            initializationStatus: "ready",
            kind: "home",
            name: "Home",
        });
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

        const session = fixture.store.create({ cwd: repository });
        const project = await waitForProject(
            fixture.store,
            session.snapshot().projectId,
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
        await expect(fixture.store.getProjectAvatar(project.avatar!.hash)).resolves.toMatchObject({
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

        const sourceSession = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(sourceSession.snapshot().projectId, {
            baseRef: "HEAD",
            clientRequestId: "request-1",
            name: "Feature Work",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");

        const workspaceSession = fixture.store.create({
            cwd: ready.path,
            workspaceId: ready.id,
        });
        const workspaceFork = fixture.store.fork(workspaceSession.id);
        if (workspaceFork === undefined) throw new Error("Expected a workspace session fork.");
        expect(workspaceSession.snapshot()).toMatchObject({
            projectId: sourceSession.snapshot().projectId,
            workspaceId: ready.id,
        });

        const archived = await fixture.store.archiveWorkspace(
            ready.projectId,
            ready.id,
            ready.version,
        );
        expect(archived?.status).toBe("archived");
        expect(workspaceSession.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect(workspaceFork.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect(() => workspaceSession.submit({ text: "Do not run." })).toThrow("archived");
        expect(() => fixture.store.fork(workspaceSession.id)).toThrow("archived");
        await expect(access(ready.path)).rejects.toThrow();
        await mkdir(ready.path, { recursive: true });
        expect(() => fixture.store.create({ cwd: ready.path })).toThrow("archived");
    });

    it("reconciles interrupted workspace creation and archival after restart", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const source = fixture.store.create({ cwd: repository });
        const first = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            clientRequestId: "recover-create",
            name: "Recovered Create",
        });
        const second = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            clientRequestId: "recover-archive",
            name: "Recovered Archive",
        });
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
            fixture.store
                .listWorkspaces(source.snapshot().projectId)
                .map((workspace) => workspace.id),
        ).toEqual([readySecond.id, readyFirst.id]);
        fixture.store.reorderWorkspace(
            source.snapshot().projectId,
            readyFirst.id,
            { afterId: null },
            readyFirst.version,
        );
        expect(
            fixture.store
                .listWorkspaces(source.snapshot().projectId)
                .map((workspace) => workspace.id),
        ).toEqual([readyFirst.id, readySecond.id]);
        const attached = fixture.store.create({
            cwd: readySecond.path,
            workspaceId: readySecond.id,
        });
        fixture.store.close();

        const database = new DatabaseSync(fixture.databasePath);
        database
            .prepare("UPDATE project_workspaces SET status = 'initializing' WHERE id = ?")
            .run(readyFirst.id);
        database
            .prepare("UPDATE project_workspaces SET status = 'archiving' WHERE id = ?")
            .run(readySecond.id);
        database.close();

        const recovered = new PersistentSessionStore({
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
            expect(
                (
                    await waitForWorkspace(
                        recovered,
                        second.projectId,
                        second.id,
                        (value) => value.status === "archived" || value.status === "archive_failed",
                    )
                ).status,
            ).toBe("archived");
            expect(recovered.get(attached.id)?.snapshot().status).toBe("archived");
            await expect(access(readySecond.path)).rejects.toThrow();
        } finally {
            recovered.close();
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

        const source = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            clientRequestId: "archive-during-create",
            name: "Archive During Create",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await addStarted.promise;

        const archive = fixture.store.archiveWorkspace(
            workspace.projectId,
            workspace.id,
            workspace.version,
        );
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archiving",
        );
        releaseAdd.resolve(undefined);

        const archived = await archive;
        expect(archived?.status).toBe("archived");
        await expect(access(workspace.path)).rejects.toThrow();
        const observedStates =
            fixture.store.globalEventQueue
                .list()
                ?.flatMap((entry) =>
                    entry.event.type === "workspace_created" ||
                    entry.event.type === "workspace_updated"
                        ? [entry.event.data.workspace.status]
                        : [],
                ) ?? [];
        expect(observedStates).toContain("archiving");
        expect(observedStates).toContain("archived");
        expect(observedStates).not.toContain("ready");
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

        const root = fixture.store.create({ cwd: repository });
        const projectId = root.snapshot().projectId;
        const created = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            clientRequestId: "archive-project",
            name: "Feature",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.status === "ready",
        );
        const attached = fixture.store.create({ cwd: workspace.path, workspaceId: workspace.id });

        const archived = await fixture.store.archiveProject(
            projectId,
            fixture.store.getProject(projectId)!.version,
        );

        expect(archived?.archivedAt).toBeGreaterThan(0);
        expect(fixture.store.get(root.id)?.snapshot().archived).toBe(true);
        expect(fixture.store.get(attached.id)?.snapshot().status).toBe("archived");
        expect(fixture.store.getWorkspace(projectId, workspace.id)?.status).toBe("archived");
        await expect(access(workspace.path)).rejects.toThrow();

        const resumed = fixture.store.create({ cwd: repository });
        expect(resumed.snapshot().projectId).toBe(projectId);
        expect(fixture.store.getProject(projectId)?.archivedAt).toBeUndefined();
    });

    it("refuses to archive against a stale version and repeats without effect", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "folder");
        await mkdir(directory);
        const session = fixture.store.create({ cwd: directory });
        const projectId = session.snapshot().projectId;

        await expect(fixture.store.archiveProject(projectId, 999)).rejects.toThrow(
            /changed before it could be archived/,
        );

        const archived = await fixture.store.archiveProject(
            projectId,
            fixture.store.getProject(projectId)!.version,
        );
        const repeated = await fixture.store.archiveProject(projectId, 999);
        expect(repeated?.archivedAt).toBe(archived?.archivedAt);
        expect(repeated?.version).toBe(archived?.version);
    });
    it("records presence and worktree capability for every project at startup", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "tracked");
        const plain = join(fixture.root, "plain");
        await mkdir(plain);

        const repositoryProject = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const plainProject = fixture.store.create({ cwd: plain }).snapshot().projectId;

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
        const projectId = fixture.store.create({ cwd: directory }).snapshot().projectId;
        await waitForProject(fixture.store, projectId, (p) => p.worktreeSupport !== "unknown");
        fixture.store.close();
        await rm(directory, { force: true, recursive: true });

        const restarted = await fixture.restart();

        const project = await waitForProject(
            restarted,
            projectId,
            (value) => value.presence === "missing",
        );
        expect(project.worktreeSupportReason).toBe("This folder no longer exists.");
    });

    it("persists the resolved base commit so a moving base ref cannot rewrite history", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "based");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const expected = await git(repository, ["rev-parse", "HEAD"]);

        const workspace = await fixture.store.createWorkspace(projectId, {
            baseRef: "main",
            clientRequestId: "base-commit",
            name: "Based",
        });

        expect(workspace?.baseRef).toBe("main");
        expect(workspace?.baseCommit).toBe(expected.toLowerCase());
    });
});

async function createFixture(
    options: {
        durableGlobalEventQueue?: boolean;
        projectGit?: ProjectGitRunner;
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
        new PersistentSessionStore({
            databasePath,
            ...(options.durableGlobalEventQueue === undefined
                ? {}
                : { durableGlobalEventQueue: options.durableGlobalEventQueue }),
            homeDirectory: home,
            ...(options.projectGit === undefined ? {} : { projectGit: options.projectGit }),
            stateDirectory: state,
        });
    const stores = [open()];
    cleanups.push(async () => {
        try {
            for (const store of stores) store.close();
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
    const restart = async () => {
        const next = open();
        stores.push(next);
        return next;
    };
    return { databasePath, home, restart, root, state, store: stores[0]! };
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
    predicate: (project: NonNullable<ReturnType<PersistentSessionStore["getProject"]>>) => boolean,
) {
    return await waitFor(() => store.getProject(projectId), predicate);
}

async function waitForWorkspace(
    store: PersistentSessionStore,
    projectId: string,
    workspaceId: string,
    predicate: (
        workspace: NonNullable<ReturnType<PersistentSessionStore["getWorkspace"]>>,
    ) => boolean,
) {
    return await waitFor(() => store.getWorkspace(projectId, workspaceId), predicate);
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

async function waitFor<T>(read: () => T | undefined, predicate: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = read();
        if (value !== undefined && predicate(value)) return value;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for project state.");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

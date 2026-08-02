import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitStateTracker } from "../../rig/sources/git/GitStateTracker.js";
import { InMemorySessionStore } from "../../rig/sources/session/InMemorySessionStore.js";
import { PersistentSessionStore } from "../../rig/sources/session/PersistentSessionStore.js";
import { publishGitLiveEvent } from "../../rig/sources/git/publishGitLiveEvent.js";
import type { SessionStore } from "../../rig/sources/session/SessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import {
    createEventIdFactory,
    type ProjectWorkspace as DaemonProjectWorkspace,
} from "../../rig/sources/protocol/index.js";
import {
    connectRig,
    type RigGroupsConnection,
    type RigGroupsSubscriptionOptions,
} from "@/connectRig.js";
import type { GlobalStreamHello } from "@/protocol.js";

/**
 * These run against the real daemon rather than scripted frames, because the
 * point of the library is that the stream alone is sufficient. A fixture written
 * from assumptions about the wire proves only that the assumptions are
 * self-consistent.
 */

const started: { close: () => Promise<void> }[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
    for (const server of started.splice(0)) await server.close();
});

async function startDaemon() {
    const store = new InMemorySessionStore();
    return startServer(store);
}

async function startServer<TStore extends SessionStore>(
    store: TStore,
    closeStore?: () => void,
    gitStateTracker?: GitStateTracker,
): Promise<{ endpoint: string; store: TStore }> {
    const server = createProtocolHttpServer({
        ...(gitStateTracker === undefined ? {} : { gitStateTracker }),
        store,
        token: "secret",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            gitStateTracker?.dispose();
            closeStore?.();
        },
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

async function waitFor(
    predicate: () => boolean,
    description: string,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

async function withGroupsConnection(
    endpoint: string,
    options: RigGroupsSubscriptionOptions,
    test: (connection: RigGroupsConnection) => Promise<void>,
): Promise<void> {
    const rig = connectRig({ endpoint, token: "secret" });
    const connection = rig.connectGroups(options);
    try {
        await test(connection);
    } finally {
        connection.close();
        rig.close();
    }
}

describe("rig-connect groups against a live daemon", () => {
    it("receives the groups that already exist on the opening frame", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-groups-a" });

        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");

            const projects = connection.projects();
            expect(projects.length).toBeGreaterThan(0);
            expect(projects.flatMap((group) => group.sessions.map((item) => item.id))).toContain(
                session.id,
            );
        });
    });

    it.skip("starts Git tracking and follows changed files", async () => {
        const repository = await createRepository();
        const store = new InMemorySessionStore();
        const tracker = new GitStateTracker({
            onLiveEvent: (event) => publishGitLiveEvent(store, event),
            onSnapshot: (entity, snapshot) => {
                const target = {
                    projectId: entity.projectId,
                    ...(entity.workspaceId === undefined
                        ? {}
                        : { workspaceId: entity.workspaceId }),
                };
                if (snapshot.comparison === "ready") {
                    store.applyGitFacts(target, snapshot.facts);
                }
            },
            tuning: { debounceMs: 10, maximumDebounceMs: 20, reconcileIntervalMs: 50 },
        });
        const { endpoint } = await startServer(store, undefined, tracker);
        const session = store.create({ cwd: repository });

        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(
                () =>
                    connection
                        .projects()
                        .find((project) => project.id === session.snapshot().projectId)?.git
                        ?.changedFiles === 0,
                "the initial Git state",
                15_000,
            );

            await writeFile(join(repository, "changed.txt"), "one\ntwo\n");

            await waitFor(
                () =>
                    connection
                        .projects()
                        .find((project) => project.id === session.snapshot().projectId)
                        ?.git?.files?.some((file) => file.path === "changed.txt") === true,
                "the changed file to arrive",
                15_000,
            );
            expect(
                connection.projects().find((project) => project.id === session.snapshot().projectId)
                    ?.git,
            ).toMatchObject({
                branch: "main",
                changedFiles: 1,
                files: [
                    {
                        insertions: 2,
                        path: "changed.txt",
                        status: "untracked",
                    },
                ],
            });
            await git(repository, ["add", "--all"]);
            await git(repository, ["commit", "--quiet", "--message", "commit changed file"]);

            await waitFor(
                () => {
                    const snapshot = connection
                        .projects()
                        .find((project) => project.id === session.snapshot().projectId)?.git;
                    return (
                        snapshot?.changedFiles === 1 &&
                        snapshot.files?.some(
                            (file) => file.path === "changed.txt" && file.status === "added",
                        ) === true
                    );
                },
                "the committed branch change to arrive",
                15_000,
            );
        });
    }, 30_000);

    it("keeps open terminal tabs in the live group stream", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-terminal-groups" });
        const { projectId } = session.projectIdentity();

        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");

            const response = await fetch(`${endpoint}/projects/${projectId}/terminals`, {
                body: JSON.stringify({ shell: "/bin/sh" }),
                headers: {
                    authorization: "Bearer secret",
                    "content-type": "application/json",
                },
                method: "POST",
            });
            expect(response.status).toBe(201);
            const created = (await response.json()) as { terminal: { id: string } };
            await waitFor(
                () =>
                    connection
                        .remoteTerminals()
                        .some(
                            (group) =>
                                group.projectId === projectId &&
                                group.terminals.some(
                                    (terminal) => terminal.id === created.terminal.id,
                                ),
                        ) === true,
                "the terminal tab to appear",
            );
        });
    });

    it("adds a session created after the client attached", async () => {
        const { endpoint, store } = await startDaemon();
        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");

            const created = store.create({ cwd: "/tmp/rig-groups-late" });

            // Everything needed to place this session in the tree has to arrive on
            // the stream; the library must not go asking for it.
            await waitFor(
                () =>
                    connection
                        .projects()
                        .some((group) =>
                            [
                                ...group.sessions,
                                ...group.workspaces.flatMap((w) => w.sessions),
                            ].some((item) => item.id === created.id),
                        ),
                "the new session to appear in the tree",
            );
        });
    });

    it("never lists one session in two places", async () => {
        const { endpoint, store } = await startDaemon();
        const first = store.create({ cwd: "/tmp/rig-groups-a" });
        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");

            const second = store.create({ cwd: "/tmp/rig-groups-a" });
            await waitFor(
                () => listedSessionIds(connection).includes(second.id),
                "the second session to arrive",
            );

            // The opening frame and the live events describe the same sessions, so a
            // store that merged them badly would show duplicates.
            const ids = listedSessionIds(connection);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toContain(first.id);
        });
    });

    // This one drives a real run and waits for the daemon's status to reach the
    // group stream, so it is the only test here whose deadline depends on
    // inference timing. A slow shared runner misses it, which blocks publishing
    // a release for a reason that has nothing to do with the release. It still
    // runs locally, where the timing is real.
    it.skipIf(process.env.CI !== undefined)(
        "reports the status the daemon reports, rather than guessing from run events",
        async () => {
            const { endpoint, store } = await startDaemon();
            const session = store.create({ cwd: "/tmp/rig-groups-status" });
            await withGroupsConnection(
                endpoint,
                { onChange: () => undefined },
                async (connection) => {
                    await waitFor(
                        () => connection.state().connection === "live",
                        "the stream to open",
                    );
                    await waitFor(
                        () => listedSessionIds(connection).includes(session.id),
                        "the session to be listed",
                    );

                    const submitted = session.submit({ text: "Say hello." });
                    await waitFor(
                        () =>
                            session.snapshot().status === "running" &&
                            listedStatus(connection, session.id) === session.snapshot().status,
                        "the listed status to match the daemon while the run is active",
                    );
                    await session.abort();
                    await session.waitForRun(submitted.runId);
                },
            );
        },
    );

    it("keeps persistent group drafts and usage live", async () => {
        const persistent = new PersistentSessionStore({ databasePath: ":memory:" });
        const { endpoint, store } = await startServer(persistent, () => persistent.close());
        const session = store.create({ cwd: "/tmp/rig-live-group-facts" });
        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");

            session.setDraft({ draft: "Live draft", updatedAt: 2 });
            const lastEventId = session.events.lastEventId();
            session.events.append({
                createdAt: 3,
                data: { sessionTokenCount: { lastContextTokens: 10, totalTokens: 40 } },
                id: createEventIdFactory(lastEventId === undefined ? {} : { after: lastEventId })(),
                sessionId: session.id,
                type: "session_context_changed",
            });

            await waitFor(
                () =>
                    connection
                        .projects()
                        .flatMap((project) => project.sessions)
                        .find((candidate) => candidate.id === session.id)?.draft === "Live draft",
                "the draft to update",
            );
            await waitFor(
                () =>
                    connection
                        .projects()
                        .find((project) => project.id === session.snapshot().projectId)?.usage
                        .totalTokens === 40,
                "the usage to update",
            );
        });
    });

    it("opens with every unarchived session, project, and workspace", async () => {
        const persistent = new PersistentSessionStore({ databasePath: ":memory:" });
        const { endpoint, store } = await startServer(persistent, () => persistent.close());
        const active = Array.from({ length: 501 }, (_, index) =>
            store.createWithId(`active-${String(index)}`, { cwd: "/tmp/rig-all-active" }),
        );
        const archivedSession = store.createWithId("archived-session", {
            cwd: "/tmp/rig-all-active",
        });
        archivedSession.setArchived(true);
        const archivedProjectSession = store.createWithId("archived-project-session", {
            cwd: "/tmp/rig-archived-project",
        });
        const archivedProjectId = archivedProjectSession.snapshot().projectId;
        await store.archiveProject(archivedProjectId);

        // An archived workspace remains durable after its worktree is removed.
        // Injecting the summary avoids making this sync test build a Git worktree.
        const activeProjectId = active[0]!.snapshot().projectId;
        const archivedWorkspace: DaemonProjectWorkspace = {
            archivedAt: 1,
            createdAt: 1,
            gitCommonDir: "/tmp/rig-all-active/.git",
            id: "archived-workspace",
            kind: "git_worktree",
            name: "Archived workspace",
            orderKey: "a0",
            path: "/tmp/rig-all-active-workspace",
            presence: "missing",
            projectId: activeProjectId,
            status: "archived",
            storageKey: "archived-workspace",
            updatedAt: 1,
            version: 1,
        };
        const listWorkspaces = store.listWorkspaces.bind(store);
        store.listWorkspaces = (projectId) => [
            ...listWorkspaces(projectId),
            ...(projectId === undefined || projectId === activeProjectId
                ? [archivedWorkspace]
                : []),
        ];

        const hello = await readGlobalHello(endpoint);
        const sessionIds = hello.sessions.map((session) => session.id);
        expect(sessionIds).toHaveLength(active.length);
        expect(sessionIds).toEqual(expect.arrayContaining(active.map((session) => session.id)));
        expect(sessionIds).not.toContain(archivedSession.id);
        expect(sessionIds).not.toContain(archivedProjectSession.id);
        expect(hello.projects.map((project) => project.id)).not.toContain(archivedProjectId);
        expect(hello.workspaces.map((workspace) => workspace.id)).not.toContain(
            archivedWorkspace.id,
        );
        expect(hello.sessionsComplete).toBe(true);
        expect(hello.catalog.providers).toEqual(expect.any(Array));
        expect(hello.identity.version).toEqual(expect.any(String));

        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");
            expect(connection.state().catalog?.providers).toEqual(expect.any(Array));
            expect(connection.state().identity?.version).toEqual(expect.any(String));
            expect(listedSessionIds(connection)).toEqual(
                expect.arrayContaining(active.map((session) => session.id)),
            );
            expect(listedSessionIds(connection)).toHaveLength(active.length);
        });
    });

    it("keeps a session listed when it is unarchived rather than dropping it", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-groups-a" });
        await withGroupsConnection(endpoint, { onChange: () => undefined }, async (connection) => {
            await waitFor(() => connection.state().connection === "live", "the stream to open");

            session.setArchived(true);
            await waitFor(
                () => !listedSessionIds(connection).includes(session.id),
                "the archived session to leave the tree",
            );

            session.setArchived(false);

            // Unarchiving reports the same event type as archiving, so a store that
            // ignores the flag would leave the session hidden for good.
            await waitFor(
                () => listedSessionIds(connection).includes(session.id),
                "the restored session to return to the tree",
            );
        });
    });
});

function listedSessionIds(connection: RigGroupsConnection | undefined): string[] {
    return (connection?.projects() ?? []).flatMap((group) => [
        ...group.sessions.map((item) => item.id),
        ...group.workspaces.flatMap((workspace) => workspace.sessions.map((item) => item.id)),
    ]);
}

function listedStatus(
    connection: RigGroupsConnection | undefined,
    sessionId: string,
): string | undefined {
    return (connection?.projects() ?? [])
        .flatMap((group) => [
            ...group.sessions,
            ...group.workspaces.flatMap((workspace) => workspace.sessions),
        ])
        .find((item) => item.id === sessionId)?.status;
}

async function readGlobalHello(endpoint: string): Promise<GlobalStreamHello> {
    const response = await fetch(`${endpoint}/catalog`, {
        headers: { authorization: "Bearer secret" },
    });
    if (!response.ok)
        throw new Error(`The catalog request failed with ${String(response.status)}.`);
    return (await response.json()) as GlobalStreamHello;
}

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-connect-git-"));
    started.push({ close: async () => rm(root, { force: true, recursive: true }) });
    await git(root, ["init", "--quiet", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "seed.txt"), "seed\n");
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "--quiet", "--message", "seed"]);
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", args, { cwd });
}

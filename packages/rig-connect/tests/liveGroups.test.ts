import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/server/InMemorySessionStore.js";
import { PersistentSessionStore } from "../../rig/sources/server/PersistentSessionStore.js";
import type { SessionStore } from "../../rig/sources/server/SessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import {
    createEventIdFactory,
    type ProjectWorkspace as DaemonProjectWorkspace,
} from "../../rig/sources/protocol/index.js";
import { connectGroups } from "@/connectGroups.js";
import type { GroupsConnection } from "@/connectGroups.js";
import type { GlobalStreamHello } from "@/protocol.js";

/**
 * These run against the real daemon rather than scripted frames, because the
 * point of the library is that the stream alone is sufficient. A fixture written
 * from assumptions about the wire proves only that the assumptions are
 * self-consistent.
 */

const started: { close: () => Promise<void> }[] = [];

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
): Promise<{ endpoint: string; store: TStore }> {
    const server = createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            closeStore?.();
        },
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

describe("rig-connect groups against a live daemon", () => {
    let connection: GroupsConnection | undefined;

    afterEach(() => {
        connection?.close();
        connection = undefined;
    });

    it("receives the groups that already exist on the opening frame", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-groups-a" });

        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");

        const projects = connection.projects();
        expect(projects.length).toBeGreaterThan(0);
        expect(projects.flatMap((group) => group.sessions.map((item) => item.id))).toContain(
            session.id,
        );
    });

    it("keeps open terminal tabs in the live group stream", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-terminal-groups" });
        const { projectId } = session.projectIdentity();

        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");

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
                    ?.remoteTerminals()
                    .some(
                        (group) =>
                            group.projectId === projectId &&
                            group.terminals.some((terminal) => terminal.id === created.terminal.id),
                    ) === true,
            "the terminal tab to appear",
        );
    });

    it("adds a session created after the client attached", async () => {
        const { endpoint, store } = await startDaemon();
        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");

        const created = store.create({ cwd: "/tmp/rig-groups-late" });

        // Everything needed to place this session in the tree has to arrive on
        // the stream; the library must not go asking for it.
        await waitFor(
            () =>
                (connection?.projects() ?? []).some((group) =>
                    [...group.sessions, ...group.workspaces.flatMap((w) => w.sessions)].some(
                        (item) => item.id === created.id,
                    ),
                ),
            "the new session to appear in the tree",
        );
    });

    it("never lists one session in two places", async () => {
        const { endpoint, store } = await startDaemon();
        const first = store.create({ cwd: "/tmp/rig-groups-a" });
        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");

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

    it("reports the status the daemon reports, rather than guessing from run events", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-groups-status" });
        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");
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
    });

    it("keeps persistent group drafts and usage live", async () => {
        const persistent = new PersistentSessionStore({ databasePath: ":memory:" });
        const { endpoint, store } = await startServer(persistent, () => persistent.close());
        const session = store.create({ cwd: "/tmp/rig-live-group-facts" });
        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");

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
                    ?.projects()
                    .flatMap((project) => project.sessions)
                    .find((candidate) => candidate.id === session.id)?.draft === "Live draft",
            "the draft to update",
        );
        await waitFor(
            () =>
                connection
                    ?.projects()
                    .find((project) => project.id === session.snapshot().projectId)?.usage
                    .totalTokens === 40,
            "the usage to update",
        );
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

        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");
        expect(listedSessionIds(connection)).toEqual(
            expect.arrayContaining(active.map((session) => session.id)),
        );
        expect(listedSessionIds(connection)).toHaveLength(active.length);
    });

    it("keeps a session listed when it is unarchived rather than dropping it", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-groups-a" });
        connection = connectGroups({
            endpoint,
            onChange: () => undefined,
            token: "secret",
        });
        await waitFor(() => connection?.state().connection === "live", "the stream to open");

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

function listedSessionIds(connection: GroupsConnection | undefined): string[] {
    return (connection?.projects() ?? []).flatMap((group) => [
        ...group.sessions.map((item) => item.id),
        ...group.workspaces.flatMap((workspace) => workspace.sessions.map((item) => item.id)),
    ]);
}

function listedStatus(
    connection: GroupsConnection | undefined,
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
    const controller = new AbortController();
    const response = await fetch(`${endpoint}/events/stream`, {
        headers: { accept: "text/event-stream", authorization: "Bearer secret" },
        signal: controller.signal,
    });
    if (response.body === null) throw new Error("The group stream carried no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
        for (;;) {
            const boundary = text.indexOf("\n\n");
            if (boundary !== -1) {
                const frame = text.slice(0, boundary);
                text = text.slice(boundary + 2);
                if (frame.includes("event: hello")) {
                    const data = frame
                        .split("\n")
                        .find((line) => line.startsWith("data: "))
                        ?.slice("data: ".length);
                    if (data === undefined) {
                        throw new Error("The group stream opening frame carried no data.");
                    }
                    return JSON.parse(data) as GlobalStreamHello;
                }
                continue;
            }
            const next = await reader.read();
            if (next.done) throw new Error("The group stream carried no opening frame.");
            text += decoder.decode(next.value, { stream: true });
        }
    } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
    }
}

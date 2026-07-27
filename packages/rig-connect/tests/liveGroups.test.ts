import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/server/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import { connectGroups } from "@/connectGroups.js";
import type { GroupsConnection } from "@/connectGroups.js";

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
    const server = createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
        await session.waitForRun(submitted.runId);

        // The daemon settles this session at the status it decides on. Deriving
        // one from run events instead would put a different word in the sidebar
        // than the one the session actually holds.
        await waitFor(
            () => listedStatus(connection, session.id) === session.snapshot().status,
            `the listed status to match the daemon's ${session.snapshot().status}`,
        );
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

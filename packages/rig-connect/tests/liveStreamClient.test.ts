import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import { createTestRootContext } from "../../rig/sources/testing/createTestRootContext.js";
import { streamLiveEvents, type LiveStreamHello } from "@/streamLiveEvents.js";
import type { GlobalEvent } from "@/protocol.js";

const started: { close: () => Promise<void> }[] = [];
const ctx = createTestRootContext();
const controllers: AbortController[] = [];
const stores = new Set<InMemorySessionStore>();

afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    for (const server of started.splice(0)) await server.close();
    for (const store of stores) await store.close(ctx);
    stores.clear();
});

/** Serves one store, and can be stopped and restarted on the same port. */
async function startDaemon(store: InMemorySessionStore, port = 0) {
    stores.add(store);
    const server = await createProtocolHttpServer(ctx, { store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    const stop = async () => {
        // A stream this test is deliberately following keeps its socket open, and
        // `close` alone waits for it. Dropping the connections is what a
        // restarting daemon does to its clients.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    started.push({ close: stop });
    return { endpoint: `http://127.0.0.1:${address.port}`, port: address.port, stop };
}

interface Follower {
    events: { cursor: string; event: GlobalEvent }[];
    opens: LiveStreamHello[];
    drops: unknown[];
}

function follow(endpoint: string): Follower {
    const controller = new AbortController();
    controllers.push(controller);
    const follower: Follower = { drops: [], events: [], opens: [] };
    void streamLiveEvents({
        endpoint,
        onDisconnected: (error) => follower.drops.push(error),
        onEvent: (event, cursor) => follower.events.push({ cursor, event }),
        onOpen: (hello) => follower.opens.push(hello),
        signal: controller.signal,
        token: "secret",
    }).catch(() => undefined);
    return follower;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

describe("following the live stream", () => {
    it("reports the position before any entity is loaded", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { endpoint } = await startDaemon(store);
        const follower = follow(endpoint);

        await waitFor(() => follower.opens.length > 0, "the stream to open");
        expect(follower.opens[0]!.gap).toBe(false);
        expect(follower.opens[0]!.resumed).toBe(false);
        expect(typeof follower.opens[0]!.cursor).toBe("string");
    });

    it("delivers events in cursor order and never repeats one", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { endpoint } = await startDaemon(store);
        const follower = follow(endpoint);
        await waitFor(() => follower.opens.length > 0, "the stream to open");

        const session = await store.create(ctx, { cwd: "/tmp/rig-live-client" });
        await session.setDraft(ctx, { draft: "typed", updatedAt: Date.now() });
        await session.setArchived(ctx, true);
        await waitFor(() => follower.events.length >= 3, "the events to arrive");

        const cursors = follower.events.map((entry) => entry.cursor);
        expect([...cursors].sort()).toEqual(cursors);
        expect(new Set(cursors).size).toBe(cursors.length);
    });

    it("resumes across a daemon restart and reports the gap", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const first = await startDaemon(store);
        const follower = follow(first.endpoint);
        await waitFor(() => follower.opens.length > 0, "the stream to open");

        await store.create(ctx, { cwd: "/tmp/rig-live-restart" });
        await waitFor(() => follower.events.length > 0, "the first event");
        await first.stop();
        await waitFor(() => follower.drops.length > 0, "the drop to be reported");

        // A fresh store on the same port is a restarted daemon: it has never
        // issued the cursor the client holds, so it must answer with a gap
        // rather than pretend the client is caught up.
        const restarted = await InMemorySessionStore.open(ctx);
        await startDaemon(restarted, first.port);
        await waitFor(() => follower.opens.length > 1, "the stream to reopen");

        const reopened = follower.opens.at(-1)!;
        expect(reopened.gap).toBe(true);
        expect(reopened.resumed).toBe(false);

        // And the stream keeps working, which is what makes a gap a recovery
        // path rather than a dead end.
        await restarted.create(ctx, { cwd: "/tmp/rig-live-after-restart" });
        const before = follower.events.length;
        await waitFor(() => follower.events.length > before, "events after the restart");
    });

    it("stops following once the caller aborts", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { endpoint } = await startDaemon(store);
        const controller = new AbortController();
        const follower: LiveStreamHello[] = [];
        const finished = streamLiveEvents({
            endpoint,
            onDisconnected: () => undefined,
            onEvent: () => undefined,
            onOpen: (hello) => follower.push(hello),
            signal: controller.signal,
            token: "secret",
        });

        await waitFor(() => follower.length > 0, "the stream to open");
        controller.abort();
        await expect(finished).resolves.toBeUndefined();
    });

    it("gives up when the daemon refuses the request outright", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const { endpoint } = await startDaemon(store);
        const controller = new AbortController();
        controllers.push(controller);

        // A bad token is refused on every attempt, so retrying is pointless and
        // the loop has to surface it rather than spin.
        await expect(
            streamLiveEvents({
                endpoint,
                onDisconnected: () => undefined,
                onEvent: () => undefined,
                onOpen: () => undefined,
                signal: controller.signal,
                token: "wrong",
            }),
        ).rejects.toThrow();
    });
});

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/server/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import type { SessionStateResponse } from "@/protocol.js";
import { connectSession } from "@/connectSession.js";
import type { SessionConnection } from "@/connectSession.js";

/**
 * What happens to a conversation when the stream drops and the daemon can no
 * longer serve the position the client held.
 *
 * Run against the real daemon: a mock would only prove the mock agrees with
 * itself about a recovery path whose whole point is what the daemon really does.
 */

const started: { close: () => Promise<void> }[] = [];

afterEach(async () => {
    for (const server of started.splice(0)) await server.close();
});

async function startDaemon(port = 0) {
    const store = new InMemorySessionStore();
    return serve(store, port);
}

async function serve(store: InMemorySessionStore, port = 0) {
    const server = createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    const stop = async () => {
        // A followed stream holds its socket open, and `close` alone waits for it.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    started.push({ close: stop });
    return { endpoint: `http://127.0.0.1:${address.port}`, port: address.port, stop, store };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

function userMessages(connection: SessionConnection | undefined): string[] {
    return (connection?.elements() ?? [])
        .filter((element) => element.kind === "user_message")
        .map((element) => JSON.stringify(element));
}

describe("a chat that loses its place", () => {
    let connection: SessionConnection | undefined;

    afterEach(() => {
        connection?.close();
        connection = undefined;
    });

    it("recovers messages sent while the client was disconnected", async () => {
        const first = await startDaemon();
        const session = first.store.create({ cwd: "/tmp/rig-chat-gap" });
        session.submit({ text: "Before the drop." });

        connection = connectSession({
            endpoint: first.endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");
        await waitFor(() => userMessages(connection).length === 1, "the first message");

        // The daemon goes away, and a message is submitted while nobody is
        // listening. This is the case the client cannot have observed live.
        await first.stop();
        await waitFor(
            () => connection?.session().connection === "reconnecting",
            "the drop to be noticed",
        );
        session.submit({ text: "During the drop." });

        // The same store comes back on the same port, so the session and its log
        // survive: the client's cursor is still serveable and the stream resumes.
        await serve(first.store, first.port);
        await waitFor(() => connection?.session().connection === "live", "the stream to reopen");
        await waitFor(
            () => userMessages(connection).length === 2,
            "the message sent during the outage to arrive",
        );
    });

    it("catches up from the message the client holds instead of resending the chat", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-chat-catchup" });
        const auth = { authorization: "Bearer secret" };
        for (const text of ["One.", "Two.", "Three.", "Four."]) {
            session.submit({ text });
        }

        const full = (await (
            await fetch(`${endpoint}/sessions/${session.id}/state`, { headers: auth })
        ).json()) as SessionStateResponse;
        expect(full.append).toBeUndefined();
        const messages = full.transcript!.messages;
        expect(full.session!.snapshot.messages).toEqual([]);
        expect(messages.length).toBeGreaterThanOrEqual(4);

        // The client already holds everything up to the second message, and says
        // so. Only what follows should come back.
        const anchor = full.transcript!.messageEventId![messages[1]!.id]!;
        expect(anchor).toBeDefined();
        const caught = (await (
            await fetch(`${endpoint}/sessions/${session.id}/state?after=${anchor}`, {
                headers: auth,
            })
        ).json()) as SessionStateResponse;
        expect(caught.append).toBe(true);
        const caughtTexts = JSON.stringify(caught.transcript!.messages);
        expect(caughtTexts).toContain("Four.");
        expect(caughtTexts).not.toContain("One.");
        expect(caught.transcript!.messages.length).toBeLessThan(messages.length);
    });

    it("refuses a cursor it cannot serve, and serves the whole chat when asked fresh", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-chat-cursor" });
        session.submit({ text: "Only message." });
        const auth = { authorization: "Bearer secret" };

        // A cursor from another daemon's scope is exactly what a client holds
        // after a restart, and it cannot be resumed from this log.
        const foreign = "ffffffff-ffff-7fff-bfff-ffffffffffff";
        const refused = await fetch(`${endpoint}/sessions/${session.id}/stream?after=${foreign}`, {
            headers: { accept: "text/event-stream", ...auth },
        });
        expect(refused.status).toBe(409);
        await refused.text();

        // Attaching fresh is the recovery path, and it must carry the
        // conversation itself rather than only telling the client to look again.
        const controller = new AbortController();
        const fresh = await fetch(`${endpoint}/sessions/${session.id}/stream`, {
            headers: { accept: "text/event-stream", ...auth },
            signal: controller.signal,
        });
        expect(fresh.status).toBe(200);
        const reader = fresh.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (!text.includes("Only message.") && text.length < 200_000) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
        }
        controller.abort();
        expect(text).toContain("Only message.");
    });
});

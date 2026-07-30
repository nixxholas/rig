import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../rig/sources/session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import { readSseFrames } from "@/sseFrames.js";

/**
 * The live stream is exercised against the real daemon, because the point of it
 * is that one subscription is enough for a client. A scripted fixture would only
 * prove the fixture agrees with itself.
 */

const started: { close: () => Promise<void> }[] = [];
const openStreams: AbortController[] = [];

afterEach(async () => {
    for (const controller of openStreams.splice(0)) controller.abort();
    for (const server of started.splice(0)) await server.close();
});

async function startDaemon(): Promise<{ endpoint: string; store: InMemorySessionStore }> {
    const store = new InMemorySessionStore();
    const server = createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

interface Frame {
    name: string | undefined;
    data: Record<string, unknown>;
}

/** Opens the stream and collects frames in the background until aborted. */
async function openStream(
    endpoint: string,
    after?: string,
): Promise<{ frames: Frame[]; hello: Frame }> {
    const controller = new AbortController();
    openStreams.push(controller);
    const url = new URL("/events/live", endpoint);
    if (after !== undefined) url.searchParams.set("after", after);
    const response = await fetch(url, {
        headers: { accept: "text/event-stream", authorization: "Bearer secret" },
        signal: controller.signal,
    });
    expect(response.status).toBe(200);
    if (response.body === null) throw new Error("The live stream carried no body.");

    const frames: Frame[] = [];
    let resolveHello: (frame: Frame) => void = () => undefined;
    const helloPromise = new Promise<Frame>((resolve) => (resolveHello = resolve));
    void (async () => {
        try {
            for await (const frame of readSseFrames(response.body!)) {
                const parsed = { data: frame.data as Record<string, unknown>, name: frame.name };
                if (parsed.name === "hello") resolveHello(parsed);
                else frames.push(parsed);
            }
        } catch {
            // Aborting the stream at the end of a test is the normal way it ends.
        }
    })();
    return { frames, hello: await helloPromise };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

describe("the live event stream", () => {
    it("opens with a cursor and no entity payload", async () => {
        const { endpoint } = await startDaemon();
        const { hello } = await openStream(endpoint);

        expect(typeof hello.data.cursor).toBe("string");
        expect(hello.data.gap).toBe(false);
        expect(hello.data.resumed).toBe(false);
        // The whole point: entities travel by request-response, never in the stream.
        expect(Object.keys(hello.data).sort()).toEqual([
            "cursor",
            "gap",
            "protocolVersion",
            "resumed",
        ]);
    });

    it("delivers session events as light updates carrying a cursor", async () => {
        const { endpoint, store } = await startDaemon();
        const { frames } = await openStream(endpoint);

        const session = store.create({ cwd: "/tmp/rig-live-stream" });
        await waitFor(() => frames.some((frame) => frame.name === "update"), "an update to arrive");

        const update = frames.find(
            (frame) => (frame.data.event as { sessionId?: string }).sessionId === session.id,
        );
        expect(update).toBeDefined();
        expect(typeof update!.data.cursor).toBe("string");
        expect(update!.data.event).toHaveProperty("type");
    });

    it("carries live-only events the durable log drops", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-live-draft" });
        const { frames } = await openStream(endpoint);

        session.setDraft({ draft: "typed", updatedAt: Date.now() });
        await waitFor(
            () =>
                frames.some(
                    (frame) =>
                        (frame.data.event as { type?: string }).type === "session_draft_changed",
                ),
            "the draft event to arrive",
        );
    });

    it("resumes from a cursor without repeating what was already delivered", async () => {
        const { endpoint, store } = await startDaemon();
        const first = await openStream(endpoint);
        const session = store.create({ cwd: "/tmp/rig-live-resume" });
        await waitFor(() => first.frames.length > 0, "the first update");
        const resumeFrom = first.frames.at(-1)!.data.cursor as string;
        const alreadySeen = new Set(first.frames.map((frame) => frame.data.cursor));

        session.setArchived(true);
        const resumed = await openStream(endpoint, resumeFrom);
        expect(resumed.hello.data.gap).toBe(false);
        expect(resumed.hello.data.resumed).toBe(true);
        await waitFor(() => resumed.frames.length > 0, "the missed event to replay");

        for (const frame of resumed.frames) {
            expect(alreadySeen.has(frame.data.cursor)).toBe(false);
            expect(String(frame.data.cursor) > resumeFrom).toBe(true);
        }
    });

    it("reports a gap for a cursor it can no longer serve, and keeps streaming", async () => {
        const { endpoint, store } = await startDaemon();
        const stale = "00000000-0000-7000-8000-000000000000";
        const { frames, hello } = await openStream(endpoint, stale);

        expect(hello.data.gap).toBe(true);
        expect(hello.data.resumed).toBe(false);
        expect(typeof hello.data.cursor).toBe("string");

        // A gap tells the client to re-fetch; the stream itself stays usable.
        store.create({ cwd: "/tmp/rig-live-gap" });
        await waitFor(() => frames.length > 0, "the stream to keep delivering after a gap");
    });

    it("refuses a cursor that is not a cursor", async () => {
        const { endpoint } = await startDaemon();
        const response = await fetch(`${endpoint}/events/live?after=nonsense`, {
            headers: { accept: "text/event-stream", authorization: "Bearer secret" },
        });
        expect(response.status).toBe(400);
        await response.text();
    });

    it("requires the token", async () => {
        const { endpoint } = await startDaemon();
        const response = await fetch(`${endpoint}/events/live`, {
            headers: { accept: "text/event-stream" },
        });
        expect(response.status).toBe(401);
        await response.text();
    });
});

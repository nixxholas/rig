import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { GlobalStreamHello } from "../protocol/index.js";
import { createProtocolHttpServer } from "./createProtocolHttpServer.js";
import { InMemorySessionStore } from "./InMemorySessionStore.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("global stream hello", () => {
    it("opens the group stream with the groups, so no snapshot call is needed", async () => {
        const fixture = await startServer();
        const session = fixture.store.create({ cwd: "/tmp/rig-group-a" });

        const stream = await fixture.openStream("/events/stream");
        const hello = await stream.hello();

        expect(hello.projects.length).toBeGreaterThan(0);
        expect(hello.sessions.map((summary) => summary.id)).toContain(session.id);
        expect(hello.sessionsComplete).toBe(true);
        expect(hello.cursor).toBe(fixture.store.globalEventQueue.cursor());
        stream.close();
    });

    it("does not replay the log a client attaching fresh was just given", async () => {
        const fixture = await startServer();
        fixture.store.create({ cwd: "/tmp/rig-group-a" });
        fixture.store.create({ cwd: "/tmp/rig-group-b" });

        const stream = await fixture.openStream("/events/stream");
        const hello = await stream.hello();
        await stream.settle();

        // The hello frame already reflects every event through its cursor, so
        // replaying the log on top of it would send the same state twice.
        const replayed = stream.frames.filter(
            (frame) => frame.includes("session_created") || frame.includes("project_created"),
        );
        expect(hello.sessions).toHaveLength(2);
        expect(replayed).toEqual([]);
        stream.close();
    });

    it("sends events that happen after the opening frame", async () => {
        const fixture = await startServer();
        const stream = await fixture.openStream("/events/stream");
        await stream.hello();

        const created = fixture.store.create({ cwd: "/tmp/rig-group-late" });
        await stream.waitForText(created.id);

        expect(stream.frames.join("")).toContain(created.id);
        stream.close();
    });

    it("omits the group state from a stream a client is resuming", async () => {
        const fixture = await startServer();
        fixture.store.create({ cwd: "/tmp/rig-group-a" });
        const cursor = fixture.store.globalEventQueue.cursor();

        const stream = await fixture.openStream(
            `/events/stream?after=${encodeURIComponent(cursor)}`,
        );
        const created = fixture.store.create({ cwd: "/tmp/rig-group-late" });
        await stream.waitForText(created.id);

        // A resuming client already holds the group state; sending it again
        // would be the fan-out the stream exists to remove.
        expect(stream.frames.some((frame) => frame.startsWith("event: hello"))).toBe(false);
        stream.close();
    });
});

async function startServer(): Promise<{
    openStream: (path: string) => Promise<{
        close: () => void;
        frames: string[];
        hello: () => Promise<GlobalStreamHello>;
        settle: () => Promise<void>;
        waitForText: (text: string) => Promise<void>;
    }>;
    store: InMemorySessionStore;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-group-stream-"));
    const socketPath = join(root, "server.sock");
    const store = new InMemorySessionStore();
    const server: Server = createProtocolHttpServer({ store, token: "t" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { force: true, recursive: true });
    });

    const openStream = async (path: string) => {
        const frames: string[] = [];
        const call = httpRequest({
            headers: { accept: "text/event-stream", authorization: "Bearer t" },
            path,
            socketPath,
        });
        const response = await new Promise<any>((resolve, reject) => {
            call.on("response", resolve);
            call.on("error", reject);
            call.end();
        });
        let buffer = "";
        response.on("data", (chunk: Buffer) => {
            buffer += String(chunk);
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary < 0) break;
                frames.push(buffer.slice(0, boundary + 2));
                buffer = buffer.slice(boundary + 2);
            }
        });

        const waitFor = async (predicate: () => boolean, description: string) => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                if (predicate()) return;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`Timed out waiting for ${description}.`);
        };

        return {
            close: () => call.destroy(),
            frames,
            hello: async () => {
                await waitFor(
                    () => frames.some((frame) => frame.startsWith("event: hello")),
                    "the opening frame",
                );
                const frame = frames.find((candidate) => candidate.startsWith("event: hello"));
                const data = frame?.split("\n").find((line) => line.startsWith("data:"));
                return JSON.parse(data?.slice("data:".length) ?? "{}") as GlobalStreamHello;
            },
            // Lets anything the server would have replayed arrive before asserting
            // that it did not.
            settle: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
            waitForText: (text: string) =>
                waitFor(() => frames.join("").includes(text), `a frame mentioning ${text}`),
        };
    };

    return { openStream, store };
}

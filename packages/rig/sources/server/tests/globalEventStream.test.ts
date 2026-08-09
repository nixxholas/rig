import { request as httpRequest } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { GlobalStreamHello } from "../../protocol/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("global event stream", () => {
    it("carries only events, never the entities a client loads from the catalog", async () => {
        const fixture = await startServer();
        await fixture.store.create({ cwd: "/tmp/rig-group-a" });

        const stream = await fixture.openStream("/events/stream");
        await stream.settle();

        // Projects, workspaces and sessions are entities. Repeating them on every
        // attach is the fan-out this stream exists to remove, so nothing here
        // introduces the frame that used to carry them.
        expect(stream.frames.some((frame) => frame.startsWith("event: hello"))).toBe(false);
        stream.close();
    });

    it("answers the catalog with the groups a client renders immediately", async () => {
        const fixture = await startServer();
        const session = await fixture.store.create({ cwd: "/tmp/rig-group-a" });

        const catalog = await fixture.catalog();

        expect(catalog.projects.length).toBeGreaterThan(0);
        expect(catalog.sessions.map((summary) => summary.id)).toContain(session.id);
        expect(catalog.sessionsComplete).toBe(true);
        expect(catalog.catalog).toBeDefined();
        expect(catalog.identity).toBeDefined();
        // The cursor states the point in the live stream this snapshot reflects,
        // which is what lets a client rebase it onto whatever that stream
        // delivered while it was loading.
        expect(catalog.cursor).toBe(fixture.store.liveEvents.cursor());
    });

    it("replays the stored log to a client attaching without a cursor", async () => {
        const fixture = await startServer();
        const created = await fixture.store.create({ cwd: "/tmp/rig-group-a" });

        const stream = await fixture.openStream("/events/stream");
        await stream.waitForText(created.id);

        // A mirror that has never synced holds nothing, so the whole retained log
        // is what it needs.
        expect(stream.frames.join("")).toContain("session_created");
        stream.close();
    });

    it("yields between replay pages without losing or duplicating a concurrent event", async () => {
        const fixture = await startServer();
        const queue = fixture.store.globalEventQueue;
        for (let index = 0; index < 2_001; index += 1) {
            await queue.append({
                createdAt: index,
                data: { project: { id: `project-${index}` } as never },
                id: `stored-${index}` as never,
                projectId: `project-${index}`,
                type: "project_created",
            });
        }

        const stream = await fixture.openStream("/events/stream");
        const concurrent = await queue.append({
            createdAt: 2_001,
            data: { project: { id: "project-concurrent" } as never },
            id: "stored-concurrent" as never,
            projectId: "project-concurrent",
            type: "project_created",
        });
        queue.publish(concurrent);

        await stream.waitForEventCount(2_002);
        const text = stream.frames.join("");
        expect(text.match(/stored-concurrent/gu)).toHaveLength(1);
        expect(text).toContain("stored-0");
        expect(text).toContain("stored-2000");
        stream.close();
    });

    it("sends events that happen after a client attaches", async () => {
        const fixture = await startServer();
        const stream = await fixture.openStream("/events/stream");
        await stream.settle();

        const created = await fixture.store.create({ cwd: "/tmp/rig-group-late" });
        await stream.waitForText(created.id);

        expect(stream.frames.join("")).toContain(created.id);
        stream.close();
    });

    it("shares project updates with every authenticated peer", async () => {
        const fixture = await startServer();
        const stream = await fixture.openStream("/events/live", "aremotepeerinstance0000001");
        await stream.waitForText("event: hello");

        await fixture.store.create({ cwd: "/tmp/rig-shared-project" });
        await stream.waitForText("project_created");
        await stream.waitForText("session_created");

        expect(stream.frames.join("")).toContain("project_created");
        expect(stream.frames.join("")).toContain("session_created");
        stream.close();
    });

    it("resumes from a cursor without replaying what the client already holds", async () => {
        const fixture = await startServer();
        const earlier = await fixture.store.create({ cwd: "/tmp/rig-group-a" });
        const cursor = fixture.store.globalEventQueue.cursor();

        const stream = await fixture.openStream(
            `/events/stream?after=${encodeURIComponent(cursor)}`,
        );
        const created = await fixture.store.create({ cwd: "/tmp/rig-group-late" });
        await stream.waitForText(created.id);

        expect(stream.frames.join("")).not.toContain(earlier.id);
        stream.close();
    });

    it("refuses a cursor it cannot parse", async () => {
        const fixture = await startServer();

        const stream = await fixture.openStream("/events/stream?after=not-a-cursor");

        expect(stream.statusCode).toBe(400);
        stream.close();
    });
});

async function startServer(): Promise<{
    catalog: () => Promise<GlobalStreamHello>;
    openStream: (
        path: string,
        peerId?: string,
    ) => Promise<{
        close: () => void;
        frames: string[];
        settle: () => Promise<void>;
        statusCode: number;
        waitForEventCount: (count: number) => Promise<void>;
        waitForText: (text: string) => Promise<void>;
    }>;
    store: InMemorySessionStore;
}> {
    const root = await createTestSocketDirectory();
    const socketPath = join(root, "server.sock");
    const store = await InMemorySessionStore.open();
    const server: Server = await createProtocolHttpServer({ store, token: "t" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.close();
        await rm(root, { force: true, recursive: true });
    });

    const catalog = async () => {
        const call = httpRequest({
            headers: { authorization: "Bearer t" },
            path: "/catalog",
            socketPath,
        });
        const body = await new Promise<string>((resolve, reject) => {
            call.on("response", (response) => {
                let text = "";
                response.on("data", (chunk: Buffer) => (text += String(chunk)));
                response.on("end", () => resolve(text));
            });
            call.on("error", reject);
            call.end();
        });
        return JSON.parse(body) as GlobalStreamHello;
    };

    const openStream = async (path: string, peerId?: string) => {
        const frames: string[] = [];
        const call = httpRequest({
            headers: {
                accept: "text/event-stream",
                authorization: "Bearer t",
                ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
            },
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
            // Lets anything the server would have sent arrive before asserting
            // that it did not.
            settle: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
            statusCode: response.statusCode as number,
            waitForEventCount: (count: number) =>
                waitFor(
                    () => frames.filter((frame) => frame.includes("data: ")).length >= count,
                    `${count} global event frames`,
                ),
            waitForText: (text: string) =>
                waitFor(() => frames.join("").includes(text), `a frame mentioning ${text}`),
        };
    };

    return { catalog, openStream, store };
}

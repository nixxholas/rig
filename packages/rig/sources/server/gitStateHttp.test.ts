import { execFile as execFileCallback } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createProtocolHttpServer } from "./createProtocolHttpServer.js";
import { GitStateTracker } from "../git/GitStateTracker.js";
import { InMemorySessionStore } from "../session/InMemorySessionStore.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Git state over HTTP", () => {
    it("serves a change snapshot for a project and keeps it warm", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await writeFile(join(repository, "a.txt"), "1\n2\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        const response = await fixture.get(`/projects/${projectId}/git`);

        expect(response.status).toBe(200);
        expect(response.body.git).toMatchObject({
            changedFiles: 1,
            comparison: "ready",
            insertions: 2,
            version: 1,
        });
        expect(response.body.git.generation).toBe(fixture.tracker.generation);
        // Asking is the demand signal, so the entity is now watched.
        expect(fixture.tracker.trackedKeys).toEqual([`project:${projectId}`]);
    });

    it("rescans on demand when the caller asks for a refresh", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        await fixture.get(`/projects/${projectId}/git`);

        await writeFile(join(repository, "new.txt"), "x\ny\nz\n");
        const stale = await fixture.get(`/projects/${projectId}/git`);
        const fresh = await fixture.get(`/projects/${projectId}/git?refresh=1`);

        expect(stale.body.git.changedFiles).toBe(0);
        expect(fresh.body.git.changedFiles).toBe(1);
        expect(fresh.body.git.insertions).toBe(3);
        expect(fresh.body.git.version).toBeGreaterThan(stale.body.git.version);
    });

    it("reports a missing project and an unknown workspace separately", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        expect((await fixture.get("/projects/nope/git")).status).toBe(404);
        expect((await fixture.get(`/projects/${projectId}/workspaces/nope/git`)).status).toBe(404);
    });

    it("starts watching the entities a client declares and returns their snapshots", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await writeFile(join(repository, "a.txt"), "1\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        const response = await fixture.post("/git/watch", { entities: [{ projectId }] });

        expect(response.status).toBe(200);
        expect(fixture.tracker.trackedKeys).toEqual([`project:${projectId}`]);
        await waitUntil(() => fixture.tracker.liveSnapshots().length === 1);
    });

    it("includes watched snapshots in the state bootstrap", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await writeFile(join(repository, "a.txt"), "1\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        await fixture.get(`/projects/${projectId}/git`);

        const state = await fixture.get("/state");

        // Without this a client that restarts has no counts at all until it asks per entity.
        expect(state.body.gitSnapshots).toHaveLength(1);
        expect(state.body.gitSnapshots[0].type).toBe("project_git_changed");
    });

    it("streams live snapshots without an event id and without moving the cursor", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await writeFile(join(repository, "a.txt"), "1\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        await fixture.get(`/projects/${projectId}/git`);
        // Background project initialization publishes durable events of its own, so the cursor is
        // only stable once it has settled; capturing before that races it.
        await waitUntil(
            () => fixture.store.getProject(projectId)?.initializationStatus !== "initializing",
        );
        const cursorBefore = fixture.store.globalEventQueue.cursor();

        const stream = await fixture.openStream("/events/stream");
        await stream.waitForFrames(1);

        const frame = stream.frames.find((text) => text.includes("project_git_changed"));
        expect(frame).toBeDefined();
        // A live frame carries no `id:`, so the client's Last-Event-Id keeps pointing at the last
        // durable position and a reconnect cannot skip stored events.
        expect(frame).not.toContain("id:");
        expect(fixture.store.globalEventQueue.cursor()).toBe(cursorBefore);
        stream.close();
    });

    it("replays current snapshots to a subscriber that connects later", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await writeFile(join(repository, "a.txt"), "1\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        await fixture.get(`/projects/${projectId}/git`);

        // Live events are never stored, so a subscriber arriving afterwards depends entirely on
        // the prelude to avoid showing stale counts.
        const stream = await fixture.openStream("/events/stream");
        await stream.waitForFrames(1);

        expect(stream.frames.join("")).toContain("project_git_changed");
        stream.close();
    });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for tracker state.");
}

async function startServer(): Promise<{
    get: (path: string) => Promise<{ body: any; status: number }>;
    post: (path: string, body: unknown) => Promise<{ body: any; status: number }>;
    openStream: (path: string) => Promise<{
        close: () => void;
        frames: string[];
        waitForFrames: (count: number) => Promise<void>;
    }>;
    root: string;
    store: InMemorySessionStore;
    tracker: GitStateTracker;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-git-http-"));
    const socketPath = join(root, "server.sock");
    const store = new InMemorySessionStore();
    const tracker = new GitStateTracker({
        onLiveEvent: (event) => store.globalEventQueue.publishLive(event),
        tuning: { debounceMs: 1, maximumDebounceMs: 5, reconcileIntervalMs: 60_000 },
    });
    const server: Server = createProtocolHttpServer({
        gitStateTracker: tracker,
        store,
        token: "t",
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        tracker.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { force: true, recursive: true });
    });

    const get = async (path: string) =>
        await new Promise<{ body: any; status: number }>((resolve, reject) => {
            const call = httpRequest(
                { headers: { authorization: "Bearer t" }, path, socketPath },
                (response) => {
                    let raw = "";
                    response.on("data", (chunk) => (raw += String(chunk)));
                    response.on("end", () =>
                        resolve({
                            body: raw.length === 0 ? undefined : JSON.parse(raw),
                            status: response.statusCode ?? 0,
                        }),
                    );
                },
            );
            call.on("error", reject);
            call.end();
        });

    const openStream = async (path: string) => {
        const frames: string[] = [];
        const call = httpRequest({
            headers: { accept: "text/event-stream", authorization: "Bearer t" },
            path,
            socketPath,
        });
        // Listeners are attached before the request is flushed; the other order can miss a
        // response that arrives immediately.
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
        return {
            close: () => call.destroy(),
            frames,
            waitForFrames: async (count: number) => {
                const deadline = Date.now() + 5_000;
                while (Date.now() < deadline) {
                    if (frames.filter((frame) => frame.includes("event:")).length >= count) return;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                throw new Error(`Timed out waiting for ${String(count)} SSE frames.`);
            },
        };
    };

    const post = async (path: string, body: unknown) =>
        await new Promise<{ body: any; status: number }>((resolve, reject) => {
            const payload = JSON.stringify(body);
            const call = httpRequest(
                {
                    headers: {
                        authorization: "Bearer t",
                        "content-length": Buffer.byteLength(payload),
                        "content-type": "application/json",
                    },
                    method: "POST",
                    path,
                    socketPath,
                },
                (response) => {
                    let raw = "";
                    response.on("data", (chunk) => (raw += String(chunk)));
                    response.on("end", () =>
                        resolve({
                            body: raw.length === 0 ? undefined : JSON.parse(raw),
                            status: response.statusCode ?? 0,
                        }),
                    );
                },
            );
            call.on("error", reject);
            call.write(payload);
            call.end();
        });

    return { get, openStream, post, root, store, tracker };
}

async function createRepository(root: string): Promise<string> {
    const repository = join(root, `repo-${String(Math.trunc(performance.now() * 1000))}`);
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    await writeFile(join(repository, "seed.txt"), "seed\n");
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", "seed"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000 });
}

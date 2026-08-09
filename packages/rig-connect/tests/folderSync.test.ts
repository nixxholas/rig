import { describe, expect, it } from "vitest";

import { connectRig } from "@/connectRig.js";
import type { Folder, GlobalStreamHello, SessionSummary } from "@/protocol.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}

function streamResponse() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(value) {
            controller = value;
        },
    });
    return {
        response: new Response(body, { status: 200 }),
        write: (frame: string) => controller.enqueue(encoder.encode(frame)),
    };
}

function folder(id: string, version = 1): Folder {
    return {
        createdAt: 1,
        id,
        name: id,
        orderKey: "a",
        path: `/folders/${id}`,
        updatedAt: version,
        version,
    };
}

function catalog(
    folders: readonly Folder[],
    sessions: readonly SessionSummary[] = [],
): GlobalStreamHello {
    return {
        catalog: {
            defaultModelId: "model",
            defaultProviderId: "codex",
            models: [],
            providers: [],
        },
        cursor: "01900000-0000-7000-8000-000000000001",
        folderItems: [],
        folders,
        identity: { version: "test" },
        presence: {
            presence: {
                answerWaitMs: null,
                emoji: "🟢",
                id: "online",
                prompt: "Online",
                title: "Online",
            },
            presences: [],
            since: 0,
        },
        projects: [],
        protocolVersion: 16,
        sessions,
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    };
}

function folderSession(
    id: string,
    scope: SessionSummary["scope"],
    lastEventId = "01900000-0000-7000-8000-000000000010",
): SessionSummary {
    return {
        archived: false,
        createdAt: 1,
        cwd: `/sessions/${id}`,
        id,
        lastEventId,
        modelId: "model",
        ownerInstanceId: "alocalinstance00000000001",
        orderKey: "a",
        permissionMode: "auto",
        providerId: "codex",
        scope,
        status: "idle",
        titleStatus: "idle",
        updatedAt: 1,
    };
}

function liveHello(): string {
    return `event: hello\ndata: ${JSON.stringify({
        cursor: "01900000-0000-7000-8000-000000000001",
        gap: false,
        protocolVersion: 16,
        resumed: false,
    })}\n\n`;
}

function changed(revision: number): string {
    return `event: update\ndata: ${JSON.stringify({
        cursor: `01900000-0000-7000-8000-${String(revision).padStart(12, "0")}`,
        event: {
            createdAt: revision,
            data: { revision },
            id: `01900000-0000-7000-8000-${String(revision).padStart(12, "0")}`,
            type: "folders_changed",
        },
    })}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("folder catalog synchronization", () => {
    it("loads and retains a private folder catalog for mutations without a subscriber", async () => {
        const requests: { ifMatch: string | null; method: string; path: string }[] = [];
        let authoritative = folder("private", 7);
        const updated = deferred();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                requests.push({
                    ifMatch: new Headers(init?.headers).get("if-match"),
                    method,
                    path,
                });
                if (path === "/folders" && method === "GET") {
                    return Response.json({
                        folders: [authoritative],
                        items: [],
                        revision: authoritative.version,
                    });
                }
                if (path === "/folders/private" && method === "PATCH") {
                    authoritative = { ...authoritative, name: "Updated", version: 8 };
                    updated.resolve();
                    return Response.json({ folder: authoritative, revision: 8 });
                }
                throw new Error(`Unexpected request to ${method} ${path}`);
            },
            token: "secret",
        });
        try {
            rig.folders.update("private", { name: "Updated" });
            await updated.promise;
            expect(requests.slice(0, 2)).toEqual([
                { ifMatch: null, method: "GET", path: "/folders" },
                { ifMatch: '"7"', method: "PATCH", path: "/folders/private" },
            ]);
        } finally {
            rig.close();
        }
    });

    it("does not let a stale catalog erase a newer revisioned folder snapshot", async () => {
        const stream = streamResponse();
        const releaseCatalog = deferred();
        const newest = folder("new");
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") {
                    await releaseCatalog.promise;
                    return Response.json(catalog([]));
                }
                if (path === "/folders") {
                    return Response.json({ folders: [newest], items: [], revision: 1 });
                }
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                throw new Error(`Unexpected request to ${path}`);
            },
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            stream.write(changed(1));
            await settle();
            expect(connection.view().folders.map((item) => item.id)).toEqual(["new"]);

            releaseCatalog.resolve();
            await settle();
            expect(connection.view().folders.map((item) => item.id)).toEqual(["new"]);
        } finally {
            rig.close();
        }
    });

    it("shows a create synchronously and holds a later update behind its authoritative snapshot", async () => {
        const stream = streamResponse();
        const releaseCreate = deferred();
        const requests: { method: string; path: string }[] = [];
        let authoritative = folder("created", 1);
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([]));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders" && method === "GET") {
                    return Response.json({
                        folders: [authoritative],
                        items: [],
                        revision: authoritative.version,
                    });
                }
                requests.push({ method, path });
                if (path === "/folders" && method === "POST") {
                    const body = JSON.parse(String(init?.body)) as { id: string };
                    await releaseCreate.promise;
                    authoritative = { ...authoritative, id: body.id };
                    return Response.json({ folder: authoritative, revision: 1 });
                }
                if (path.endsWith("/created") && method === "PATCH") {
                    authoritative = { ...authoritative, name: "Renamed", version: 2 };
                    return Response.json({ folder: authoritative, revision: 2 });
                }
                throw new Error(`Unexpected request to ${method} ${path}`);
            },
            randomValues: (bytes) => {
                bytes.fill(1);
                return bytes;
            },
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            const id = rig.folders.create({ id: "created", name: "Created" });
            rig.folders.update("created", { name: "Renamed" });

            expect(id).toBe("created");
            expect(connection.view().folders[0]?.name).toBe("Renamed");
            await settle();
            expect(requests).toEqual([{ method: "POST", path: "/folders" }]);

            releaseCreate.resolve();
            await settle();
            await settle();
            expect(requests).toEqual([
                { method: "POST", path: "/folders" },
                { method: "PATCH", path: "/folders/created" },
            ]);
        } finally {
            rig.close();
        }
    });

    it("shows newly started folder and Unsorted chats before either request completes", async () => {
        const stream = streamResponse();
        const never = deferred();
        const parent = folder("parent");
        let nextByte = 1;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([parent]));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders") {
                    return Response.json({ folders: [parent], items: [], revision: 1 });
                }
                if (path === "/sessions") {
                    await never.promise;
                    throw new Error("unreachable");
                }
                throw new Error(`Unexpected request to ${path}`);
            },
            randomValues: (bytes) => {
                bytes.fill(nextByte++);
                return bytes;
            },
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            rig.createSession({
                cwd: parent.path,
                scope: { folderId: parent.id, kind: "folder" },
            });
            rig.createSession({ cwd: "/unsorted", scope: { kind: "unsorted" } });

            expect(connection.view().folders[0]?.sessions).toHaveLength(1);
            expect(connection.view().unsorted).toHaveLength(1);
        } finally {
            rig.close();
        }
    });

    it("delivers a chat only after its optimistically created target folder commits", async () => {
        const stream = streamResponse();
        const releaseFolder = deferred();
        const requests: string[] = [];
        let createdFolder: Folder | undefined;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([]));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders" && method === "GET") {
                    return Response.json({
                        folders: createdFolder === undefined ? [] : [createdFolder],
                        items: [],
                        revision: createdFolder === undefined ? 0 : 1,
                    });
                }
                requests.push(`${method} ${path}`);
                if (path === "/folders" && method === "POST") {
                    const body = JSON.parse(String(init?.body)) as { id: string };
                    await releaseFolder.promise;
                    createdFolder = folder(body.id);
                    return Response.json({ folder: createdFolder, revision: 1 });
                }
                if (path === "/sessions" && method === "POST") {
                    return Response.json({
                        session: folderSession("chat", { folderId: "new-folder", kind: "folder" }),
                    });
                }
                throw new Error(`Unexpected request to ${method} ${path}`);
            },
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            rig.folders.create({ id: "new-folder", name: "New" });
            connection.close();
            rig.createSession({
                cwd: "/folders/new-folder",
                scope: { folderId: "new-folder", kind: "folder" },
            });
            await settle();
            expect(requests).toEqual(["POST /folders"]);

            releaseFolder.resolve();
            await settle();
            expect(requests).toEqual(["POST /folders", "POST /sessions"]);
        } finally {
            rig.close();
        }
    });

    it("rebases a same-folder ordering conflict and retries only with an authoritative session", async () => {
        const stream = streamResponse();
        const parent = folder("parent");
        const initial = folderSession("chat", { folderId: parent.id, kind: "folder" });
        let moves = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([parent], [initial]));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders") {
                    return Response.json({ folders: [parent], items: [], revision: 1 });
                }
                if (path === "/sessions/chat/scope") {
                    moves += 1;
                    const session = folderSession(
                        "chat",
                        { folderId: parent.id, kind: "folder" },
                        `01900000-0000-7000-8000-00000000001${moves}`,
                    );
                    return moves === 1
                        ? Response.json({ session }, { status: 409 })
                        : Response.json({ session });
                }
                throw new Error(`Unexpected request to ${init?.method ?? "GET"} ${path}`);
            },
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            rig.folders.moveSession("chat", {
                afterId: null,
                scope: { folderId: parent.id, kind: "folder" },
            });
            await settle();
            expect(moves).toBe(2);
        } finally {
            rig.close();
        }
    });

    it("rejects a generic placement conflict without spinning requests", async () => {
        const stream = streamResponse();
        const initial = folderSession("chat", { kind: "unsorted" });
        let moves = 0;
        const rejected: string[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([], [initial]));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders") {
                    return Response.json({ folders: [], items: [], revision: 0 });
                }
                if (path === "/sessions/chat/scope") {
                    moves += 1;
                    return Response.json(
                        { error: "The preceding chat is elsewhere." },
                        { status: 409 },
                    );
                }
                throw new Error(`Unexpected request to ${path}`);
            },
            onMutationRejected: (delta) => rejected.push(delta.mutationId),
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            rig.folders.moveSession("chat", { afterId: "elsewhere", scope: { kind: "unsorted" } });
            await settle();
            expect(moves).toBe(1);
            expect(rejected).toHaveLength(1);
        } finally {
            rig.close();
        }
    });
});

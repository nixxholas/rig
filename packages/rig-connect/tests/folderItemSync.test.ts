import { describe, expect, it } from "vitest";

import { connectRig } from "@/connectRig.js";
import type { Folder, FolderItem, GlobalStreamHello } from "@/protocol.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function streamResponse() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
        },
    });
    return {
        response: new Response(body, { status: 200 }),
        write: (frame: string) => controller.enqueue(encoder.encode(frame)),
    };
}

function folder(id: string, orderKey: string): Folder {
    return {
        createdAt: 1,
        id,
        name: id,
        orderKey,
        path: `/folders/${id}`,
        shared: false,
        updatedAt: 1,
        version: 1,
    };
}

function catalog(folders: readonly Folder[], items: readonly FolderItem[]): GlobalStreamHello {
    return {
        catalog: {
            defaultModelId: "model",
            defaultProviderId: "codex",
            models: [],
            providers: [],
        },
        cursor: "01900000-0000-7000-8000-000000000001",
        folderItems: items,
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
        protocolVersion: 17,
        sessions: [],
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    };
}

function liveHello(): string {
    return `event: hello\ndata: ${JSON.stringify({
        cursor: "01900000-0000-7000-8000-000000000001",
        gap: false,
        protocolVersion: 17,
        resumed: false,
    })}\n\n`;
}

function documentChanged(documentId: string, mutationId: string): string {
    const id = "01900000-0000-7000-8000-000000000002";
    return `event: update\ndata: ${JSON.stringify({
        cursor: id,
        event: {
            createdAt: 2,
            data: { documentId, mutationId, version: 1 },
            id,
            type: "document_changed",
        },
    })}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("folder item synchronization", () => {
    it("blocks a document item link until the pending create is acknowledged", async () => {
        const stream = streamResponse();
        const folderValue = folder("first", "a");
        const paths: string[] = [];
        let linkedItem: FolderItem | undefined;
        let revision = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([folderValue], []));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders" && method === "GET") {
                    return Response.json({
                        folders: [folderValue],
                        items: linkedItem === undefined ? [] : [linkedItem],
                        revision,
                    });
                }
                paths.push(`${method} ${path}`);
                if (path === "/documents" && method === "POST") {
                    return await new Promise<Response>((_resolve, reject) => {
                        const abort = () =>
                            reject(new DOMException("The request was aborted.", "AbortError"));
                        if (init?.signal?.aborted) abort();
                        else init?.signal?.addEventListener("abort", abort, { once: true });
                    });
                }
                if (path === "/folders/first/items" && method === "POST") {
                    revision = 1;
                    linkedItem = {
                        createdAt: 2,
                        folderId: "first",
                        id: "document-item",
                        orderKey: "a",
                        target: {
                            documentId: "pending-document",
                            kind: "document",
                        },
                        updatedAt: 2,
                        version: 1,
                    };
                    return Response.json({
                        item: linkedItem,
                        revision,
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
            rig.documents.create(
                { mimeType: "application/x-pending", state: {} },
                { documentId: "pending-document" },
            );
            rig.folders.linkItem(
                "first",
                {
                    target: {
                        documentId: "pending-document",
                        kind: "document",
                    },
                },
                { itemId: "document-item" },
            );
            await settle();

            expect(paths).toEqual(["POST /documents"]);

            stream.write(documentChanged("pending-document", "pending-document"));
            await settle();

            expect(paths).toEqual(["POST /documents", "POST /folders/first/items"]);
            expect(connection.view().folders[0]?.items).toHaveLength(1);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("rejects a document item dependency when the pending create fails", async () => {
        const stream = streamResponse();
        const releaseCreate = deferred<void>();
        const folderValue = folder("first", "a");
        const paths: string[] = [];
        const rejected: string[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog([folderValue], []));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders" && method === "GET") {
                    return Response.json({ folders: [folderValue], items: [], revision: 0 });
                }
                paths.push(`${method} ${path}`);
                if (path === "/documents" && method === "POST") {
                    await releaseCreate.promise;
                    return Response.json(
                        { error: { code: "invalid_request", message: "No." } },
                        { status: 400 },
                    );
                }
                throw new Error(`Unexpected request to ${method} ${path}`);
            },
            onMutationRejected: (delta) => rejected.push(delta.action),
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            rig.documents.create(
                { mimeType: "application/x-pending", state: {} },
                { documentId: "rejected-document" },
            );
            rig.folders.linkItem(
                "first",
                {
                    target: {
                        documentId: "rejected-document",
                        kind: "document",
                    },
                },
                { itemId: "rejected-item" },
            );
            await settle();
            expect(paths).toEqual(["POST /documents"]);

            releaseCreate.resolve();
            for (let attempt = 0; attempt < 4 && rejected.length < 2; attempt += 1) {
                await settle();
            }

            expect(paths).toEqual(["POST /documents"]);
            expect(rejected).toEqual(["create_document", "link_folder_item"]);
            expect(connection.view().folders[0]?.items).toEqual([]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("predicts link, move, and unlink while serializing their authoritative versions", async () => {
        const stream = streamResponse();
        const folders = [folder("first", "a"), folder("second", "b")];
        const releaseLink = deferred<void>();
        const releaseMove = deferred<void>();
        const releaseUnlink = deferred<void>();
        const mutations: {
            body: unknown;
            ifMatch: string | null;
            method: string;
            path: string;
        }[] = [];
        let authoritativeItems: readonly FolderItem[] = [];
        let revision = 0;

        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") return Response.json(catalog(folders, []));
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders" && method === "GET") {
                    return Response.json({
                        folders,
                        items: authoritativeItems,
                        revision,
                    });
                }
                const request = {
                    body:
                        init?.body === undefined
                            ? undefined
                            : (JSON.parse(String(init.body)) as unknown),
                    ifMatch: new Headers(init?.headers).get("if-match"),
                    method,
                    path,
                };
                mutations.push(request);
                if (path === "/folders/first/items") {
                    await releaseLink.promise;
                    revision = 1;
                    authoritativeItems = [
                        {
                            createdAt: 2,
                            folderId: "first",
                            id: "linked",
                            orderKey: "a",
                            target: { kind: "project", projectId: "project-1" },
                            updatedAt: 2,
                            version: 1,
                        },
                    ];
                    return Response.json({ item: authoritativeItems[0], revision });
                }
                if (path === "/folder-items/linked/move") {
                    await releaseMove.promise;
                    revision = 2;
                    authoritativeItems = [
                        {
                            ...authoritativeItems[0]!,
                            folderId: "second",
                            orderKey: "a",
                            updatedAt: 3,
                            version: 2,
                        },
                    ];
                    return Response.json({ item: authoritativeItems[0], revision });
                }
                if (path === "/folder-items/linked/archive") {
                    await releaseUnlink.promise;
                    revision = 3;
                    authoritativeItems = [
                        {
                            ...authoritativeItems[0]!,
                            archivedAt: 4,
                            updatedAt: 4,
                            version: 3,
                        },
                    ];
                    return Response.json({ item: authoritativeItems[0], revision });
                }
                throw new Error(`Unexpected request to ${method} ${path}`);
            },
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();

            const itemId = rig.folders.linkItem(
                "first",
                { target: { kind: "project", projectId: "project-1" } },
                { itemId: "linked" },
            );
            expect(itemId).toBe("linked");
            expect(connection.view().folders[0]?.items.map((item) => item.id)).toEqual(["linked"]);

            rig.folders.moveItem("linked", { afterId: null, folderId: "second" });
            expect(connection.view().folders[0]?.items).toEqual([]);
            expect(connection.view().folders[1]?.items.map((item) => item.id)).toEqual(["linked"]);

            rig.folders.unlinkItem("linked");
            expect(connection.view().folders.flatMap((item) => item.items)).toEqual([]);
            await settle();
            expect(mutations.map((request) => request.path)).toEqual(["/folders/first/items"]);

            releaseLink.resolve();
            await settle();
            expect(mutations.map((request) => request.path)).toEqual([
                "/folders/first/items",
                "/folder-items/linked/move",
            ]);
            expect(mutations[1]?.ifMatch).toBe('"1"');

            releaseMove.resolve();
            await settle();
            expect(mutations.map((request) => request.path)).toEqual([
                "/folders/first/items",
                "/folder-items/linked/move",
                "/folder-items/linked/archive",
            ]);
            expect(mutations[2]?.ifMatch).toBe('"2"');

            releaseUnlink.resolve();
            await settle();
            expect(mutations[0]?.body).toMatchObject({
                id: "linked",
                target: { kind: "project", projectId: "project-1" },
            });
            expect(connection.view().folders.flatMap((item) => item.items)).toEqual([]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("bounds repeated folder-item conflict rebases before rejecting", async () => {
        const stream = streamResponse();
        const folderValue = folder("first", "a");
        let current: FolderItem = {
            createdAt: 1,
            folderId: "first",
            id: "linked",
            orderKey: "a",
            target: { kind: "project", projectId: "project-1" },
            updatedAt: 1,
            version: 1,
        };
        let moves = 0;
        const rejected: string[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const method = init?.method ?? "GET";
                if (path === "/events/live") return stream.response;
                if (path === "/catalog") {
                    return Response.json(catalog([folderValue], [current]));
                }
                if (path === "/git/watch") return Response.json({ snapshots: [] });
                if (path === "/folders" && method === "GET") {
                    return Response.json({
                        folders: [folderValue],
                        items: [current],
                        revision: current.version,
                    });
                }
                if (path === "/folder-items/linked/move") {
                    moves += 1;
                    if (moves > 12) {
                        return Response.json(
                            { error: { code: "invalid_request", message: "Stop." } },
                            { status: 400 },
                        );
                    }
                    current = {
                        ...current,
                        updatedAt: current.updatedAt + 1,
                        version: current.version + 1,
                    };
                    return Response.json(
                        { item: current, revision: current.version },
                        { status: 409 },
                    );
                }
                throw new Error(`Unexpected request to ${method} ${path}`);
            },
            onMutationRejected: (delta) => rejected.push(delta.action),
            token: "secret",
        });
        const connection = rig.connectFolders({ onChange: () => undefined });
        try {
            stream.write(liveHello());
            await settle();
            rig.folders.moveItem("linked", { afterId: null, folderId: "first" });
            await settle();

            expect(moves).toBe(9);
            expect(rejected).toEqual(["move_folder_item"]);
        } finally {
            connection.close();
            rig.close();
        }
    });
});

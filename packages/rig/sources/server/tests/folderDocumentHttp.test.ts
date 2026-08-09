import { request as httpRequest, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEventIdFactory } from "../../protocol/index.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestFixtureDirectory } from "../../testing/createTestFixtureDirectory.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const LOCAL_INSTANCE_ID = "alocalinstance00000000001";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Folder items and documents over HTTP", () => {
    it("links duplicate targets and orders items only inside their containing folder", async () => {
        const fixture = await startServer();
        const left = await fixture.send("POST", "/folders", { name: "Left" });
        const right = await fixture.send("POST", "/folders", { name: "Right" });
        const document = await fixture.send("POST", "/documents", {
            mimeType: "application/x-happy-board",
            state: { cards: [] },
        });

        const first = await fixture.send("POST", `/folders/${left.body.folder.id}/items`, {
            target: { documentId: document.body.document.id, kind: "document" },
        });
        const duplicate = await fixture.send("POST", `/folders/${left.body.folder.id}/items`, {
            target: { documentId: document.body.document.id, kind: "document" },
        });
        const otherFolder = await fixture.send("POST", `/folders/${right.body.folder.id}/items`, {
            target: { documentId: document.body.document.id, kind: "document" },
        });

        expect([first.status, duplicate.status, otherFolder.status]).toEqual([201, 201, 201]);
        let catalog = await fixture.send("GET", "/folders");
        const itemsIn = (folderId: string) =>
            catalog.body.items
                .filter((item: { folderId: string }) => item.folderId === folderId)
                .map((item: { id: string; orderKey: string }) => [item.id, item.orderKey]);
        expect(itemsIn(left.body.folder.id)).toEqual([
            [first.body.item.id, "a0"],
            [duplicate.body.item.id, "a1"],
        ]);
        expect(itemsIn(right.body.folder.id)).toEqual([[otherFolder.body.item.id, "a0"]]);

        const moved = await fixture.send(
            "POST",
            `/folder-items/${duplicate.body.item.id}/move`,
            {
                afterId: otherFolder.body.item.id,
                folderId: right.body.folder.id,
            },
            { "if-match": String(duplicate.body.item.version) },
        );
        expect(moved.status).toBe(200);
        catalog = await fixture.send("GET", "/folders");
        expect(
            catalog.body.items
                .filter(
                    (item: { archivedAt?: number; folderId: string }) =>
                        item.archivedAt === undefined && item.folderId === right.body.folder.id,
                )
                .map((item: { id: string }) => item.id),
        ).toEqual([otherFolder.body.item.id, duplicate.body.item.id]);
    });

    it("removes only a link and keeps its document target", async () => {
        const fixture = await startServer();
        const folder = await fixture.send("POST", "/folders", { name: "Notes" });
        const document = await fixture.send("POST", "/documents", {
            mimeType: "application/x-happy-note",
            state: { text: "Keep me" },
        });
        const item = await fixture.send("POST", `/folders/${folder.body.folder.id}/items`, {
            target: { documentId: document.body.document.id, kind: "document" },
        });

        const archived = await fixture.send(
            "POST",
            `/folder-items/${item.body.item.id}/archive`,
            undefined,
            { "if-match": String(item.body.item.version) },
        );

        expect(archived.status).toBe(200);
        expect(archived.body.item.archivedAt).toEqual(expect.any(Number));
        expect((await fixture.send("GET", `/documents/${document.body.document.id}`)).body).toEqual(
            document.body,
        );
    });

    it("uses one idempotent CAS write for state, MIME, updates, and unread cursor", async () => {
        const fixture = await startServer();
        const initialCursor = uuid(1);
        const nextCursor = uuid(2);
        const created = await fixture.send(
            "POST",
            "/documents",
            {
                mimeType: "text/plain",
                mutationId: "create-document",
                state: "first",
                unreadCursor: initialCursor,
            },
            { "x-rig-mutation-id": "create-document" },
        );
        expect(created.status).toBe(201);
        expect(created.body.document).toMatchObject({
            createdBy: { instanceId: LOCAL_INSTANCE_ID },
            unreadCursor: initialCursor,
            version: 1,
        });

        const missingVersion = await fixture.send(
            "POST",
            `/documents/${created.body.document.id}/write`,
            { state: "second", update: { replace: "second" } },
        );
        expect(missingVersion.status).toBe(428);

        const firstWrite = await fixture.send(
            "POST",
            `/documents/${created.body.document.id}/write`,
            {
                mimeType: "text/markdown",
                mutationId: "write-document",
                state: "**second**",
                unreadCursor: nextCursor,
                update: { replace: "**second**" },
            },
            {
                "if-match": '"1"',
                "x-rig-mutation-id": "write-document",
            },
        );
        expect(firstWrite.status).toBe(200);
        expect(firstWrite.body.document).toMatchObject({
            mimeType: "text/markdown",
            state: "**second**",
            unreadCursor: nextCursor,
            version: 2,
        });

        const retried = await fixture.send(
            "POST",
            `/documents/${created.body.document.id}/write`,
            {
                mimeType: "text/markdown",
                mutationId: "write-document",
                state: "**second**",
                unreadCursor: nextCursor,
                update: { replace: "**second**" },
            },
            {
                "if-match": '"1"',
                "x-rig-mutation-id": "write-document",
            },
        );
        expect(retried.status).toBe(200);
        expect(retried.body.document.version).toBe(2);

        const updates = await fixture.send(
            "GET",
            `/documents/${created.body.document.id}/updates?afterVersion=1`,
        );
        expect(updates.status).toBe(200);
        expect(updates.body.updates).toHaveLength(1);
        expect(updates.body.updates[0]).toMatchObject({
            update: { replace: "**second**" },
            version: 2,
        });
        expect(
            (
                await fixture.send(
                    "GET",
                    `/documents/${created.body.document.id}/updates?afterVersion=not-a-version`,
                )
            ).status,
        ).toBe(400);

        const cleared = await fixture.send(
            "POST",
            `/documents/${created.body.document.id}/write`,
            {
                mutationId: "clear-unread",
                state: "**third**",
                unreadCursor: null,
                update: { replace: "**third**" },
            },
            {
                "if-match": '"2"',
                "x-rig-mutation-id": "clear-unread",
            },
        );
        expect(cleared.status).toBe(200);
        expect(cleared.body.document).toMatchObject({ state: "**third**", version: 3 });
        expect(cleared.body.document).not.toHaveProperty("unreadCursor");

        const unsupported = await fixture.send("PATCH", `/documents/${created.body.document.id}`, {
            state: "no",
        });
        expect(unsupported.status).toBe(405);
    });
});

async function startServer(): Promise<{
    send: (
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
    ) => Promise<{ body: any; status: number }>;
}> {
    const root = await createTestFixtureDirectory();
    const socketDirectory = await createTestSocketDirectory();
    const socketPath = join(socketDirectory, "server.sock");
    const store = await InMemorySessionStore.open({
        homeDirectory: root,
        localInstanceId: LOCAL_INSTANCE_ID,
    });
    const server: Server = await createProtocolHttpServer({ store, token: "t" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([
            rm(root, { force: true, recursive: true }),
            rm(socketDirectory, { force: true, recursive: true }),
        ]);
    });

    const send = async (
        method: string,
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
    ) =>
        await new Promise<{ body: any; status: number }>((resolve, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const call = httpRequest(
                {
                    headers: {
                        authorization: "Bearer t",
                        ...headers,
                        ...(payload === undefined
                            ? {}
                            : {
                                  "content-length": Buffer.byteLength(payload),
                                  "content-type": "application/json",
                              }),
                    },
                    method,
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
            if (payload !== undefined) call.write(payload);
            call.end();
        });

    return { send };
}

function uuid(now: number): string {
    return createEventIdFactory({ now: () => now })();
}

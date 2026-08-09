import { describe, expect, it } from "vitest";

import type { DocumentDelta } from "@/DocumentElement.js";
import { connectRig } from "@/connectRig.js";
import type { Document, DocumentUpdatePage } from "@/protocol.js";

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

function document(overrides: Partial<Document> = {}): Document {
    return {
        createdAt: 1,
        createdBy: { instanceId: "alocalinstance00000000001" },
        firstRetainedVersion: 1,
        id: "document-1",
        mimeType: "application/x-test",
        state: { text: "one" },
        updatedAt: 1,
        version: 1,
        ...overrides,
    };
}

function liveHello(
    cursor = "01900000-0000-7000-8000-000000000001",
    gap = false,
    resumed = false,
): string {
    return `event: hello\ndata: ${JSON.stringify({
        cursor,
        gap,
        protocolVersion: 15,
        resumed,
    })}\n\n`;
}

function documentChanged(version: number, mutationId?: string): string {
    const id = `01900000-0000-7000-8000-${String(version).padStart(12, "0")}`;
    return `event: update\ndata: ${JSON.stringify({
        cursor: id,
        event: {
            createdAt: version,
            data: {
                documentId: "document-1",
                version,
                ...(mutationId === undefined ? {} : { mutationId }),
            },
            id,
            type: "document_changed",
        },
    })}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("live document synchronization", () => {
    it("blocks an immediate document read until its pending create is accepted", async () => {
        const stream = streamResponse();
        const releaseCreate = deferred<void>();
        const paths: string[] = [];
        const created = document({
            id: "pending-document",
            mimeType: "application/x-pending",
            state: { pending: false },
        });
        let createCommitted = false;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const url = new URL(String(input));
                const method = init?.method ?? "GET";
                if (url.pathname === "/events/live") return stream.response;
                paths.push(`${method} ${url.pathname}`);
                if (url.pathname === "/documents" && method === "POST") {
                    await releaseCreate.promise;
                    createCommitted = true;
                    return Response.json({ document: created }, { status: 201 });
                }
                if (url.pathname === "/documents/pending-document" && method === "GET") {
                    expect(createCommitted).toBe(true);
                    return Response.json({ document: created });
                }
                throw new Error(`Unexpected request to ${method} ${url.pathname}`);
            },
            token: "secret",
        });
        rig.documents.create(
            { mimeType: "application/x-pending", state: { pending: true } },
            { documentId: "pending-document" },
        );
        const connection = rig.connectDocument({
            documentId: "pending-document",
            onChange: () => undefined,
        });
        try {
            stream.write(liveHello());
            await settle();
            expect(paths).toEqual(["POST /documents"]);

            releaseCreate.resolve();
            await settle();

            expect(paths).toEqual(["POST /documents", "GET /documents/pending-document"]);
            expect(connection.document()).toEqual(created);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("loads a snapshot, acknowledges a light event by reloading, creates, and loads updates", async () => {
        const stream = streamResponse();
        const releaseReload = deferred<void>();
        const deltas: DocumentDelta[] = [];
        const requests: { body: unknown; method: string; path: string; search: string }[] = [];
        let current = document();
        let documentReads = 0;

        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const url = new URL(String(input));
                const method = init?.method ?? "GET";
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/documents/document-1" && method === "GET") {
                    documentReads += 1;
                    if (documentReads === 2) await releaseReload.promise;
                    return Response.json({ document: current });
                }
                if (url.pathname === "/documents" && method === "POST") {
                    const body = JSON.parse(String(init?.body)) as {
                        id: string;
                        mimeType: string;
                        state: unknown;
                    };
                    requests.push({
                        body,
                        method,
                        path: url.pathname,
                        search: url.search,
                    });
                    return Response.json(
                        {
                            document: document({
                                id: body.id,
                                mimeType: body.mimeType,
                                state: body.state,
                            }),
                        },
                        { status: 201 },
                    );
                }
                if (url.pathname === "/documents/document-1/write" && method === "POST") {
                    requests.push({
                        body: JSON.parse(String(init?.body)) as unknown,
                        method,
                        path: url.pathname,
                        search: url.search,
                    });
                    return await new Promise<Response>((_resolve, reject) => {
                        const abort = () =>
                            reject(new DOMException("The request was aborted.", "AbortError"));
                        if (init?.signal?.aborted) abort();
                        else init?.signal?.addEventListener("abort", abort, { once: true });
                    });
                }
                if (url.pathname === "/documents/document-1/updates" && method === "GET") {
                    requests.push({
                        body: undefined,
                        method,
                        path: url.pathname,
                        search: url.search,
                    });
                    const page: DocumentUpdatePage = {
                        currentVersion: 2,
                        firstRetainedVersion: 1,
                        gap: false,
                        hasMore: false,
                        nextAfterVersion: 2,
                        updates: [
                            {
                                createdAt: 2,
                                documentId: "document-1",
                                id: "01900000-0000-7000-8000-000000000002",
                                update: { insert: "two" },
                                version: 2,
                            },
                        ],
                    };
                    return Response.json(page);
                }
                throw new Error(`Unexpected request to ${method} ${url.pathname}`);
            },
            token: "secret",
        });
        const connection = rig.connectDocument({
            documentId: "document-1",
            onChange: () => undefined,
            onDelta: (delta) => deltas.push(delta),
        });
        try {
            stream.write(liveHello());
            await settle();
            expect(connection.state().connection).toBe("live");
            expect(connection.document()).toEqual(current);

            const createdId = rig.documents.create(
                {
                    mimeType: "application/x-created",
                    state: { created: true },
                },
                { documentId: "created-document" },
            );
            expect(createdId).toBe("created-document");
            await settle();
            expect(requests[0]?.body).toMatchObject({
                id: "created-document",
                mimeType: "application/x-created",
                mutationId: "created-document",
            });

            const mutationId = rig.documents.write("document-1", 1, {
                state: { text: "two" },
                update: { insert: "two" },
            });
            expect(connection.document()).toMatchObject({
                state: { text: "two" },
                version: 2,
            });
            await settle();

            current = document({ state: { text: "two" }, updatedAt: 2, version: 2 });
            stream.write(documentChanged(2, mutationId));
            await settle();
            expect(connection.state().reloadNeeded).toBe(true);
            expect(documentReads).toBe(2);

            releaseReload.resolve();
            await settle();
            expect(connection.document()).toEqual(current);
            expect(connection.state().reloadNeeded).toBe(false);
            expect(
                deltas.some(
                    (delta) =>
                        delta.type === "mutation_rejected" && delta.mutationId === mutationId,
                ),
            ).toBe(false);

            const page = await rig.documents.loadUpdates("document-1", {
                afterVersion: 1,
                limit: 10,
            });
            expect(page.updates).toHaveLength(1);
            expect(connection.updates()).toEqual(page.updates);
            expect(requests.at(-1)?.search).toBe("?afterVersion=1&limit=10");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("replaces a strict CAS prediction with the authoritative conflict document", async () => {
        const stream = streamResponse();
        const deltas: DocumentDelta[] = [];
        const writes: { body: unknown; ifMatch: string | null }[] = [];
        const authoritative = document({
            state: { text: "somebody else" },
            updatedAt: 2,
            version: 2,
        });
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/documents/document-1" && init?.method === undefined) {
                    return Response.json({ document: document() });
                }
                if (url.pathname === "/documents/document-1/write") {
                    writes.push({
                        body: JSON.parse(String(init?.body)) as unknown,
                        ifMatch: new Headers(init?.headers).get("if-match"),
                    });
                    return Response.json({ document: authoritative }, { status: 409 });
                }
                throw new Error(`Unexpected request to ${init?.method ?? "GET"} ${url.pathname}`);
            },
            token: "secret",
        });
        const connection = rig.connectDocument({
            documentId: "document-1",
            onChange: () => undefined,
            onDelta: (delta) => deltas.push(delta),
        });
        try {
            stream.write(liveHello());
            await settle();

            const mutationId = rig.documents.write("document-1", 1, {
                state: { text: "mine" },
                update: { replace: "mine" },
            });
            expect(connection.document()).toMatchObject({
                state: { text: "mine" },
                version: 2,
            });
            await settle();

            expect(writes).toHaveLength(1);
            expect(writes[0]?.ifMatch).toBe('"1"');
            expect(writes[0]?.body).toMatchObject({
                mutationId,
                state: { text: "mine" },
            });
            expect(connection.document()).toEqual(authoritative);
            expect(deltas).toContainEqual({
                action: "write_document",
                message: "Rig rejected the change with status 409.",
                mutationId,
                type: "mutation_rejected",
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps queued CAS versions exact and reloads a held document after a stream gap", async () => {
        const stream = streamResponse();
        const releaseFirst = deferred<void>();
        const releaseSecond = deferred<void>();
        const writes: { ifMatch: string | null; state: unknown }[] = [];
        let current = document();
        let reads = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/documents/document-1" && init?.method === undefined) {
                    reads += 1;
                    return Response.json({ document: current });
                }
                if (url.pathname === "/documents/document-1/write") {
                    const body = JSON.parse(String(init?.body)) as { state: unknown };
                    writes.push({
                        ifMatch: new Headers(init?.headers).get("if-match"),
                        state: body.state,
                    });
                    if (writes.length === 1) {
                        await releaseFirst.promise;
                        current = document({ state: body.state, updatedAt: 2, version: 2 });
                    } else {
                        await releaseSecond.promise;
                        current = document({ state: body.state, updatedAt: 3, version: 3 });
                    }
                    return Response.json({ document: current });
                }
                throw new Error(`Unexpected request to ${init?.method ?? "GET"} ${url.pathname}`);
            },
            token: "secret",
        });
        const connection = rig.connectDocument({
            documentId: "document-1",
            onChange: () => undefined,
        });
        try {
            stream.write(liveHello());
            await settle();

            rig.documents.write("document-1", 1, {
                state: { text: "first" },
                update: { insert: "first" },
            });
            rig.documents.write("document-1", 2, {
                state: { text: "second" },
                update: { insert: "second" },
            });
            expect(connection.document()).toMatchObject({
                state: { text: "second" },
                version: 3,
            });
            await settle();
            expect(writes.map((write) => write.ifMatch)).toEqual(['"1"']);

            releaseFirst.resolve();
            await settle();
            expect(writes.map((write) => write.ifMatch)).toEqual(['"1"', '"2"']);
            expect(connection.document()).toMatchObject({
                state: { text: "second" },
                version: 3,
            });

            releaseSecond.resolve();
            await settle();
            expect(connection.document()).toEqual(current);

            current = document({ state: { text: "after gap" }, updatedAt: 4, version: 4 });
            stream.write(liveHello("01900000-0000-7000-8000-000000000004", true, false));
            await settle();
            expect(reads).toBe(2);
            expect(connection.document()).toEqual(current);
        } finally {
            connection.close();
            rig.close();
        }
    });
});

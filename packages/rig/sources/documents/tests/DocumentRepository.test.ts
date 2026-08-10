import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { createEventIdFactory } from "../../protocol/createEventIdFactory.js";
import {
    DOCUMENT_STATE_MAX_BYTES,
    DOCUMENT_UPDATE_MAX_BYTES,
    documentUpdatePageSchema,
    type DocumentEvent,
} from "../../protocol/DocumentProtocol.js";
import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { DocumentError, DocumentRepository } from "../DocumentRepository.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

describe("DocumentRepository", () => {
    it("rolls a document write back when its durable event cannot be stored", async () => {
        const rootCtx = createTestRootContext();
        const opened = await openSessionDatabase(rootCtx, ":memory:");
        await migrateSessionDatabase(opened.ctx);
        const failure = new Error("document event persistence failed");
        const repository = new DocumentRepository({
            database: opened.database,
            onEvent: async () => {
                throw failure;
            },
        });

        try {
            await expect(
                repository.createDocument(
                    opened.ctx,
                    { id: "adocument00000000000000001", mimeType: "text/plain", state: "draft" },
                    { instanceId: "alocalinstance00000000001" },
                ),
            ).rejects.toBe(failure);
            expect((await opened.client.execute("SELECT id FROM documents")).rows).toEqual([]);
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("stores canonical JSON and preserves immutable creation identity", async () => {
        const { ctx, events, opened, repository } = await fixture();
        const unreadCursor = createEventIdFactory({ now: () => 2 })();

        const request = {
            id: "adocument00000000000000001",
            mimeType: "application/x-board",
            mutationId: "create",
            state: { z: 1, a: { y: 2, x: 3 } },
            unreadCursor,
        };
        const createdBy = {
            instanceId: "alocalinstance00000000001",
            profileId: "aprofile000000000000000001",
        };
        const document = await repository.createDocument(ctx, request, createdBy);
        const retry = await repository.createDocument(ctx, request, createdBy);

        expect(document).toMatchObject({
            createdBy: {
                instanceId: "alocalinstance00000000001",
                profileId: "aprofile000000000000000001",
            },
            firstRetainedVersion: 2,
            unreadCursor,
            version: 1,
        });
        expect(
            (
                await opened.client.execute(
                    "SELECT state_json FROM documents WHERE id = 'adocument00000000000000001'",
                )
            ).rows[0],
        ).toEqual({ state_json: '{"a":{"x":3,"y":2},"z":1}' });
        expect(events).toHaveLength(1);
        expect(retry).toEqual(document);
        await opened.database.close(opened.ctx);
    });

    it("bounds serialized state and updates", async () => {
        const { ctx, opened, repository } = await fixture();
        const document = await repository.createDocument(
            ctx,
            { mimeType: "text/plain", state: "" },
            { instanceId: "alocalinstance00000000001" },
        );

        await expect(
            repository.createDocument(
                ctx,
                { mimeType: "text/plain", state: "x".repeat(DOCUMENT_STATE_MAX_BYTES) },
                { instanceId: "alocalinstance00000000001" },
            ),
        ).rejects.toThrowError(DocumentError);
        await expect(
            repository.writeDocument(
                ctx,
                document.id,
                {
                    state: "next",
                    update: "x".repeat(DOCUMENT_UPDATE_MAX_BYTES),
                },
                1,
            ),
        ).rejects.toThrowError(DocumentError);
        expect((await repository.getDocument(ctx, document.id))?.version).toBe(1);
        await opened.database.close(opened.ctx);
    });

    it("publishes only after a successful non-retry CAS write", async () => {
        const { ctx, events, opened, repository } = await fixture();
        const document = await repository.createDocument(
            ctx,
            { mimeType: "text/plain", mutationId: "create", state: "a" },
            { instanceId: "alocalinstance00000000001" },
        );
        events.length = 0;

        const first = await repository.writeDocument(
            ctx,
            document.id,
            { mutationId: "write", state: "b", update: { replace: "b" } },
            1,
        );
        const retry = await repository.writeDocument(
            ctx,
            document.id,
            { mutationId: "write", state: "b", update: { replace: "b" } },
            1,
        );

        expect(first?.version).toBe(2);
        expect(retry).toEqual(first);
        expect(events).toHaveLength(1);
        expect(
            Value.Check(
                documentUpdatePageSchema,
                await repository.documentUpdates(ctx, document.id, { afterVersion: 1 }),
            ),
        ).toBe(true);
        await opened.database.close(opened.ctx);
    });
});

async function fixture(): Promise<{
    ctx: Awaited<ReturnType<typeof openSessionDatabase>>["ctx"];
    events: DocumentEvent[];
    opened: Awaited<ReturnType<typeof openSessionDatabase>>;
    repository: DocumentRepository;
}> {
    const rootCtx = createTestRootContext();
    const opened = await openSessionDatabase(rootCtx, ":memory:");
    await migrateSessionDatabase(opened.ctx);
    const events: DocumentEvent[] = [];
    return {
        ctx: opened.ctx,
        events,
        opened,
        repository: new DocumentRepository({
            database: opened.database,
            now: () => 10,
            onEvent: (_ctx, event) => {
                events.push(event);
            },
        }),
    };
}

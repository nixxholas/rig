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

describe("DocumentRepository", () => {
    it("rolls a document write back when its durable event cannot be stored", async () => {
        const opened = await openSessionDatabase(":memory:");
        await migrateSessionDatabase(opened.database);
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
                    { id: "adocument00000000000000001", mimeType: "text/plain", state: "draft" },
                    { instanceId: "alocalinstance00000000001" },
                ),
            ).rejects.toBe(failure);
            expect((await opened.client.execute("SELECT id FROM documents")).rows).toEqual([]);
        } finally {
            await opened.database.close();
        }
    });

    it("stores canonical JSON and preserves immutable creation identity", async () => {
        const { events, opened, repository } = await fixture();
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
        const document = await repository.createDocument(request, createdBy);
        const retry = await repository.createDocument(request, createdBy);

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
        await opened.client.close();
    });

    it("bounds serialized state and updates", async () => {
        const { opened, repository } = await fixture();
        const document = await repository.createDocument(
            { mimeType: "text/plain", state: "" },
            { instanceId: "alocalinstance00000000001" },
        );

        await expect(
            repository.createDocument(
                { mimeType: "text/plain", state: "x".repeat(DOCUMENT_STATE_MAX_BYTES) },
                { instanceId: "alocalinstance00000000001" },
            ),
        ).rejects.toThrowError(DocumentError);
        await expect(
            repository.writeDocument(
                document.id,
                {
                    state: "next",
                    update: "x".repeat(DOCUMENT_UPDATE_MAX_BYTES),
                },
                1,
            ),
        ).rejects.toThrowError(DocumentError);
        expect((await repository.getDocument(document.id))?.version).toBe(1);
        await opened.client.close();
    });

    it("publishes only after a successful non-retry CAS write", async () => {
        const { events, opened, repository } = await fixture();
        const document = await repository.createDocument(
            { mimeType: "text/plain", mutationId: "create", state: "a" },
            { instanceId: "alocalinstance00000000001" },
        );
        events.length = 0;

        const first = await repository.writeDocument(
            document.id,
            { mutationId: "write", state: "b", update: { replace: "b" } },
            1,
        );
        const retry = await repository.writeDocument(
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
                await repository.documentUpdates(document.id, { afterVersion: 1 }),
            ),
        ).toBe(true);
        await opened.client.close();
    });
});

async function fixture(): Promise<{
    events: DocumentEvent[];
    opened: Awaited<ReturnType<typeof openSessionDatabase>>;
    repository: DocumentRepository;
}> {
    const opened = await openSessionDatabase(":memory:");
    await migrateSessionDatabase(opened.database);
    const events: DocumentEvent[] = [];
    return {
        events,
        opened,
        repository: new DocumentRepository({
            database: opened.database,
            now: () => 10,
            onEvent: (event) => {
                events.push(event);
            },
        }),
    };
}

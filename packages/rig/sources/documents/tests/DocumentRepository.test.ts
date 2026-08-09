import { sql } from "drizzle-orm";
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
    it("stores canonical JSON and preserves immutable creation identity", () => {
        const { events, opened, repository } = fixture();
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
        const document = repository.createDocument(request, createdBy);
        const retry = repository.createDocument(request, createdBy);

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
            opened.database.get<{ state_json: string }>(
                sql.raw("SELECT state_json FROM documents WHERE id = 'adocument00000000000000001'"),
            ),
        ).toEqual({ state_json: '{"a":{"x":3,"y":2},"z":1}' });
        expect(events).toHaveLength(1);
        expect(retry).toEqual(document);
        opened.client.close();
    });

    it("bounds serialized state and updates", () => {
        const { opened, repository } = fixture();
        const document = repository.createDocument(
            { mimeType: "text/plain", state: "" },
            { instanceId: "alocalinstance00000000001" },
        );

        expect(() =>
            repository.createDocument(
                { mimeType: "text/plain", state: "x".repeat(DOCUMENT_STATE_MAX_BYTES) },
                { instanceId: "alocalinstance00000000001" },
            ),
        ).toThrowError(DocumentError);
        expect(() =>
            repository.writeDocument(
                document.id,
                {
                    state: "next",
                    update: "x".repeat(DOCUMENT_UPDATE_MAX_BYTES),
                },
                1,
            ),
        ).toThrowError(DocumentError);
        expect(repository.getDocument(document.id)?.version).toBe(1);
        opened.client.close();
    });

    it("publishes only after a successful non-retry CAS write", () => {
        const { events, opened, repository } = fixture();
        const document = repository.createDocument(
            { mimeType: "text/plain", mutationId: "create", state: "a" },
            { instanceId: "alocalinstance00000000001" },
        );
        events.length = 0;

        const first = repository.writeDocument(
            document.id,
            { mutationId: "write", state: "b", update: { replace: "b" } },
            1,
        );
        const retry = repository.writeDocument(
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
                repository.documentUpdates(document.id, { afterVersion: 1 }),
            ),
        ).toBe(true);
        opened.client.close();
    });
});

function fixture(): {
    events: DocumentEvent[];
    opened: ReturnType<typeof openSessionDatabase>;
    repository: DocumentRepository;
} {
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    const events: DocumentEvent[] = [];
    return {
        events,
        opened,
        repository: new DocumentRepository({
            database: opened.database,
            now: () => 10,
            onEvent: (event) => events.push(event),
        }),
    };
}

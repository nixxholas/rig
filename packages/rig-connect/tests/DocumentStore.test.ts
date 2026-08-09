import { describe, expect, it } from "vitest";

import { DocumentStore } from "@/DocumentStore.js";
import type { Document, DocumentEvent, DocumentUpdate, DocumentUpdatePage } from "@/protocol.js";

function document(overrides: Partial<Document> = {}): Document {
    return {
        createdAt: 1,
        createdBy: { instanceId: "instance1", profileId: "profile1" },
        firstRetainedVersion: 2,
        id: "document-1",
        mimeType: "application/x-happy-note",
        state: { title: "First" },
        unreadCursor: "0196d226-0000-7000-8000-000000000001",
        updatedAt: 1,
        version: 1,
        ...overrides,
    };
}

function update(version: number, overrides: Partial<DocumentUpdate> = {}): DocumentUpdate {
    return {
        createdAt: version,
        documentId: "document-1",
        id: `0196d226-0000-7000-8000-00000000000${version}`,
        update: { version },
        version,
        ...overrides,
    };
}

function page(overrides: Partial<DocumentUpdatePage> = {}): DocumentUpdatePage {
    return {
        currentVersion: 1,
        firstRetainedVersion: 1,
        gap: false,
        hasMore: false,
        nextAfterVersion: 0,
        updates: [],
        ...overrides,
    };
}

describe("DocumentStore", () => {
    it("predicts a CAS write, preserves omitted MIME and unread fields, and undoes it", () => {
        const store = new DocumentStore("document-1");
        store.applyDocument(document());

        const optimistic = store.applyOptimisticPatch({ state: { title: "Predicted" } });

        expect(store.document()).toMatchObject({
            mimeType: "application/x-happy-note",
            state: { title: "Predicted" },
            unreadCursor: "0196d226-0000-7000-8000-000000000001",
            version: 2,
        });
        optimistic.undo();
        expect(store.document()).toEqual(document());
    });

    it("optimistically clears an unread cursor when a CAS write supplies null", () => {
        const store = new DocumentStore("document-1");
        store.applyDocument(document());

        const optimistic = store.applyOptimisticPatch({
            state: { title: "Read" },
            unreadCursor: null,
        });

        expect(store.document()).not.toHaveProperty("unreadCursor");
        optimistic.undo();
        expect(store.document()?.unreadCursor).toBe("0196d226-0000-7000-8000-000000000001");
    });

    it("replaces a predicted CAS version with an authoritative conflict document", () => {
        const store = new DocumentStore("document-1");
        store.applyDocument(document());
        store.applyOptimisticPatch({ state: { title: "Predicted" } });

        store.applyAuthoritativeDocument(
            document({ state: { title: "Daemon" }, updatedAt: 2, version: 1 }),
        );

        expect(store.document()).toMatchObject({ state: { title: "Daemon" }, version: 1 });
    });

    it("marks light document events as reload-needed without guessing opaque data", () => {
        const store = new DocumentStore("document-1");
        store.applyDocument(document());
        const event: DocumentEvent = {
            createdAt: 2,
            data: { documentId: "document-1", version: 2 },
            id: "event-1",
            type: "document_changed",
        };

        store.apply(event);

        expect(store.document()).toEqual(document());
        expect(store.state().reloadNeeded).toBe(true);
    });

    it("drops pre-retention updates, keeps a gap sticky across pages, and resets at a snapshot", () => {
        const store = new DocumentStore("document-1");
        store.applyDocument(document({ firstRetainedVersion: 1, version: 4 }));
        const first = update(1);
        store.applyUpdatePage(
            page({
                currentVersion: 4,
                hasMore: true,
                nextAfterVersion: 2,
                updates: [first, update(2)],
            }),
        );

        store.applyUpdatePage(
            page({
                currentVersion: 4,
                firstRetainedVersion: 3,
                gap: true,
                hasMore: true,
                nextAfterVersion: 3,
                updates: [update(3)],
            }),
        );

        expect(store.updates().map((value) => value.version)).toEqual([3]);
        expect(store.state().updates.gap).toBe(true);

        store.applyUpdatePage(
            page({
                currentVersion: 4,
                firstRetainedVersion: 3,
                gap: false,
                updates: [update(4)],
            }),
        );

        expect(store.updates().map((value) => value.version)).toEqual([3, 4]);
        expect(store.state().updates.gap).toBe(true);
        expect(store.state().updates.hasMore).toBe(false);

        store.applyAuthoritativeDocument(
            document({ firstRetainedVersion: 3, state: { title: "Current" }, version: 4 }),
        );

        expect(store.updates()).toEqual([]);
        expect(store.state().updates).toEqual({ loading: false });
    });
});

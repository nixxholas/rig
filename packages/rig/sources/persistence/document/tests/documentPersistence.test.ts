import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createEventIdFactory } from "../../../protocol/createEventIdFactory.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { testContext } from "../../database/tests/testContext.js";
import { documentMutations } from "../../database/schema.js";
import { inTx } from "../../inTx.js";
import { documentCreate, pruneReceipts } from "../documentCreate.js";
import { documentWrite } from "../documentWrite.js";
import { queryDocument } from "../queryDocument.js";
import { queryDocumentUpdates } from "../queryDocumentUpdates.js";

const createdBy = { instanceId: "alocalinstance00000000001" };
describe("document persistence", () => {
    it("compares the version, preserves omitted fields, and appends one update", async () => {
        const opened = await fixture();
        await documentCreate(opened.ctx, {
            createdBy,
            fingerprint: "create",
            id: "document",
            mimeType: "application/x-board",
            mutationId: "create-1",
            now: 1,
            stateJson: '{"cards":[]}',
        });

        expect(
            (
                await documentWrite(opened.ctx, {
                    expectedVersion: 9,
                    fingerprint: "stale",
                    id: "document",
                    mutationId: "write-stale",
                    now: 2,
                    stateJson: '{"cards":[1]}',
                    updateId: uuid(2),
                    updateJson: '{"insert":1}',
                    updateBytes: 12,
                })
            ).outcome,
        ).toBe("version_conflict");
        expect(
            await documentWrite(opened.ctx, {
                expectedVersion: 1,
                fingerprint: "write",
                id: "document",
                mutationId: "write-1",
                now: 3,
                stateJson: '{"cards":[1]}',
                updateId: uuid(3),
                updateJson: '{"insert":1}',
                updateBytes: 12,
            }),
        ).toEqual({ outcome: "written", version: 2 });
        expect(await queryDocument(opened.ctx, "document")).toMatchObject({
            mimeType: "application/x-board",
            state: { cards: [1] },
            version: 2,
        });
        expect((await queryDocument(opened.ctx, "document"))?.unreadCursor).toBeUndefined();
        expect(await queryDocumentUpdates(opened.ctx, "document", 1, 100)).toMatchObject({
            currentVersion: 2,
            gap: false,
            updates: [{ documentId: "document", update: { insert: 1 }, version: 2 }],
        });
        await opened.database.close(opened.ctx);
    });

    it("makes an ambiguous retry append exactly one update and rejects conflicting reuse", async () => {
        const opened = await fixture();
        await documentCreate(opened.ctx, {
            createdBy,
            fingerprint: "create",
            id: "document",
            mimeType: "text/plain",
            mutationId: "create",
            now: 1,
            stateJson: '"a"',
        });
        const input = {
            expectedVersion: 1,
            fingerprint: "same-request",
            id: "document",
            mutationId: "write",
            now: 2,
            stateJson: '"b"',
            updateId: uuid(2),
            updateJson: '"b"',
            updateBytes: 3,
        };

        expect(await documentWrite(opened.ctx, input)).toEqual({
            outcome: "written",
            version: 2,
        });
        await inTx(opened.ctx, "rig.sql.documents.test_seed", async (ctx) => {
            const tx = ctx.tx;
            for (let index = 0; index <= 10_000; index += 1) {
                await tx
                    .insert(documentMutations)
                    .values({
                        action: "write",
                        createdAtMs: 10 + index,
                        documentId: "other-document",
                        mutationId: `other-${String(index)}`,
                        requestFingerprint: `other-${String(index)}`,
                        resultVersion: index + 1,
                    })
                    .run();
            }
            await pruneReceipts(ctx, "other-document");
        });
        expect(await documentWrite(opened.ctx, { ...input, updateId: uuid(3) })).toEqual({
            outcome: "applied",
            version: 2,
        });
        expect(
            (await documentWrite(opened.ctx, { ...input, fingerprint: "different" })).outcome,
        ).toBe("mutation_conflict");
        expect((await queryDocumentUpdates(opened.ctx, "document", 1, 100))!.updates).toHaveLength(
            1,
        );
        expect(
            await opened.database.get<{ count: number }>(
                sql.raw(
                    "SELECT COUNT(*) AS count FROM document_mutations WHERE document_id = 'other-document'",
                ),
            ),
        ).toEqual({ count: 10_000 });
        await opened.database.close(opened.ctx);
    });

    it("applies explicit MIME and UUIDv7 unread cursor changes, preserves omission, and clears null", async () => {
        const opened = await fixture();
        await documentCreate(opened.ctx, {
            createdBy,
            fingerprint: "create",
            id: "document",
            mimeType: "text/plain",
            mutationId: "create",
            now: 1,
            stateJson: '"a"',
        });
        const unreadCursor = uuid(4);
        await documentWrite(opened.ctx, {
            expectedVersion: 1,
            fingerprint: "write",
            id: "document",
            mimeType: "text/markdown",
            mutationId: "write",
            now: 2,
            stateJson: '"b"',
            unreadCursor,
            updateId: uuid(2),
            updateJson: '"b"',
            updateBytes: 3,
        });
        await documentWrite(opened.ctx, {
            expectedVersion: 2,
            fingerprint: "write-again",
            id: "document",
            mutationId: "write-again",
            now: 3,
            stateJson: '"c"',
            updateId: uuid(3),
            updateJson: '"c"',
            updateBytes: 3,
        });
        expect((await queryDocument(opened.ctx, "document"))?.unreadCursor).toBe(unreadCursor);
        await documentWrite(opened.ctx, {
            expectedVersion: 3,
            fingerprint: "clear-unread",
            id: "document",
            mutationId: "clear-unread",
            now: 4,
            stateJson: '"d"',
            unreadCursor: null,
            updateId: uuid(4),
            updateJson: '"d"',
            updateBytes: 3,
        });

        expect(await queryDocument(opened.ctx, "document")).toMatchObject({
            mimeType: "text/markdown",
            version: 4,
        });
        expect((await queryDocument(opened.ctx, "document"))?.unreadCursor).toBeUndefined();
        await opened.database.close(opened.ctx);
    });

    it("clamps a future update cursor to the current document version", async () => {
        const opened = await fixture();
        await documentCreate(opened.ctx, {
            createdBy,
            fingerprint: "create",
            id: "document",
            mimeType: "text/plain",
            mutationId: "create",
            now: 1,
            stateJson: '"a"',
        });
        await documentWrite(opened.ctx, {
            expectedVersion: 1,
            fingerprint: "write",
            id: "document",
            mutationId: "write",
            now: 2,
            stateJson: '"b"',
            updateId: uuid(2),
            updateJson: '"b"',
            updateBytes: 3,
        });

        const future = (await queryDocumentUpdates(opened.ctx, "document", 999, 100))!;
        expect(future).toMatchObject({
            currentVersion: 2,
            gap: false,
            nextAfterVersion: 2,
            updates: [],
        });

        await documentWrite(opened.ctx, {
            expectedVersion: 2,
            fingerprint: "later",
            id: "document",
            mutationId: "later",
            now: 3,
            stateJson: '"c"',
            updateId: uuid(3),
            updateJson: '"c"',
            updateBytes: 3,
        });
        expect(
            (await queryDocumentUpdates(
                opened.ctx,
                "document",
                future.nextAfterVersion,
                100,
            ))!.updates.map((update) => update.version),
        ).toEqual([3]);
        await opened.database.close(opened.ctx);
    });

    it("reports a gap after retained updates are trimmed", async () => {
        const opened = await fixture();
        await documentCreate(opened.ctx, {
            createdBy,
            fingerprint: "create",
            id: "document",
            mimeType: "text/plain",
            mutationId: "create",
            now: 1,
            stateJson: '"a"',
        });
        await opened.database.run(
            sql.raw(`
                UPDATE documents SET version = 10002, first_retained_version = 2
                WHERE id = 'document'
            `),
        );
        for (let version = 2; version <= 10_001; version += 1) {
            await opened.database.run(
                sql.raw(
                    `INSERT INTO document_updates
                    (id, document_id, version, update_json, byte_length, created_at_ms)
                    VALUES ('u-${String(version)}', 'document', ${String(version)}, 'null', 4, ${String(version)})`,
                ),
            );
        }

        await documentWrite(opened.ctx, {
            expectedVersion: 10_002,
            fingerprint: "trim",
            id: "document",
            mutationId: "trim",
            now: 10_003,
            stateJson: '"latest"',
            updateId: uuid(10_003),
            updateJson: '"latest"',
            updateBytes: 8,
        });

        const page = await queryDocumentUpdates(opened.ctx, "document", 1, 3);
        expect(page).toMatchObject({
            currentVersion: 10_003,
            firstRetainedVersion: 3,
            gap: true,
            hasMore: true,
        });
        expect(page!.updates.map((update) => update.version)).toEqual([3, 4, 5]);
        await opened.database.close(opened.ctx);
    });
});

async function fixture() {
    const opened = await openSessionDatabase(testContext(), ":memory:");
    await migrateSessionDatabase(opened.ctx);
    return opened;
}

function uuid(now: number): string {
    return createEventIdFactory({ now: () => now })();
}

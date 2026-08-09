import { and, asc, eq, lt, sql } from "drizzle-orm";

import {
    DOCUMENT_UPDATE_RETENTION_MAX_BYTES,
    DOCUMENT_UPDATE_RETENTION_MAX_COUNT,
} from "../../protocol/index.js";
import { documentMutations, documents, documentUpdates } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { pruneReceipts } from "./documentCreate.js";

export type DocumentWriteResult =
    | { outcome: "applied"; version: number }
    | { outcome: "document_not_found" }
    | { outcome: "mutation_conflict" }
    | { outcome: "version_conflict"; version: number }
    | { outcome: "written"; version: number };

export function documentWrite(
    tx: TX,
    input: {
        expectedVersion: number;
        fingerprint: string;
        id: string;
        mimeType?: string;
        mutationId?: string;
        now: number;
        stateJson: string;
        unreadCursor?: string | null;
        updateBytes: number;
        updateId: string;
        updateJson: string;
    },
): DocumentWriteResult {
    return inTx(tx, (tx) => {
        if (input.mutationId !== undefined) {
            const receipt = tx
                .select()
                .from(documentMutations)
                .where(eq(documentMutations.mutationId, input.mutationId))
                .get();
            if (receipt !== undefined) {
                return receipt.action === "write" &&
                    receipt.documentId === input.id &&
                    receipt.requestFingerprint === input.fingerprint
                    ? { outcome: "applied", version: receipt.resultVersion }
                    : { outcome: "mutation_conflict" };
            }
        }
        const current = tx
            .select({ version: documents.version })
            .from(documents)
            .where(eq(documents.id, input.id))
            .get();
        if (current === undefined) return { outcome: "document_not_found" };
        if (current.version !== input.expectedVersion) {
            return { outcome: "version_conflict", version: current.version };
        }
        const version = current.version + 1;
        const changed = tx
            .update(documents)
            .set({
                ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
                stateJson: input.stateJson,
                ...(input.unreadCursor === undefined ? {} : { unreadCursor: input.unreadCursor }),
                updatedAtMs: input.now,
                version,
            })
            .where(and(eq(documents.id, input.id), eq(documents.version, input.expectedVersion)))
            .run().changes;
        if (changed !== 1) {
            const latest = tx
                .select({ version: documents.version })
                .from(documents)
                .where(eq(documents.id, input.id))
                .get();
            return latest === undefined
                ? { outcome: "document_not_found" }
                : { outcome: "version_conflict", version: latest.version };
        }
        tx.insert(documentUpdates)
            .values({
                byteLength: input.updateBytes,
                createdAtMs: input.now,
                documentId: input.id,
                id: input.updateId,
                updateJson: input.updateJson,
                version,
            })
            .run();
        trimUpdates(tx, input.id);
        if (input.mutationId !== undefined) {
            tx.insert(documentMutations)
                .values({
                    action: "write",
                    createdAtMs: input.now,
                    documentId: input.id,
                    mutationId: input.mutationId,
                    requestFingerprint: input.fingerprint,
                    resultVersion: version,
                })
                .run();
            pruneReceipts(tx, input.id);
        }
        return { outcome: "written", version };
    });
}

function trimUpdates(tx: TX, documentId: string): void {
    const rows = tx
        .select({ byteLength: documentUpdates.byteLength, version: documentUpdates.version })
        .from(documentUpdates)
        .where(eq(documentUpdates.documentId, documentId))
        .orderBy(asc(documentUpdates.version))
        .all();
    let retainedBytes = 0;
    let firstIndex = rows.length;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (
            rows.length - index > DOCUMENT_UPDATE_RETENTION_MAX_COUNT ||
            retainedBytes + row.byteLength > DOCUMENT_UPDATE_RETENTION_MAX_BYTES
        ) {
            break;
        }
        retainedBytes += row.byteLength;
        firstIndex = index;
    }
    const firstRetainedVersion = rows[firstIndex]?.version ?? rows.at(-1)!.version + 1;
    if (firstIndex > 0) {
        tx.delete(documentUpdates)
            .where(
                sql`${documentUpdates.documentId} = ${documentId} AND ${lt(
                    documentUpdates.version,
                    firstRetainedVersion,
                )}`,
            )
            .run();
    }
    tx.update(documents).set({ firstRetainedVersion }).where(eq(documents.id, documentId)).run();
}

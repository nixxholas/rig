import { inDatabase } from "../database/inDatabase.js";
import { eq, sql } from "drizzle-orm";

import {
    DOCUMENT_UPDATE_RETENTION_MAX_COUNT,
    type DocumentCreatedBy,
} from "../../protocol/index.js";
import { documentMutations, documents } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export type DocumentCreateResult =
    | { outcome: "applied"; version: number }
    | { outcome: "created"; version: number }
    | { outcome: "id_conflict" }
    | { outcome: "mutation_conflict" };

export async function documentCreate(
    tx: DatabaseScope,
    input: {
        createdBy: DocumentCreatedBy;
        fingerprint: string;
        id: string;
        mimeType: string;
        mutationId?: string;
        now: number;
        stateJson: string;
        unreadCursor?: string;
    },
): Promise<DocumentCreateResult> {
    return await inTx(tx, async (tx) => {
        if (input.mutationId !== undefined) {
            const receipt = await tx
                .select()
                .from(documentMutations)
                .where(eq(documentMutations.mutationId, input.mutationId))
                .get();
            if (receipt !== undefined) {
                return receipt.action === "create" &&
                    receipt.documentId === input.id &&
                    receipt.requestFingerprint === input.fingerprint
                    ? { outcome: "applied", version: receipt.resultVersion }
                    : { outcome: "mutation_conflict" };
            }
        }
        const existing = await tx
            .select({ id: documents.id })
            .from(documents)
            .where(eq(documents.id, input.id))
            .get();
        if (existing !== undefined) return { outcome: "id_conflict" };
        await tx
            .insert(documents)
            .values({
                createdAtMs: input.now,
                createdByInstanceId: input.createdBy.instanceId,
                createdByProfileId: input.createdBy.profileId ?? null,
                firstRetainedVersion: 2,
                id: input.id,
                mimeType: input.mimeType,
                stateJson: input.stateJson,
                updatedAtMs: input.now,
                unreadCursor: input.unreadCursor ?? null,
                version: 1,
            })
            .run();
        if (input.mutationId !== undefined) {
            await tx
                .insert(documentMutations)
                .values({
                    action: "create",
                    createdAtMs: input.now,
                    documentId: input.id,
                    mutationId: input.mutationId,
                    requestFingerprint: input.fingerprint,
                    resultVersion: 1,
                })
                .run();
            await pruneReceipts(tx, input.id);
        }
        return { outcome: "created", version: 1 };
    });
}

export async function pruneReceipts(tx: DatabaseScope, documentId: string): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx.run(
            sql`
        DELETE FROM document_mutations
        WHERE action = 'write'
          AND document_id = ${documentId}
          AND mutation_id IN (
            SELECT mutation_id FROM document_mutations
            WHERE action = 'write' AND document_id = ${documentId}
            ORDER BY created_at_ms DESC, mutation_id DESC
            LIMIT -1 OFFSET ${DOCUMENT_UPDATE_RETENTION_MAX_COUNT}
          )
        `,
        );
    });
}

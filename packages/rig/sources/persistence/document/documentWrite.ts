import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    DOCUMENT_UPDATE_RETENTION_MAX_BYTES,
    DOCUMENT_UPDATE_RETENTION_MAX_COUNT,
} from "../../protocol/index.js";
import { documentMutations, documents, documentUpdates } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope, TX } from "../Transaction.js";
import { pruneReceipts } from "./documentCreate.js";

export type DocumentWriteResult =
    | { outcome: "applied"; version: number }
    | { outcome: "document_not_found" }
    | { outcome: "mutation_conflict" }
    | { outcome: "version_conflict"; version: number }
    | { outcome: "written"; version: number };

export async function documentWrite(
    ctx: Context,
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
): Promise<DocumentWriteResult> {
    return await inTx(ctx, "rig.sql.documents.write", async (ctx) => {
        const tx = ctx.tx;
        if (input.mutationId !== undefined) {
            const receipt = await tx
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
        const current = await tx
            .select({ version: documents.version })
            .from(documents)
            .where(eq(documents.id, input.id))
            .get();
        if (current === undefined) return { outcome: "document_not_found" };
        if (current.version !== input.expectedVersion) {
            return { outcome: "version_conflict", version: current.version };
        }
        const version = current.version + 1;
        const changed = (
            await tx
                .update(documents)
                .set({
                    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
                    stateJson: input.stateJson,
                    ...(input.unreadCursor === undefined
                        ? {}
                        : { unreadCursor: input.unreadCursor }),
                    updatedAtMs: input.now,
                    version,
                })
                .where(
                    and(eq(documents.id, input.id), eq(documents.version, input.expectedVersion)),
                )
                .run()
        ).rowsAffected;
        if (changed !== 1) {
            const latest = await tx
                .select({ version: documents.version })
                .from(documents)
                .where(eq(documents.id, input.id))
                .get();
            return latest === undefined
                ? { outcome: "document_not_found" }
                : { outcome: "version_conflict", version: latest.version };
        }
        await tx
            .insert(documentUpdates)
            .values({
                byteLength: input.updateBytes,
                createdAtMs: input.now,
                documentId: input.id,
                id: input.updateId,
                updateJson: input.updateJson,
                version,
            })
            .run();
        await trimUpdates(ctx, input.id);
        if (input.mutationId !== undefined) {
            await tx
                .insert(documentMutations)
                .values({
                    action: "write",
                    createdAtMs: input.now,
                    documentId: input.id,
                    mutationId: input.mutationId,
                    requestFingerprint: input.fingerprint,
                    resultVersion: version,
                })
                .run();
            await pruneReceipts(ctx, input.id);
        }
        return { outcome: "written", version };
    });
}

async function trimUpdates(ctx: Context, documentId: string): Promise<void> {
    const tx = ctx.tx;
    const rows = await tx
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
        await tx
            .delete(documentUpdates)
            .where(
                sql`${documentUpdates.documentId} = ${documentId} AND ${lt(
                    documentUpdates.version,
                    firstRetainedVersion,
                )}`,
            )
            .run();
    }
    await tx
        .update(documents)
        .set({ firstRetainedVersion })
        .where(eq(documents.id, documentId))
        .run();
}

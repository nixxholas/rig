import { and, asc, eq, gt } from "drizzle-orm";

import type { DocumentUpdatePage } from "../../protocol/index.js";
import { documents, documentUpdates } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryDocumentUpdates(
    tx: TX,
    documentId: string,
    afterVersion: number,
    limit: number,
): DocumentUpdatePage | undefined {
    const document = tx
        .select({
            firstRetainedVersion: documents.firstRetainedVersion,
            version: documents.version,
        })
        .from(documents)
        .where(eq(documents.id, documentId))
        .get();
    if (document === undefined) return undefined;
    const boundedAfter = Math.min(afterVersion, document.version);
    const gap = boundedAfter < document.firstRetainedVersion - 1;
    const effectiveAfter = gap ? document.firstRetainedVersion - 1 : boundedAfter;
    const rows = tx
        .select()
        .from(documentUpdates)
        .where(
            and(
                eq(documentUpdates.documentId, documentId),
                gt(documentUpdates.version, effectiveAfter),
            ),
        )
        .orderBy(asc(documentUpdates.version))
        .limit(limit + 1)
        .all();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
        currentVersion: document.version,
        firstRetainedVersion: document.firstRetainedVersion,
        gap,
        hasMore,
        nextAfterVersion: page.at(-1)?.version ?? effectiveAfter,
        updates: page.map((row) => ({
            createdAt: row.createdAtMs,
            documentId: row.documentId,
            id: row.id,
            update: JSON.parse(row.updateJson) as unknown,
            version: row.version,
        })),
    };
}

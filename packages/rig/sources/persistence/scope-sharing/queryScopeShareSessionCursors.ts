import { asc, eq } from "drizzle-orm";

import { scopeShareSessionCursors } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareSessionCursorRecord } from "./types.js";

/** One share's session queue, in the order the next pass will serve it. */
export function queryScopeShareSessionCursors(
    tx: TX,
    shareId: string,
): readonly ScopeShareSessionCursorRecord[] {
    return tx
        .select()
        .from(scopeShareSessionCursors)
        .where(eq(scopeShareSessionCursors.shareId, shareId))
        .orderBy(asc(scopeShareSessionCursors.rotationSeq), asc(scopeShareSessionCursors.sessionId))
        .all()
        .map((row) => ({
            createdAt: row.createdAtMs,
            indexVersion: row.indexVersion,
            publishedEventSeq: row.publishedEventSeq,
            rotationSeq: row.rotationSeq,
            sessionId: row.sessionId,
            shareId: row.shareId,
            updatedAt: row.updatedAtMs,
        }));
}

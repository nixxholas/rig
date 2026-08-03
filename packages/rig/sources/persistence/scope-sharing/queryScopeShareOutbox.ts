import { and, asc, eq, gt } from "drizzle-orm";

import type { ScopeShareSubjectKind } from "../../scope-sharing/projectScopeShareEntry.js";
import { scopeShareOutbox } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareOutboxRecord } from "./types.js";

export function queryScopeShareOutbox(
    tx: TX,
    input: { afterSequence?: number; limit: number; maxBytes?: number; shareId: string },
): readonly ScopeShareOutboxRecord[] {
    const rows = tx
        .select()
        .from(scopeShareOutbox)
        .where(
            input.afterSequence === undefined
                ? eq(scopeShareOutbox.shareId, input.shareId)
                : and(
                      eq(scopeShareOutbox.shareId, input.shareId),
                      gt(scopeShareOutbox.sequence, input.afterSequence),
                  ),
        )
        .orderBy(asc(scopeShareOutbox.sequence))
        .limit(input.limit)
        .all();
    const selected: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
        if (
            input.maxBytes !== undefined &&
            selected.length > 0 &&
            bytes + row.byteLength > input.maxBytes
        ) {
            break;
        }
        selected.push(row);
        bytes += row.byteLength;
    }
    return selected.map((row) => ({
        byteLength: row.byteLength,
        canonicalJson: row.canonicalJson,
        contentHash: row.contentHash,
        createdAt: row.createdAtMs,
        sequence: row.sequence,
        shareEventId: row.shareEventId,
        shareId: row.shareId,
        ...(row.sourceEventSeq === null ? {} : { sourceEventSeq: row.sourceEventSeq }),
        subjectId: row.subjectId,
        subjectKind: row.subjectKind as ScopeShareSubjectKind,
    }));
}

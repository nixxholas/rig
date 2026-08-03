import { and, asc, eq, gt } from "drizzle-orm";

import { sessionShareOutbox } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareOutboxRecord } from "./types.js";

export function querySessionShareOutbox(
    tx: TX,
    input: { afterSequence?: number; limit: number; maxBytes?: number; shareId: string },
): readonly SessionShareOutboxRecord[] {
    const rows = tx
        .select()
        .from(sessionShareOutbox)
        .where(
            input.afterSequence === undefined
                ? eq(sessionShareOutbox.shareId, input.shareId)
                : and(
                      eq(sessionShareOutbox.shareId, input.shareId),
                      gt(sessionShareOutbox.sequence, input.afterSequence),
                  ),
        )
        .orderBy(asc(sessionShareOutbox.sequence))
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
    }));
}

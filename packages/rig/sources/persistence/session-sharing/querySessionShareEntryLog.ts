import { and, asc, eq, gt } from "drizzle-orm";

import type { ShareOpaqueEntry } from "../../sharing/ShareTransport.js";
import { sessionShareEntries } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function querySessionShareEntryLog(
    tx: TX,
    input: { afterSequence: number; maxBytes: number; maxItems: number; shareId: string },
): { complete: boolean; entries: readonly ShareOpaqueEntry[] } {
    const rows = tx
        .select()
        .from(sessionShareEntries)
        .where(
            and(
                eq(sessionShareEntries.shareId, input.shareId),
                gt(sessionShareEntries.sequence, input.afterSequence),
            ),
        )
        .orderBy(asc(sessionShareEntries.sequence))
        .limit(input.maxItems)
        .all();
    const selected: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
        if (selected.length > 0 && bytes + row.byteLength > input.maxBytes) break;
        selected.push(row);
        bytes += row.byteLength;
    }
    const lastSequence = selected.at(-1)?.sequence ?? input.afterSequence;
    const remaining = tx
        .select({ sequence: sessionShareEntries.sequence })
        .from(sessionShareEntries)
        .where(
            and(
                eq(sessionShareEntries.shareId, input.shareId),
                gt(sessionShareEntries.sequence, lastSequence),
            ),
        )
        .limit(1)
        .get();
    return {
        complete: remaining === undefined,
        entries: selected.map((row) => ({
            canonicalJson: row.canonicalJson,
            contentHash: row.contentHash,
            createdAt: row.createdAtMs,
            shareEventId: row.shareEventId,
            shareId: row.shareId,
            shareSequence: row.sequence,
        })),
    };
}

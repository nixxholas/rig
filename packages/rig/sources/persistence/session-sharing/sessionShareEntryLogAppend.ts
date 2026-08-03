import { and, eq } from "drizzle-orm";

import type { ShareOpaqueEntry } from "../../sharing/ShareTransport.js";
import { sessionShareEntries } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

/**
 * Retain one share's acknowledged entries as the history a later member is offered.
 *
 * The log is deliberately kept whole. Murmur chains history offers rather than
 * stopping at one, so every sequence remains offerable, and truncating here would
 * silently hand a late member a transcript with a hole in it. Its retention is the
 * share's own lifetime: `sessionShareEntryLogPrune` drops the whole log when the
 * share stops, which is the first moment no member can ever be offered it again.
 */
export function sessionShareEntryLogAppend(
    tx: TX,
    input: { entries: readonly ShareOpaqueEntry[]; shareId: string },
): void {
    if (input.entries.length === 0) return;
    inTx(tx, (tx) => {
        for (const entry of input.entries) {
            if (entry.shareId !== input.shareId) {
                throw new Error("The session share entry does not belong to this share.");
            }
            const existing = tx
                .select()
                .from(sessionShareEntries)
                .where(
                    and(
                        eq(sessionShareEntries.shareId, input.shareId),
                        eq(sessionShareEntries.sequence, entry.shareSequence),
                    ),
                )
                .get();
            if (existing !== undefined) {
                if (existing.contentHash === entry.contentHash) continue;
                throw new Error(
                    `Session share entry ${String(entry.shareSequence)} for share ${input.shareId} already has different content.`,
                );
            }
            tx.insert(sessionShareEntries)
                .values({
                    byteLength: Buffer.byteLength(entry.canonicalJson, "utf8"),
                    canonicalJson: entry.canonicalJson,
                    contentHash: entry.contentHash,
                    createdAtMs: entry.createdAt,
                    sequence: entry.shareSequence,
                    shareEventId: entry.shareEventId,
                    shareId: input.shareId,
                })
                .run();
        }
    });
}

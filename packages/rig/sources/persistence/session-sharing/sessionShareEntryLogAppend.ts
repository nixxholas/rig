import { and, eq } from "drizzle-orm";

import type { SessionShareOpaqueEntry } from "../../session-sharing/SessionShareTransport.js";
import { sessionShareEntries } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

/**
 * Highest sequence a history offer can ever reach.
 *
 * Murmur builds an offer from sequence one and stops after
 * `MAX_SHARED_SESSION_OFFER_PAGES` pages, so nothing past that point is ever offered
 * to a late member — it only arrives live, to members who were already present.
 * Retaining entries beyond it would grow a second copy of the transcript forever for
 * no reader, so the log stops there. The page size is Rig's own, chosen by the
 * runtime's `readPage`, so the bound is stated in entries rather than pages.
 */
// 256 offer pages of `HISTORY_PAGE_ENTRIES` entries each, per `createSessionShareRuntime`.
const MAX_OFFERABLE_SEQUENCE = 256 * 100;

export function sessionShareEntryLogAppend(
    tx: TX,
    input: { entries: readonly SessionShareOpaqueEntry[]; shareId: string },
): void {
    if (input.entries.length === 0) return;
    inTx(tx, (tx) => {
        for (const entry of input.entries) {
            if (entry.shareId !== input.shareId) {
                throw new Error("The session share entry does not belong to this share.");
            }
            if (entry.shareSequence > MAX_OFFERABLE_SEQUENCE) continue;
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

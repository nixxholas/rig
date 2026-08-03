import { and, eq } from "drizzle-orm";

import type { SessionShareOpaqueEntry } from "../../session-sharing/SessionShareTransport.js";
import { sessionShareEntries } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

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

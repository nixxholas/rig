import { eq, sql } from "drizzle-orm";

import { sessionShareOutbox, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { SessionShareOutboxRecord } from "./types.js";

export function sessionShareOutboxEnqueue(
    tx: TX,
    input: {
        byteLength: number;
        canonicalJson: string;
        contentHash: string;
        createdAt: number;
        degradeAboveBytes: number;
        degradeAboveCount: number;
        shareEventId: string;
        shareId: string;
        sourceEventSeq?: number;
    },
): SessionShareOutboxRecord | undefined {
    return inTx(tx, (tx) => {
        const share = tx
            .select()
            .from(sessionShares)
            .where(eq(sessionShares.shareId, input.shareId))
            .get();
        if (share === undefined) throw new Error("The session share does not exist.");
        if (share.state === "stopped") throw new Error("A stopped session share cannot publish.");
        const existing = tx
            .select()
            .from(sessionShareOutbox)
            .where(eq(sessionShareOutbox.shareEventId, input.shareEventId))
            .get();
        if (existing !== undefined) return outboxRecord(existing);
        const nextBytes = share.outboxBytes + input.byteLength;
        const nextCount = share.outboxCount + 1;
        if (nextBytes > input.degradeAboveBytes || nextCount > input.degradeAboveCount) {
            tx.update(sessionShares)
                .set({ state: "degraded", updatedAtMs: input.createdAt })
                .where(eq(sessionShares.shareId, input.shareId))
                .run();
            return undefined;
        }
        tx.insert(sessionShareOutbox)
            .values({
                byteLength: input.byteLength,
                canonicalJson: input.canonicalJson,
                contentHash: input.contentHash,
                createdAtMs: input.createdAt,
                sequence: share.nextShareSequence,
                shareEventId: input.shareEventId,
                shareId: input.shareId,
                sourceEventSeq: input.sourceEventSeq ?? null,
            })
            .run();
        tx.update(sessionShares)
            .set({
                nextShareSequence: sql`${sessionShares.nextShareSequence} + 1`,
                outboxBytes: nextBytes,
                outboxCount: nextCount,
                updatedAtMs: input.createdAt,
            })
            .where(eq(sessionShares.shareId, input.shareId))
            .run();
        return {
            byteLength: input.byteLength,
            canonicalJson: input.canonicalJson,
            contentHash: input.contentHash,
            createdAt: input.createdAt,
            sequence: share.nextShareSequence,
            shareEventId: input.shareEventId,
            shareId: input.shareId,
            ...(input.sourceEventSeq === undefined ? {} : { sourceEventSeq: input.sourceEventSeq }),
        };
    });
}

function outboxRecord(row: typeof sessionShareOutbox.$inferSelect): SessionShareOutboxRecord {
    return {
        byteLength: row.byteLength,
        canonicalJson: row.canonicalJson,
        contentHash: row.contentHash,
        createdAt: row.createdAtMs,
        sequence: row.sequence,
        shareEventId: row.shareEventId,
        shareId: row.shareId,
        ...(row.sourceEventSeq === null ? {} : { sourceEventSeq: row.sourceEventSeq }),
    };
}

import { eq, sql } from "drizzle-orm";

import { sessionSharePeerActions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { sessionSharePeerActionPrune } from "./sessionSharePeerActionPrune.js";
import type {
    SessionSharePeerActionOutcome,
    SessionSharePeerActionRecord,
    SessionSharePeerCapability,
} from "./types.js";

const MAX_ACTION_LENGTH = 128;
const MAX_DETAIL_LENGTH = 512;

/**
 * Append one row to a share's peer-action audit log. The sequence is assigned as
 * `max(seq) + 1` for the share (starting at 1), so the log is gapless per share.
 * The prune runs in the same transaction as the insert, which keeps the log
 * bounded by construction: it can never grow past its retention window between
 * writes, so it never needs a background sweep.
 *
 * `action` and `detail` are truncated before insert so an oversized value can
 * never push a row past a storage bound.
 */
export function sessionSharePeerActionAppend(
    tx: TX,
    input: {
        action: string;
        capability: SessionSharePeerCapability;
        detail?: string;
        grantEpoch: number;
        now: number;
        outcome: SessionSharePeerActionOutcome;
        shareId: string;
        shareMemberId: string;
    },
): SessionSharePeerActionRecord {
    return inTx(tx, (tx) => {
        const nextSeq =
            (tx
                .select({ maxSeq: sql<number | null>`MAX(${sessionSharePeerActions.seq})` })
                .from(sessionSharePeerActions)
                .where(eq(sessionSharePeerActions.shareId, input.shareId))
                .get()?.maxSeq ?? 0) + 1;
        const action = input.action.slice(0, MAX_ACTION_LENGTH);
        const detail =
            input.detail === undefined ? undefined : input.detail.slice(0, MAX_DETAIL_LENGTH);
        tx.insert(sessionSharePeerActions)
            .values({
                action,
                capability: input.capability,
                createdAtMs: input.now,
                detail: detail ?? null,
                grantEpoch: input.grantEpoch,
                outcome: input.outcome,
                seq: nextSeq,
                shareId: input.shareId,
                shareMemberId: input.shareMemberId,
            })
            .run();
        // Prune in the same transaction so the log is bounded by construction.
        sessionSharePeerActionPrune(tx, { now: input.now, shareId: input.shareId });
        return {
            action,
            capability: input.capability,
            createdAt: input.now,
            grantEpoch: input.grantEpoch,
            outcome: input.outcome,
            seq: nextSeq,
            shareId: input.shareId,
            shareMemberId: input.shareMemberId,
            ...(detail === undefined ? {} : { detail }),
        };
    });
}

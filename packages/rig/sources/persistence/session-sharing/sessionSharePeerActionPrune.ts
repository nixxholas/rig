import { and, eq, lt, sql } from "drizzle-orm";

import { sessionSharePeerActions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export const MAX_PEER_ACTION_ROWS = 10_000;
export const MAX_PEER_ACTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bound the peer-action audit log for one share. An audit log with no bound is a
 * disk leak: it grows for as long as a share exists and never releases anything.
 * We prune it on the write path — the same place the entry log is pruned by its
 * own lifecycle transition — rather than on a timer, so the log stays bounded by
 * construction and no separate sweep is ever needed.
 *
 * Retention is the newest 10,000 rows within the last 30 days for the share:
 * rows older than the age cap go first, then anything past the row cap. Returns
 * the number of rows deleted.
 */
export function sessionSharePeerActionPrune(
    tx: TX,
    input: { now: number; shareId: string },
): number {
    let deleted = tx
        .delete(sessionSharePeerActions)
        .where(
            and(
                eq(sessionSharePeerActions.shareId, input.shareId),
                lt(sessionSharePeerActions.createdAtMs, input.now - MAX_PEER_ACTION_AGE_MS),
            ),
        )
        .run().changes;
    deleted += tx
        .delete(sessionSharePeerActions)
        .where(
            and(
                eq(sessionSharePeerActions.shareId, input.shareId),
                sql`${sessionSharePeerActions.seq} <= (
                    SELECT MAX(seq) FROM session_share_peer_actions WHERE share_id = ${input.shareId}
                ) - ${MAX_PEER_ACTION_ROWS}`,
            ),
        )
        .run().changes;
    return deleted;
}

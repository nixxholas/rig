import { and, asc, eq, gt } from "drizzle-orm";

import { sessionSharePeerActions } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type {
    SessionSharePeerActionOutcome,
    SessionSharePeerActionRecord,
    SessionSharePeerCapability,
} from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

/**
 * A bounded page of a share's peer-action audit log, ordered by `seq` ascending
 * after `afterSeq`. `complete` is true when no rows remain past the page, so a
 * caller can walk the whole log by following `seq` until it is.
 */
export function querySessionSharePeerActions(
    tx: TX,
    input: { afterSeq?: number; limit?: number; shareId: string },
): { entries: readonly SessionSharePeerActionRecord[]; complete: boolean } {
    const afterSeq = input.afterSeq ?? 0;
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = tx
        .select()
        .from(sessionSharePeerActions)
        .where(
            and(
                eq(sessionSharePeerActions.shareId, input.shareId),
                gt(sessionSharePeerActions.seq, afterSeq),
            ),
        )
        .orderBy(asc(sessionSharePeerActions.seq))
        .limit(limit)
        .all();
    const lastSeq = rows.at(-1)?.seq ?? afterSeq;
    const remaining = tx
        .select({ seq: sessionSharePeerActions.seq })
        .from(sessionSharePeerActions)
        .where(
            and(
                eq(sessionSharePeerActions.shareId, input.shareId),
                gt(sessionSharePeerActions.seq, lastSeq),
            ),
        )
        .limit(1)
        .get();
    return {
        complete: remaining === undefined,
        entries: rows.map((row) => ({
            action: row.action,
            capability: row.capability as SessionSharePeerCapability,
            createdAt: row.createdAtMs,
            grantEpoch: row.grantEpoch,
            outcome: row.outcome as SessionSharePeerActionOutcome,
            seq: row.seq,
            shareId: row.shareId,
            shareMemberId: row.shareMemberId,
            ...(row.detail === null ? {} : { detail: row.detail }),
        })),
    };
}

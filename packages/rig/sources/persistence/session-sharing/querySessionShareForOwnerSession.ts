import { and, asc, eq, ne } from "drizzle-orm";

import { sessionShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { querySessionShare } from "./querySessionShare.js";
import type { SessionShareRecord } from "./types.js";

/**
 * The one non-stopped share owned by `ownerSessionId`, or `undefined`.
 *
 * This runs on the hot path: the local protocol server resolves the active
 * share for every session event, shared or not. Filtering in SQL keeps that to
 * a single indexed lookup instead of materializing and scanning every share.
 */
export function querySessionShareForOwnerSession(
    tx: TX,
    ownerSessionId: string,
): SessionShareRecord | undefined {
    const shareId = tx
        .select({ shareId: sessionShares.shareId })
        .from(sessionShares)
        .where(
            and(
                eq(sessionShares.ownerSessionId, ownerSessionId),
                ne(sessionShares.state, "stopped"),
            ),
        )
        .orderBy(asc(sessionShares.createdAtMs), asc(sessionShares.shareId))
        .get()?.shareId;
    return shareId === undefined ? undefined : querySessionShare(tx, shareId);
}

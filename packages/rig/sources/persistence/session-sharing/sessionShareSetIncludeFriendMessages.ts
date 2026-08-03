import { and, eq, ne } from "drizzle-orm";

import { sessionShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function sessionShareSetIncludeFriendMessages(
    tx: TX,
    shareId: string,
    include: boolean,
    now: number,
): boolean {
    const result = tx
        .update(sessionShares)
        .set({ includeFriendMessages: include, updatedAtMs: now })
        .where(
            and(
                eq(sessionShares.shareId, shareId),
                ne(sessionShares.state, "stopped"),
                ne(sessionShares.includeFriendMessages, include),
            ),
        )
        .run();
    return result.changes > 0;
}

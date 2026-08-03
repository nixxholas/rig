import { and, eq, ne } from "drizzle-orm";

import { sessionShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function sessionShareSetDegraded(
    tx: TX,
    shareId: string,
    degraded: boolean,
    now: number,
): boolean {
    const result = tx
        .update(sessionShares)
        .set({ state: degraded ? "degraded" : "active", updatedAtMs: now })
        .where(
            and(
                eq(sessionShares.shareId, shareId),
                ne(sessionShares.state, "stopped"),
                ne(sessionShares.state, degraded ? "degraded" : "active"),
            ),
        )
        .run();
    return result.changes > 0;
}

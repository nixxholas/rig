import { and, eq, ne } from "drizzle-orm";

import { scopeShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function scopeShareSetDegraded(
    tx: TX,
    shareId: string,
    degraded: boolean,
    now: number,
): boolean {
    const result = tx
        .update(scopeShares)
        .set({ state: degraded ? "degraded" : "active", updatedAtMs: now })
        .where(
            and(
                eq(scopeShares.shareId, shareId),
                ne(scopeShares.state, "stopped"),
                ne(scopeShares.state, degraded ? "degraded" : "active"),
            ),
        )
        .run();
    return result.changes > 0;
}

import { and, eq, sql } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryWorkspaceHasAttachedSessions(tx: TX, workspaceId: string): boolean {
    const row = tx
        .select({ count: sql<number>`count(*)` })
        .from(sessions)
        .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.archived, false)))
        .get();
    return (row?.count ?? 0) > 0;
}

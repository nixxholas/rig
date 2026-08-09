import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryWorkspaceHasAttachedSessions(
    tx: DatabaseScope,
    workspaceId: string,
): Promise<boolean> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select({ count: sql<number>`count(*)` })
            .from(sessions)
            .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.archived, false)))
            .get();
        return (row?.count ?? 0) > 0;
    });
}

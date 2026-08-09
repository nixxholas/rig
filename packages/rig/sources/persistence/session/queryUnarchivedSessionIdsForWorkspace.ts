import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

/**
 * Lists the sessions a workspace archival still has to reach. Archiving one session at a time makes
 * this the remaining work, so an archival interrupted halfway resumes by asking again.
 */
export async function queryUnarchivedSessionIdsForWorkspace(
    tx: DatabaseScope,
    workspaceId: string,
): Promise<readonly string[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT id FROM sessions WHERE workspace_id = ${workspaceId} AND archived = 0
        `)
        ).map((row) => readString(row, "id"));
    });
}

import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

/**
 * Lists the sessions a workspace archival still has to reach. Archiving one session at a time makes
 * this the remaining work, so an archival interrupted halfway resumes by asking again.
 */
export function queryUnarchivedSessionIdsForWorkspace(
    tx: TX,
    workspaceId: string,
): readonly string[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT id FROM sessions WHERE workspace_id = ${workspaceId} AND archived = 0
        `)
        .map((row) => readString(row, "id"));
}

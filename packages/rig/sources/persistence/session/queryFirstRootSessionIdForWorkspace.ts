import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export async function queryFirstRootSessionIdForWorkspace(
    tx: DatabaseScope,
    projectId: string,
    workspaceId: string,
): Promise<string | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<Record<string, unknown>>(sql`
        SELECT id FROM sessions
        WHERE project_id = ${projectId}
            AND workspace_id = ${workspaceId}
            AND parent_session_id IS NULL
        ORDER BY created_at_ms ASC, id ASC
        LIMIT 1
    `);
        return row === undefined ? undefined : readString(row, "id");
    });
}

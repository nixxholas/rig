import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function queryFirstRootSessionIdForWorkspace(
    tx: TX,
    projectId: string,
    workspaceId: string,
): string | undefined {
    const row = tx.get<Record<string, unknown>>(sql`
        SELECT id FROM sessions
        WHERE project_id = ${projectId}
            AND workspace_id = ${workspaceId}
            AND parent_session_id IS NULL
        ORDER BY created_at_ms ASC, id ASC
        LIMIT 1
    `);
    return row === undefined ? undefined : readString(row, "id");
}

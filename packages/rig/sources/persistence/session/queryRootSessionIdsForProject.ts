import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function queryRootSessionIdsForProject(tx: TX, projectId: string): readonly string[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT id FROM sessions
            WHERE project_id = ${projectId}
                AND workspace_id IS NULL
                AND parent_session_id IS NULL
        `)
        .map((row) => readString(row, "id"));
}

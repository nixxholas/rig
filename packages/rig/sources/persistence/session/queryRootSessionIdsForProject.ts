import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export async function queryRootSessionIdsForProject(
    tx: DatabaseScope,
    projectId: string,
): Promise<readonly string[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT id FROM sessions
            WHERE project_id = ${projectId}
                AND workspace_id IS NULL
                AND parent_session_id IS NULL
        `)
        ).map((row) => readString(row, "id"));
    });
}

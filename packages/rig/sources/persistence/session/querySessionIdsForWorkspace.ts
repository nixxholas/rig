import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function querySessionIdsForWorkspace(tx: TX, workspaceId: string): readonly string[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT id FROM sessions WHERE workspace_id = ${workspaceId}
        `)
        .map((row) => readString(row, "id"));
}

import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { readString } from "./impl/sqliteRow.js";

/**
 * Lists the sessions a workspace archival still has to reach. Archiving one session at a time makes
 * this the remaining work, so an archival interrupted halfway resumes by asking again.
 */
export async function queryUnarchivedSessionIdsForWorkspace(
    ctx: Context,
    workspaceId: string,
): Promise<readonly string[]> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_unarchived_session_ids_for_workspace",
        async (ctx) => {
            const tx = ctx.tx;
            return (
                await tx.all<Record<string, unknown>>(sql`
            SELECT id FROM sessions WHERE workspace_id = ${workspaceId} AND archived = 0
        `)
            ).map((row) => readString(row, "id"));
        },
    );
}

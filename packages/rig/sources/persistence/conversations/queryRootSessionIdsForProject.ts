import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { readString } from "./impl/sqliteRow.js";

export async function queryRootSessionIdsForProject(
    ctx: Context,
    projectId: string,
): Promise<readonly string[]> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_root_session_ids_for_project",
        async (ctx) => {
            const tx = ctx.tx;
            return (
                await tx.all<Record<string, unknown>>(sql`
            SELECT id FROM sessions
            WHERE project_id = ${projectId}
                AND workspace_id IS NULL
                AND parent_session_id IS NULL
        `)
            ).map((row) => readString(row, "id"));
        },
    );
}

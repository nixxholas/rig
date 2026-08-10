import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { readString } from "./impl/sqliteRow.js";

export async function queryFirstRootSessionIdForWorkspace(
    ctx: Context,
    projectId: string,
    workspaceId: string,
): Promise<string | undefined> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_first_root_session_id_for_workspace",
        async (ctx) => {
            const tx = ctx.tx;
            const row = await tx.get<Record<string, unknown>>(sql`
        SELECT id FROM sessions
        WHERE project_id = ${projectId}
            AND workspace_id = ${workspaceId}
            AND parent_session_id IS NULL
        ORDER BY created_at_ms ASC, id ASC
        LIMIT 1
    `);
            return row === undefined ? undefined : readString(row, "id");
        },
    );
}

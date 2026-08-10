import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { SessionScope } from "../../protocol/index.js";
import { readString } from "./impl/sqliteRow.js";

export async function querySessionOrderItems(
    ctx: Context,
    scope: SessionScope,
): Promise<{ id: string; orderKey: string }[]> {
    return await inDatabase(ctx, "rig.sql.session.query_session_order_items", async (ctx) => {
        const tx = ctx.tx;
        const rows = await (async () => {
            switch (scope.kind) {
                case "project":
                    return await tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'project'
                      AND project_id = ${scope.projectId}
                  ORDER BY order_key ASC, id ASC
              `);
                case "workspace":
                    return await tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'workspace'
                      AND workspace_id = ${scope.workspaceId}
                  ORDER BY order_key ASC, id ASC
              `);
                case "folder":
                    return await tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'folder'
                      AND folder_id = ${scope.folderId}
                  ORDER BY order_key ASC, id ASC
              `);
                case "unsorted":
                    return await tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'unsorted'
                  ORDER BY order_key ASC, id ASC
              `);
            }
        })();
        return rows.map((row) => ({
            id: readString(row, "id"),
            orderKey: readString(row, "order_key"),
        }));
    });
}

import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import type { SessionScope } from "../../protocol/index.js";
import { readString } from "./impl/sqliteRow.js";

export function querySessionOrderItems(
    tx: TX,
    scope: SessionScope,
): { id: string; orderKey: string }[] {
    const rows = (() => {
        switch (scope.kind) {
            case "project":
                return tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'project'
                      AND project_id = ${scope.projectId}
                  ORDER BY order_key ASC, id ASC
              `);
            case "workspace":
                return tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'workspace'
                      AND workspace_id = ${scope.workspaceId}
                  ORDER BY order_key ASC, id ASC
              `);
            case "folder":
                return tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND scope_kind = 'folder'
                      AND folder_id = ${scope.folderId}
                  ORDER BY order_key ASC, id ASC
              `);
            case "unsorted":
                return tx.all<Record<string, unknown>>(sql`
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
}

import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function querySessionOrderItems(
    tx: TX,
    projectId: string,
    workspaceId: string | undefined,
): { id: string; orderKey: string }[] {
    const rows =
        workspaceId === undefined
            ? tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND project_id = ${projectId}
                      AND workspace_id IS NULL
                  ORDER BY order_key ASC, id ASC
              `)
            : tx.all<Record<string, unknown>>(sql`
                  SELECT id, order_key FROM sessions
                  WHERE parent_session_id IS NULL
                      AND project_id = ${projectId}
                      AND workspace_id = ${workspaceId}
                  ORDER BY order_key ASC, id ASC
              `);
    return rows.map((row) => ({
        id: readString(row, "id"),
        orderKey: readString(row, "order_key"),
    }));
}

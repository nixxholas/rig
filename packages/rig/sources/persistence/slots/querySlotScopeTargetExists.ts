import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";

/**
 * Whether the project, workspace, or session a scoped slot entry points at actually exists.
 * Checking here, inside the writing transaction, turns a dangling reference into a typed API
 * rejection instead of a foreign-key crash.
 */
export function querySlotScopeTargetExists(
    tx: TX,
    scope: "project" | "session" | "workspace",
    id: string,
): boolean {
    const row =
        scope === "project"
            ? tx.get<Record<string, unknown>>(sql`SELECT id FROM projects WHERE id = ${id}`)
            : scope === "workspace"
              ? tx.get<Record<string, unknown>>(
                    sql`SELECT id FROM project_workspaces WHERE id = ${id}`,
                )
              : tx.get<Record<string, unknown>>(sql`SELECT id FROM sessions WHERE id = ${id}`);
    return row !== undefined;
}

import { inDatabase } from "../database/inDatabase.js";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";

/**
 * Whether the project, workspace, or session a scoped slot entry points at actually exists.
 * Checking here, inside the writing transaction, turns a dangling reference into a typed API
 * rejection instead of a foreign-key crash.
 */
export async function querySlotScopeTargetExists(
    ctx: Context,
    scope: "project" | "session" | "workspace",
    id: string,
): Promise<boolean> {
    return await inDatabase(ctx, "rig.sql.slots.query_scope_target", async (ctx) => {
        const tx = ctx.tx;
        const row =
            scope === "project"
                ? await tx.get<Record<string, unknown>>(
                      sql`SELECT id FROM projects WHERE id = ${id}`,
                  )
                : scope === "workspace"
                  ? await tx.get<Record<string, unknown>>(
                        sql`SELECT id FROM project_workspaces WHERE id = ${id}`,
                    )
                  : await tx.get<Record<string, unknown>>(
                        sql`SELECT id FROM sessions WHERE id = ${id}`,
                    );
        return row !== undefined;
    });
}

import type { Context } from "@steve.kite/stdlib";

import { and, eq, isNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import { inTx } from "../inTx.js";

/**
 * Records the trunk a project's workspaces are cut from.
 *
 * The trunk is decided once, when the project is added, and then left alone: workspaces, branch
 * names, and change baselines all hang off it, so a project that later happens to be checked out
 * on a different branch must not silently start forking from somewhere else. The write is therefore
 * conditional on the branch still being unknown.
 */
export async function projectSetDefaultBranch(
    ctx: Context,
    id: string,
    branch: string,
    now: number,
): Promise<number> {
    return await inTx(ctx, "rig.sql.project.projectSetDefaultBranch", async (ctx) =>
        Number(
            (
                await ctx.tx
                    .update(projects)
                    .set({
                        defaultBranch: branch,
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(and(eq(projects.id, id), isNull(projects.defaultBranch)))
                    .run()
            ).rowsAffected,
        ),
    );
}

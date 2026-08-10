import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import { projectGitChanged, type GitValues } from "./projectConditions.js";

export async function projectApplyProbe(
    ctx: Context,
    id: string,
    values: GitValues & {
        presence: string;
        worktreeSupport: string;
        worktreeSupportReason: string | null;
    },
    now: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.projectApplyProbe", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        ...values,
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(
                        and(
                            eq(projects.id, id),
                            isNull(projects.archivedAtMs),
                            sql`(
        ${projects.presence} IS NOT ${values.presence}
        OR ${projects.worktreeSupport} IS NOT ${values.worktreeSupport}
        OR ${projects.worktreeSupportReason} IS NOT ${values.worktreeSupportReason}
        OR ${projectGitChanged(values)}
    )`,
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}

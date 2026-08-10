import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { GitRepositoryFacts } from "../../protocol/index.js";
import { projects } from "../database/schema.js";
import { projectGitChanged, type GitValues } from "./projectConditions.js";

export async function projectApplyGitFacts(
    ctx: Context,
    id: string,
    facts: GitRepositoryFacts,
    now: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.projectApplyGitFacts", async (ctx) => {
        const tx = ctx.tx;
        const values: GitValues = {
            gitAhead: facts.ahead,
            gitBehind: facts.behind,
            gitBranch: facts.branch ?? null,
            gitDetached: facts.detached,
            gitHead: facts.head ?? null,
            gitUpstream: facts.upstream ?? null,
        };
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
                            projectGitChanged(values),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}

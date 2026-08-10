import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";

export async function projectRestore(ctx: Context, id: string, now: number): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.projectRestore", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        archivedAtMs: null,
                        updatedAtMs: now,
                        userMutationVersion: sql`${projects.version} + 1`,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(and(eq(projects.id, id), isNotNull(projects.archivedAtMs)))
                    .run()
            ).rowsAffected,
        );
    });
}

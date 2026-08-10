import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import { projectNotUserMutatedSince } from "./projectConditions.js";

export async function projectArchive(
    ctx: Context,
    id: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.projectArchive", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        archivedAtMs: now,
                        updatedAtMs: now,
                        userMutationVersion: sql`${projects.version} + 1`,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(
                        and(
                            eq(projects.id, id),
                            isNull(projects.archivedAtMs),
                            projectNotUserMutatedSince(version),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}

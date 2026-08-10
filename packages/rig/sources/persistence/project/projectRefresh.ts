import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";

export async function projectRefresh(ctx: Context, id: string, now: number): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.projectRefresh", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        initializationAttempt: sql`${projects.initializationAttempt} + 1`,
                        initializationError: null,
                        initializationStatus: "initializing",
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(eq(projects.id, id))
                    .run()
            ).rowsAffected,
        );
    });
}

import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";

export async function projectRetryInitialization(
    ctx: Context,
    id: string,
    now: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.project.projectRetryInitialization", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        initializationError: null,
                        initializationStatus: "initializing",
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(and(eq(projects.id, id), eq(projects.initializationStatus, "failed")))
                    .run()
            ).rowsAffected,
        );
    });
}

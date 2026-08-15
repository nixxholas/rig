import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { worklets } from "../database/schema.js";

/** Makes an existing version current without touching any other version. */
export async function workletSetCurrentVersion(
    ctx: Context,
    name: string,
    version: number,
    now: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.worklets.set_current_version", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .update(worklets)
            .set({ currentVersion: version, updatedAtMs: now })
            .where(eq(worklets.name, name))
            .run();
    });
}

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { applets } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

/** Makes an existing version current without touching any other version. */
export async function appletSetCurrentVersion(
    ctx: Context,
    name: string,
    version: number,
    now: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.applets.set_current_version", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .update(applets)
            .set({ currentVersion: version, updatedAtMs: now })
            .where(eq(applets.name, name))
            .run();
    });
}

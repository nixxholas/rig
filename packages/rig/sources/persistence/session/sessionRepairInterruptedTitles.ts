import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";

export async function sessionRepairInterruptedTitles(
    ctx: Context,
    updatedAt: number,
): Promise<void> {
    return await inDatabase(
        ctx,
        "rig.sql.session.session_repair_interrupted_titles",
        async (ctx) => {
            const tx = ctx.tx;
            await tx
                .update(sessions)
                .set({
                    titleError:
                        "Title generation was interrupted because the local server stopped.",
                    titleStatus: "error",
                    updatedAtMs: updatedAt,
                })
                .where(eq(sessions.titleStatus, "generating"))
                .run();
        },
    );
}

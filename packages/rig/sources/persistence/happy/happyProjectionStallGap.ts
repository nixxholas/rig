import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { happySessions } from "../database/schema.js";
import { inTx } from "../inTx.js";

/** Durably records an unrecoverable gap without blocking already queued Happy delivery work. */
export async function happyProjectionStallGap(
    ctx: Context,
    input: { now: number; reason: string; sessionId: string },
): Promise<void> {
    await inTx(ctx, "rig.sql.happy.stall_projection_gap", async (ctx) => {
        await ctx.tx
            .update(happySessions)
            .set({
                projectionError: input.reason,
                projectionStallCause: "gap",
                projectionStatus: "stalled",
                updatedAtMs: input.now,
            })
            .where(eq(happySessions.sessionId, input.sessionId))
            .run();
    });
}

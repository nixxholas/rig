import { inDatabase } from "../database/inDatabase.js";
import { eq, sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { happySessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function happySessionAdvanceRemoteSequence(
    ctx: Context,
    input: { now: number; sequence: number; sessionId: string },
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.happy.advance_remote_sequence", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .update(happySessions)
            .set({
                lastRemoteSeq: sql`max(${happySessions.lastRemoteSeq}, ${input.sequence})`,
                updatedAtMs: input.now,
            })
            .where(eq(happySessions.sessionId, input.sessionId))
            .run();
    });
}

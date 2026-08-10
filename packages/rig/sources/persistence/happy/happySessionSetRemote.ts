import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { happySessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function happySessionSetRemote(
    ctx: Context,
    input: { now: number; remoteSessionId: string; sessionId: string },
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.happy.set_remote_session", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .update(happySessions)
            .set({ remoteSessionId: input.remoteSessionId, updatedAtMs: input.now })
            .where(eq(happySessions.sessionId, input.sessionId))
            .run();
    });
}

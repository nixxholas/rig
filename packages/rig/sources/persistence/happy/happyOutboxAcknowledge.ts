import { inDatabase } from "../database/inDatabase.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { happyOutbox } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function happyOutboxAcknowledge(
    ctx: Context,
    sessionId: string,
    localIds: readonly string[],
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.happy.acknowledge_outbox", async (ctx) => {
        const tx = ctx.tx;
        if (localIds.length === 0) return;
        await tx
            .delete(happyOutbox)
            .where(
                and(eq(happyOutbox.sessionId, sessionId), inArray(happyOutbox.localId, localIds)),
            )
            .run();
    });
}

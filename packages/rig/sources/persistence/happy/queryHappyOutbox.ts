import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { happyOutbox } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyOutbox(
    ctx: Context,
    sessionId: string,
    limit: number,
): Promise<readonly HappySessionProtocolMessage[]> {
    return await inDatabase(ctx, "rig.sql.happy.query_outbox", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx
                .select({ payloadJson: happyOutbox.payloadJson })
                .from(happyOutbox)
                .where(eq(happyOutbox.sessionId, sessionId))
                .orderBy(asc(happyOutbox.seq))
                .limit(limit)
                .all()
        ).map((row) => JSON.parse(row.payloadJson) as HappySessionProtocolMessage);
    });
}

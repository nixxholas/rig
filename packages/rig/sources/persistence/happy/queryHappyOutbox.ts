import { inTx } from "../inTx.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { happyOutbox } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyOutbox(
    ctx: Context,
    sessionId: string,
    limit: number,
): Promise<readonly HappySessionProtocolMessage[]> {
    return await inTx(ctx, "rig.sql.happy.query_outbox", async (ctx) => {
        const tx = ctx.tx;
        let rows = await tx
            .select({ payloadJson: happyOutbox.payloadJson })
            .from(happyOutbox)
            .where(and(eq(happyOutbox.sessionId, sessionId), eq(happyOutbox.deferred, false)))
            .orderBy(asc(happyOutbox.seq))
            .limit(limit)
            .all();
        if (rows.length === 0) {
            const deferred = await tx
                .select({ seq: happyOutbox.seq })
                .from(happyOutbox)
                .where(and(eq(happyOutbox.sessionId, sessionId), eq(happyOutbox.deferred, true)))
                .orderBy(asc(happyOutbox.seq))
                .limit(limit)
                .all();
            if (deferred.length > 0) {
                await tx
                    .update(happyOutbox)
                    .set({ deferred: false })
                    .where(
                        inArray(
                            happyOutbox.seq,
                            deferred.map((row) => row.seq),
                        ),
                    )
                    .run();
                rows = await tx
                    .select({ payloadJson: happyOutbox.payloadJson })
                    .from(happyOutbox)
                    .where(
                        inArray(
                            happyOutbox.seq,
                            deferred.map((row) => row.seq),
                        ),
                    )
                    .orderBy(asc(happyOutbox.seq))
                    .all();
            }
        }
        return rows.map((row) => JSON.parse(row.payloadJson) as HappySessionProtocolMessage);
    });
}

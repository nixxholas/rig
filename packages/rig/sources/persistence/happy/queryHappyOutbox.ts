import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";

import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { happyOutbox } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyOutbox(
    tx: DatabaseScope,
    sessionId: string,
    limit: number,
): Promise<readonly HappySessionProtocolMessage[]> {
    return await inDatabase(tx, async (tx) => {
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

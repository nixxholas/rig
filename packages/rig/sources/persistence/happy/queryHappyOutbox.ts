import { asc, eq } from "drizzle-orm";

import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { happyOutbox } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryHappyOutbox(
    tx: TX,
    sessionId: string,
    limit: number,
): readonly HappySessionProtocolMessage[] {
    return tx
        .select({ payloadJson: happyOutbox.payloadJson })
        .from(happyOutbox)
        .where(eq(happyOutbox.sessionId, sessionId))
        .orderBy(asc(happyOutbox.seq))
        .limit(limit)
        .all()
        .map((row) => JSON.parse(row.payloadJson) as HappySessionProtocolMessage);
}

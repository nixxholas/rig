import { inDatabase } from "../database/inDatabase.js";
import { eq, sql } from "drizzle-orm";

import { happySessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function happySessionAdvanceRemoteSequence(
    tx: DatabaseScope,
    input: { now: number; sequence: number; sessionId: string },
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
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

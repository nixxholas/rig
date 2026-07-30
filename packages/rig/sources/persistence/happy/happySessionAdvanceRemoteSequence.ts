import { eq, sql } from "drizzle-orm";

import { happySessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function happySessionAdvanceRemoteSequence(
    tx: TX,
    input: { now: number; sequence: number; sessionId: string },
): void {
    tx.update(happySessions)
        .set({
            lastRemoteSeq: sql`max(${happySessions.lastRemoteSeq}, ${input.sequence})`,
            updatedAtMs: input.now,
        })
        .where(eq(happySessions.sessionId, input.sessionId))
        .run();
}

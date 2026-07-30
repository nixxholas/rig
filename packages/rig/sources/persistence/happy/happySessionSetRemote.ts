import { eq } from "drizzle-orm";

import { happySessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function happySessionSetRemote(
    tx: TX,
    input: { now: number; remoteSessionId: string; sessionId: string },
): void {
    tx.update(happySessions)
        .set({ remoteSessionId: input.remoteSessionId, updatedAtMs: input.now })
        .where(eq(happySessions.sessionId, input.sessionId))
        .run();
}

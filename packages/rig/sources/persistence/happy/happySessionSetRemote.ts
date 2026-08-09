import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { happySessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function happySessionSetRemote(
    tx: DatabaseScope,
    input: { now: number; remoteSessionId: string; sessionId: string },
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .update(happySessions)
            .set({ remoteSessionId: input.remoteSessionId, updatedAtMs: input.now })
            .where(eq(happySessions.sessionId, input.sessionId))
            .run();
    });
}

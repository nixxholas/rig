import { eq } from "drizzle-orm";

import { pendingContextMessages, sessionMessages, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function sessionClearMessages(tx: DatabaseScope, sessionId: string): Promise<void> {
    await inTx(tx, async (tx) => {
        await tx
            .delete(pendingContextMessages)
            .where(eq(pendingContextMessages.sessionId, sessionId))
            .run();
        await tx.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).run();
        await tx.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).run();
    });
}

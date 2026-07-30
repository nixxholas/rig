import { eq } from "drizzle-orm";

import { sessionMessages, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionClearMessages(tx: TX, sessionId: string): void {
    inTx(tx, (tx) => {
        tx.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).run();
        tx.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).run();
    });
}

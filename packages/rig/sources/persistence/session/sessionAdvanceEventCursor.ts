import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function sessionAdvanceEventCursor(
    tx: DatabaseScope,
    sessionId: string,
    eventId: string,
    updatedAt: number,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .update(sessions)
            .set({ lastEventId: eventId, updatedAtMs: updatedAt })
            .where(eq(sessions.id, sessionId))
            .run();
    });
}

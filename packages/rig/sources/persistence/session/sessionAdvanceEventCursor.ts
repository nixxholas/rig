import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function sessionAdvanceEventCursor(
    tx: TX,
    sessionId: string,
    eventId: string,
    updatedAt: number,
): void {
    tx.update(sessions)
        .set({ lastEventId: eventId, updatedAtMs: updatedAt })
        .where(eq(sessions.id, sessionId))
        .run();
}

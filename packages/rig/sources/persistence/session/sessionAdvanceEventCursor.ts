import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";

export async function sessionAdvanceEventCursor(
    ctx: Context,
    sessionId: string,
    eventId: string,
    updatedAt: number,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.session_advance_event_cursor", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .update(sessions)
            .set({ lastEventId: eventId, updatedAtMs: updatedAt })
            .where(eq(sessions.id, sessionId))
            .run();
    });
}

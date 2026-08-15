import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessionEvents, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";

export interface SessionEventIndexFacts {
    messageId?: string;
    runId?: string;
    toolCallId?: string;
}

export async function sessionAppendEvent(
    ctx: Context,
    event: SessionEvent,
    facts: SessionEventIndexFacts,
    updatedAt: number,
): Promise<"existing" | "inserted"> {
    return await inTx(ctx, "rig.sql.session.session_append_event", async (ctx) => {
        const tx = ctx.tx;
        const inserted =
            (
                await tx
                    .insert(sessionEvents)
                    .values({
                        createdAtMs: event.createdAt,
                        dataJson: JSON.stringify(event.data),
                        eventId: event.id,
                        messageId: facts.messageId ?? null,
                        runId: facts.runId ?? null,
                        sessionId: event.sessionId,
                        toolCallId: facts.toolCallId ?? null,
                        type: event.type,
                    })
                    .onConflictDoNothing({ target: sessionEvents.eventId })
                    .run()
            ).rowsAffected > 0;
        if (!inserted) {
            const existing = await tx
                .select({
                    createdAtMs: sessionEvents.createdAtMs,
                    dataJson: sessionEvents.dataJson,
                    messageId: sessionEvents.messageId,
                    runId: sessionEvents.runId,
                    sessionId: sessionEvents.sessionId,
                    toolCallId: sessionEvents.toolCallId,
                    type: sessionEvents.type,
                })
                .from(sessionEvents)
                .where(eq(sessionEvents.eventId, event.id))
                .get();
            if (
                existing?.sessionId !== event.sessionId ||
                existing.createdAtMs !== event.createdAt ||
                existing.type !== event.type ||
                existing.messageId !== (facts.messageId ?? null) ||
                existing.runId !== (facts.runId ?? null) ||
                existing.toolCallId !== (facts.toolCallId ?? null) ||
                existing.dataJson !== JSON.stringify(event.data)
            ) {
                throw new Error("A session event identity cannot be reused for different content.");
            }
            return "existing";
        }
        await tx
            .update(sessions)
            .set({ lastEventId: event.id, updatedAtMs: updatedAt })
            .where(eq(sessions.id, event.sessionId))
            .run();
        return "inserted";
    });
}

import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessionEvents, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export interface SessionEventIndexFacts {
    messageId?: string;
    runId?: string;
    toolCallId?: string;
}

export function sessionAppendEvent(
    tx: TX,
    event: SessionEvent,
    facts: SessionEventIndexFacts,
    updatedAt: number,
): "existing" | "inserted" {
    return inTx(tx, (tx) => {
        const inserted =
            tx
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
                .run().changes > 0;
        if (!inserted) {
            const existing = tx
                .select({
                    createdAtMs: sessionEvents.createdAtMs,
                    dataJson: sessionEvents.dataJson,
                    sessionId: sessionEvents.sessionId,
                    type: sessionEvents.type,
                })
                .from(sessionEvents)
                .where(eq(sessionEvents.eventId, event.id))
                .get();
            if (
                existing?.sessionId !== event.sessionId ||
                existing.createdAtMs !== event.createdAt ||
                existing.type !== event.type ||
                existing.dataJson !== JSON.stringify(event.data)
            ) {
                throw new Error("A session event identity cannot be reused for different content.");
            }
            return "existing";
        }
        tx.update(sessions)
            .set({ lastEventId: event.id, updatedAtMs: updatedAt })
            .where(eq(sessions.id, event.sessionId))
            .run();
        return "inserted";
    });
}

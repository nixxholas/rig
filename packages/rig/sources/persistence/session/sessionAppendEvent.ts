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
): void {
    inTx(tx, (tx) => {
        tx.insert(sessionEvents)
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
            .run();
        tx.update(sessions)
            .set({ lastEventId: event.id, updatedAtMs: updatedAt })
            .where(eq(sessions.id, event.sessionId))
            .run();
    });
}

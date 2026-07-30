import { count, eq } from "drizzle-orm";

import { happyOutbox } from "../database/schema.js";
import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export class HappySyncOutboxFullError extends Error {}

export function happyOutboxEnqueue(
    tx: TX,
    input: {
        maxPendingMessages: number;
        messages: readonly HappySessionProtocolMessage[];
        now: () => number;
        sessionId: string;
    },
): void {
    if (input.messages.length === 0) return;
    inTx(tx, (tx) => {
        for (const message of input.messages) {
            tx.insert(happyOutbox)
                .values({
                    createdAtMs: input.now(),
                    localId: message.localId,
                    payloadJson: JSON.stringify(message),
                    sessionId: input.sessionId,
                })
                .onConflictDoNothing()
                .run();
        }
        const pendingCount =
            tx
                .select({ value: count() })
                .from(happyOutbox)
                .where(eq(happyOutbox.sessionId, input.sessionId))
                .get()?.value ?? 0;
        if (pendingCount > input.maxPendingMessages) {
            throw new HappySyncOutboxFullError(
                `Happy sync outbox is full for session ${input.sessionId}; reconnect before sending more messages.`,
            );
        }
    });
}

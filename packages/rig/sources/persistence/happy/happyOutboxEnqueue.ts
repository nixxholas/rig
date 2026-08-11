import { count, eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { happyOutbox } from "../database/schema.js";
import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export class HappySyncOutboxFullError extends Error {
    constructor(
        message: string,
        readonly recoverable = true,
    ) {
        super(message);
    }
}

export async function happyOutboxEnqueue(
    ctx: Context,
    input: {
        maxPendingMessages: number;
        messages: readonly HappySessionProtocolMessage[];
        now: () => number;
        sessionId: string;
    },
): Promise<void> {
    if (input.messages.length === 0) return;
    await inTx(ctx, "rig.sql.happy.enqueue_outbox", async (ctx) => {
        const tx = ctx.tx;
        for (const message of input.messages) {
            await tx
                .insert(happyOutbox)
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
            (
                await tx
                    .select({ value: count() })
                    .from(happyOutbox)
                    .where(eq(happyOutbox.sessionId, input.sessionId))
                    .get()
            )?.value ?? 0;
        if (pendingCount > input.maxPendingMessages) {
            throw new HappySyncOutboxFullError(
                `Happy sync outbox is full for session ${input.sessionId}; reconnect before sending more messages.`,
            );
        }
    });
}

import { and, count, eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { happyOutbox, happySessions, sessionEvents } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { HappySyncOutboxFullError } from "./happyOutboxEnqueue.js";

/** Atomically queues a session's first historical projection and records that it was queued. */
export async function happyOutboxEnqueueInitialBackfill(
    ctx: Context,
    input: {
        maxPendingMessages: number;
        messages: readonly HappySessionProtocolMessage[];
        projectedEventId?: string;
        now: () => number;
        sessionId: string;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.happy.enqueue_initial_backfill", async (ctx) => {
        const tx = ctx.tx;
        const state = await tx
            .select({ historyBackfilled: happySessions.historyBackfilled })
            .from(happySessions)
            .where(eq(happySessions.sessionId, input.sessionId))
            .get();
        if (state === undefined) {
            throw new Error(`Happy session mapping '${input.sessionId}' does not exist.`);
        }
        if (state.historyBackfilled) return;

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
        const projected =
            input.projectedEventId === undefined
                ? undefined
                : await tx
                      .select({ seq: sessionEvents.seq })
                      .from(sessionEvents)
                      .where(
                          and(
                              eq(sessionEvents.sessionId, input.sessionId),
                              eq(sessionEvents.eventId, input.projectedEventId),
                          ),
                      )
                      .get();
        if (input.projectedEventId !== undefined && projected === undefined) {
            throw new Error(
                `Happy projection source event '${input.projectedEventId}' does not exist.`,
            );
        }
        await tx
            .update(happySessions)
            .set({
                historyBackfilled: true,
                projectedEventId: input.projectedEventId ?? null,
                projectedEventSeq: projected?.seq ?? null,
                projectionError: null,
                projectionStallCause: null,
                projectionStatus: "active",
            })
            .where(eq(happySessions.sessionId, input.sessionId))
            .run();
    });
}

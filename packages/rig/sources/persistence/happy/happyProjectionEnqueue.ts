import { and, count, eq, gt } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappySessionProtocolMessage } from "../../happy/types.js";
import { happyOutbox, happySessions, sessionEvents } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export type HappyProjectionEnqueueResult =
    | { status: "projected"; deferred: boolean }
    | {
          status: "stalled";
          cause: "capacity" | "event_too_large" | "gap";
          reason: string;
      };

/** Atomically projects one next durable Rig event into Happy's bounded delivery queues. */
export async function happyProjectionEnqueue(
    ctx: Context,
    input: {
        eventId: string;
        maxPendingMessages: number;
        messages: readonly HappySessionProtocolMessage[];
        now: () => number;
        sessionId: string;
    },
): Promise<HappyProjectionEnqueueResult> {
    return await inTx(ctx, "rig.sql.happy.enqueue_projection", async (ctx) => {
        const tx = ctx.tx;
        const state = await tx
            .select({
                projectedEventSeq: happySessions.projectedEventSeq,
                projectionError: happySessions.projectionError,
                projectionStallCause: happySessions.projectionStallCause,
                projectionStatus: happySessions.projectionStatus,
            })
            .from(happySessions)
            .where(eq(happySessions.sessionId, input.sessionId))
            .get();
        const source = await tx
            .select({ seq: sessionEvents.seq })
            .from(sessionEvents)
            .where(
                and(
                    eq(sessionEvents.sessionId, input.sessionId),
                    eq(sessionEvents.eventId, input.eventId),
                ),
            )
            .get();
        if (state === undefined) {
            throw new Error(`Happy session mapping '${input.sessionId}' does not exist.`);
        }
        if (source === undefined) {
            throw new Error(`Happy projection source event '${input.eventId}' does not exist.`);
        }
        if (state.projectedEventSeq !== null && source.seq <= state.projectedEventSeq) {
            return { deferred: false, status: "projected" };
        }
        if (
            state.projectionStatus === "stalled" &&
            state.projectionStallCause === "event_too_large"
        ) {
            return {
                cause: "event_too_large",
                reason:
                    state.projectionError ??
                    "One Rig event exceeds the bounded Happy projection capacity.",
                status: "stalled",
            };
        }

        const next = await tx
            .select({ seq: sessionEvents.seq })
            .from(sessionEvents)
            .where(
                and(
                    eq(sessionEvents.sessionId, input.sessionId),
                    state.projectedEventSeq === null
                        ? gt(sessionEvents.seq, 0)
                        : gt(sessionEvents.seq, state.projectedEventSeq),
                ),
            )
            .orderBy(sessionEvents.seq)
            .limit(1)
            .get();
        if (next?.seq !== source.seq) {
            return await stall(
                ctx,
                input.sessionId,
                "gap",
                "Happy projection is waiting for an earlier durable session event.",
            );
        }

        const counts = await tx
            .select({ deferred: happyOutbox.deferred, value: count() })
            .from(happyOutbox)
            .where(eq(happyOutbox.sessionId, input.sessionId))
            .groupBy(happyOutbox.deferred)
            .all();
        const readyCount = counts.find((entry) => !entry.deferred)?.value ?? 0;
        const deferredCount = counts.find((entry) => entry.deferred)?.value ?? 0;
        const deferred =
            deferredCount > 0 || readyCount + input.messages.length > input.maxPendingMessages;
        if (
            input.messages.length > input.maxPendingMessages ||
            (deferred && deferredCount + input.messages.length > input.maxPendingMessages)
        ) {
            return await stall(
                ctx,
                input.sessionId,
                input.messages.length > input.maxPendingMessages ? "event_too_large" : "capacity",
                input.messages.length > input.maxPendingMessages
                    ? "One Rig event produces more Happy messages than the bounded recovery queue can retain."
                    : "Happy projection recovery is full and waiting for delivery capacity.",
            );
        }

        for (const message of input.messages) {
            await tx
                .insert(happyOutbox)
                .values({
                    createdAtMs: input.now(),
                    deferred,
                    localId: message.localId,
                    payloadJson: JSON.stringify(message),
                    sessionId: input.sessionId,
                })
                .onConflictDoNothing()
                .run();
        }
        await tx
            .update(happySessions)
            .set({
                projectedEventId: input.eventId,
                projectedEventSeq: source.seq,
                projectionError: null,
                projectionStallCause: null,
                projectionStatus: "active",
                updatedAtMs: input.now(),
            })
            .where(eq(happySessions.sessionId, input.sessionId))
            .run();
        return { deferred, status: "projected" };
    });
}

async function stall(
    ctx: Context,
    sessionId: string,
    cause: "capacity" | "event_too_large" | "gap",
    reason: string,
): Promise<HappyProjectionEnqueueResult> {
    await ctx.tx
        .update(happySessions)
        .set({
            projectionError: reason,
            projectionStallCause: cause,
            projectionStatus: "stalled",
        })
        .where(eq(happySessions.sessionId, sessionId))
        .run();
    return { cause, reason, status: "stalled" };
}

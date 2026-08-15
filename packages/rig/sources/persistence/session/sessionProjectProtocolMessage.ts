import type { Context } from "@steve.kite/stdlib";

import { eq, sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { SessionEvent } from "../../protocol/index.js";
import { sessionMessages, sessions, sessionTurns } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";

export async function sessionProjectProtocolMessage(
    ctx: Context,
    input: {
        event: SessionEvent;
        message: Message;
        runId: string;
        updatedAt: number;
        updateLastMessageAt: boolean;
    },
): Promise<"existing" | "inserted"> {
    return await inTx(ctx, "rig.sql.session.project_protocol_message", async (ctx) => {
        const inserted = await sessionAppendEvent(
            ctx,
            input.event,
            {
                messageId: input.message.id,
                runId: input.runId,
            },
            input.updatedAt,
        );
        if (inserted === "existing") return inserted;

        const positionRow = await ctx.tx
            .select({
                position: sql<number>`COALESCE(MAX(${sessionMessages.position}), -1) + 1`,
            })
            .from(sessionMessages)
            .where(eq(sessionMessages.sessionId, input.event.sessionId))
            .get();
        if (positionRow === undefined || !Number.isSafeInteger(positionRow.position)) {
            throw new Error("The next protocol transcript position is invalid.");
        }
        await ctx.tx
            .insert(sessionMessages)
            .values({
                isPartial: false,
                messageId: input.message.id,
                messageJson: encodeJson(input.message),
                position: positionRow.position,
                role: input.message.role,
                runId: input.runId,
                sessionId: input.event.sessionId,
                updatedAtMs: input.updatedAt,
            })
            .run();
        await ctx.tx
            .insert(sessionTurns)
            .values({
                firstPosition: positionRow.position,
                runId: input.runId,
                sessionId: input.event.sessionId,
            })
            .onConflictDoUpdate({
                set: {
                    firstPosition: sql`MIN(
                        ${sessionTurns.firstPosition},
                        excluded.first_position
                    )`,
                },
                target: [sessionTurns.sessionId, sessionTurns.runId],
            })
            .run();
        if (input.updateLastMessageAt) {
            await ctx.tx
                .update(sessions)
                .set({
                    lastMessageAtMs: input.updatedAt,
                    ...(input.event.type === "message_submitted" &&
                    input.event.data.delivery === "run"
                        ? {
                              activeRunId: input.runId,
                              activeSinceMs: input.event.createdAt,
                              status: "queued",
                          }
                        : {}),
                })
                .where(eq(sessions.id, input.event.sessionId))
                .run();
        }
        return inserted;
    });
}

function encodeJson(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new Error("A protocol transcript message is not JSON-serializable.");
    }
    return encoded;
}

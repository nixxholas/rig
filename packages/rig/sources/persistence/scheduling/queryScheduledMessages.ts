import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ScheduledMessage } from "../../scheduling/index.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "../session/impl/sqliteRow.js";

export async function queryScheduledMessages(
    ctx: Context,
    senderSessionId: string,
): Promise<readonly ScheduledMessage[]> {
    return await inDatabase(ctx, "rig.sql.scheduling.queryScheduledMessages", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT *
            FROM scheduled_messages
            WHERE sender_session_id = ${senderSessionId}
            ORDER BY created_at_ms ASC
        `)
        ).map(readScheduledMessage);
    });
}

export async function queryNextPendingScheduledMessage(
    ctx: Context,
): Promise<ScheduledMessage | undefined> {
    return await inDatabase(
        ctx,
        "rig.sql.scheduling.queryNextPendingScheduledMessage",
        async (ctx) => {
            const tx = ctx.tx;
            const row = await tx.get<Record<string, unknown>>(sql`
        SELECT *
        FROM scheduled_messages
        WHERE status = 'pending'
        ORDER BY due_at_ms ASC, created_at_ms ASC
        LIMIT 1
    `);
            return row === undefined ? undefined : readScheduledMessage(row);
        },
    );
}

function readScheduledMessage(row: Record<string, unknown>): ScheduledMessage {
    const deliveredAt = readOptionalNumber(row, "delivered_at_ms");
    const failure = readOptionalString(row, "failure");
    return {
        createdAt: readNumber(row, "created_at_ms"),
        ...(deliveredAt === undefined ? {} : { deliveredAt }),
        dueAt: readNumber(row, "due_at_ms"),
        ...(failure === undefined ? {} : { failure }),
        id: readString(row, "id"),
        message: readString(row, "message"),
        senderSessionId: readString(row, "sender_session_id"),
        status: readString(row, "status") as ScheduledMessage["status"],
        targetAgentId: readString(row, "target_agent_id"),
        updatedAt: readNumber(row, "updated_at_ms"),
    };
}

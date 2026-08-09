import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ScheduledMessage } from "../../scheduling/index.js";
import type { DatabaseScope } from "../Transaction.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "../session/impl/sqliteRow.js";

export async function queryScheduledMessages(
    tx: DatabaseScope,
    senderSessionId: string,
): Promise<readonly ScheduledMessage[]> {
    return await inDatabase(tx, async (tx) => {
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
    tx: DatabaseScope,
): Promise<ScheduledMessage | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<Record<string, unknown>>(sql`
        SELECT *
        FROM scheduled_messages
        WHERE status = 'pending'
        ORDER BY due_at_ms ASC, created_at_ms ASC
        LIMIT 1
    `);
        return row === undefined ? undefined : readScheduledMessage(row);
    });
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

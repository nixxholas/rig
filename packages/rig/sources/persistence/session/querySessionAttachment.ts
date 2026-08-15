import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { AttachmentSchema, type Attachment } from "../../protocol/index.js";
import { readString } from "./impl/sqliteRow.js";

/** Finds one attachment only when a committed, visible agent message in the session owns it. */
export async function querySessionAttachment(
    ctx: Context,
    sessionId: string,
    attachmentId: string,
): Promise<Attachment | undefined> {
    return await inDatabase(ctx, "rig.sql.session.query_session_attachment", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.get<Record<string, unknown>>(sql`
        SELECT attachment.value AS attachment_json
        FROM session_messages
        JOIN json_each(session_messages.message_json, '$.attachments') AS attachment
        WHERE session_messages.session_id = ${sessionId}
            AND session_messages.role = 'agent'
            AND session_messages.is_partial = 0
            AND COALESCE(json_extract(session_messages.message_json, '$.internal'), 0) != 1
            AND json_extract(attachment.value, '$.id') = ${attachmentId}
        ORDER BY session_messages.position DESC
        LIMIT 1
    `);
        if (row === undefined) return undefined;
        const value: unknown = JSON.parse(readString(row, "attachment_json"));
        return Value.Check(AttachmentSchema, value) ? value : undefined;
    });
}

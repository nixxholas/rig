import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ExternalToolCall } from "../../external-tools/index.js";
import { readExternalToolCallRow } from "./impl/externalToolCallRow.js";

export async function queryExternalToolCallsForSession(
    ctx: Context,
    sessionId: string,
): Promise<readonly ExternalToolCall[]> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_external_tool_calls_for_session",
        async (ctx) => {
            const tx = ctx.tx;
            return (
                await tx.all<Record<string, unknown>>(sql`
            SELECT * FROM external_tool_calls
            WHERE session_id = ${sessionId}
            ORDER BY created_at_ms ASC, tool_call_index ASC
        `)
            ).map(readExternalToolCallRow);
        },
    );
}

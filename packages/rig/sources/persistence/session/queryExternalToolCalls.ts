import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ExternalToolCall } from "../../external-tools/index.js";
import { readExternalToolCallRow } from "./impl/externalToolCallRow.js";

export async function queryExternalToolCalls(
    ctx: Context,
    options: {
        limit?: number;
        status?: ExternalToolCall["status"];
    } = {},
): Promise<readonly ExternalToolCall[]> {
    return await inDatabase(ctx, "rig.sql.session.query_external_tool_calls", async (ctx) => {
        const tx = ctx.tx;
        const rows =
            options.status === undefined
                ? await tx.all<Record<string, unknown>>(sql`
                    SELECT *
                    FROM external_tool_calls
                    ORDER BY created_at_ms ASC, tool_call_index ASC
                    LIMIT ${options.limit ?? 100}
                `)
                : await tx.all<Record<string, unknown>>(sql`
                    SELECT *
                    FROM external_tool_calls
                    WHERE status = ${options.status}
                    ORDER BY created_at_ms ASC, tool_call_index ASC
                    LIMIT ${options.limit ?? 100}
                `);
        return rows.map(readExternalToolCallRow);
    });
}

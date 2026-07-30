import { sql } from "drizzle-orm";

import type { ExternalToolCall } from "../../external-tools/index.js";
import type { TX } from "../Transaction.js";
import { readExternalToolCallRow } from "./impl/externalToolCallRow.js";

export function queryExternalToolCalls(
    tx: TX,
    options: {
        limit?: number;
        status?: ExternalToolCall["status"];
    } = {},
): readonly ExternalToolCall[] {
    const rows =
        options.status === undefined
            ? tx.all<Record<string, unknown>>(sql`
                    SELECT *
                    FROM external_tool_calls
                    ORDER BY created_at_ms ASC, tool_call_index ASC
                    LIMIT ${options.limit ?? 100}
                `)
            : tx.all<Record<string, unknown>>(sql`
                    SELECT *
                    FROM external_tool_calls
                    WHERE status = ${options.status}
                    ORDER BY created_at_ms ASC, tool_call_index ASC
                    LIMIT ${options.limit ?? 100}
                `);
    return rows.map(readExternalToolCallRow);
}

import { sql } from "drizzle-orm";

import type { ExternalToolCall } from "../../external-tools/index.js";
import type { TX } from "../Transaction.js";
import { readExternalToolCallRow } from "./impl/externalToolCallRow.js";

export function queryExternalToolCallsForSession(
    tx: TX,
    sessionId: string,
): readonly ExternalToolCall[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT * FROM external_tool_calls
            WHERE session_id = ${sessionId}
            ORDER BY created_at_ms ASC, tool_call_index ASC
        `)
        .map(readExternalToolCallRow);
}

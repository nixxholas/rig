import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ExternalToolCall } from "../../external-tools/index.js";
import type { DatabaseScope } from "../Transaction.js";
import { readExternalToolCallRow } from "./impl/externalToolCallRow.js";

export async function queryExternalToolCallsForSession(
    tx: DatabaseScope,
    sessionId: string,
): Promise<readonly ExternalToolCall[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT * FROM external_tool_calls
            WHERE session_id = ${sessionId}
            ORDER BY created_at_ms ASC, tool_call_index ASC
        `)
        ).map(readExternalToolCallRow);
    });
}

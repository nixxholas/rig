import { sql } from "drizzle-orm";

import type { DurableWait } from "../../scheduling/index.js";
import type { TX } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";

export function queryDurableWaits(tx: TX, sessionId: string): readonly DurableWait[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT *
            FROM durable_waits
            WHERE session_id = ${sessionId}
            ORDER BY created_at_ms ASC, tool_call_index ASC
        `)
        .map((row) => {
            const providerToolCallId = readOptionalString(row, "provider_tool_call_id");
            const resultJson = readOptionalString(row, "result_json");
            const resultBlockJson = readOptionalString(row, "result_block_json");
            return {
                arguments: JSON.parse(readString(row, "arguments_json")),
                batchId: readString(row, "batch_id"),
                consumed: readNumber(row, "consumed") !== 0,
                createdAt: readNumber(row, "created_at_ms"),
                dueAt: readNumber(row, "due_at_ms"),
                id: readString(row, "id"),
                kind: readString(row, "kind") as DurableWait["kind"],
                ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
                ...(resultJson === undefined ? {} : { result: JSON.parse(resultJson) }),
                ...(resultBlockJson === undefined
                    ? {}
                    : { resultBlock: JSON.parse(resultBlockJson) }),
                runId: readString(row, "run_id"),
                sessionId: readString(row, "session_id"),
                status: readString(row, "status") as DurableWait["status"],
                toolCallId: readString(row, "tool_call_id"),
                toolCallIndex: readNumber(row, "tool_call_index"),
                toolName: readString(row, "tool_name") as DurableWait["toolName"],
            };
        });
}

import { sql } from "drizzle-orm";

import type { DurableUserInputCall } from "../../user-input/index.js";
import type { TX } from "../Transaction.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";

export function queryDurableUserInputs(tx: TX, sessionId: string): readonly DurableUserInputCall[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT *
            FROM durable_user_inputs
            WHERE session_id = ${sessionId}
            ORDER BY created_at_ms ASC, tool_call_index ASC
        `)
        .map((row) => {
            const permissionJson = readOptionalString(row, "permission_json");
            const providerToolCallId = readOptionalString(row, "provider_tool_call_id");
            const responseJson = readOptionalString(row, "response_json");
            const resultJson = readOptionalString(row, "result_json");
            const resolvedAt = readOptionalNumber(row, "resolved_at_ms");
            return {
                batchId: readString(row, "batch_id"),
                consumed: readNumber(row, "consumed") !== 0,
                createdAt: readNumber(row, "created_at_ms"),
                kind: readString(row, "kind") as DurableUserInputCall["kind"],
                ...(permissionJson === undefined ? {} : { permission: JSON.parse(permissionJson) }),
                ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
                request: JSON.parse(readString(row, "request_json")),
                ...(responseJson === undefined ? {} : { response: JSON.parse(responseJson) }),
                ...(resolvedAt === undefined ? {} : { resolvedAt }),
                ...(resultJson === undefined ? {} : { result: JSON.parse(resultJson) }),
                runId: readString(row, "run_id"),
                sessionId: readString(row, "session_id"),
                status: readString(row, "status") as DurableUserInputCall["status"],
                toolArguments: JSON.parse(readString(row, "tool_arguments_json")),
                toolCallId: readString(row, "tool_call_id"),
                toolCallIndex: readNumber(row, "tool_call_index"),
                toolName: readString(row, "tool_name"),
            };
        });
}

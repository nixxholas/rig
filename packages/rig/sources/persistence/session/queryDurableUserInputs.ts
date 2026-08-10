import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DurableUserInputCall } from "../../user-input/index.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";

export async function queryDurableUserInputs(
    ctx: Context,
    sessionId?: string,
): Promise<readonly DurableUserInputCall[]> {
    return await inDatabase(ctx, "rig.sql.session.query_durable_user_inputs", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT *
            FROM durable_user_inputs
            ${sessionId === undefined ? sql`` : sql`WHERE session_id = ${sessionId}`}
            ORDER BY created_at_ms ASC, tool_call_index ASC
        `)
        ).map((row) => {
            const answerDueAt = readOptionalNumber(row, "answer_due_at_ms");
            const answerWaitStartedAt = readOptionalNumber(row, "answer_wait_started_at_ms");
            const permissionJson = readOptionalString(row, "permission_json");
            const providerToolCallId = readOptionalString(row, "provider_tool_call_id");
            const responseJson = readOptionalString(row, "response_json");
            const resultJson = readOptionalString(row, "result_json");
            const resolvedAt = readOptionalNumber(row, "resolved_at_ms");
            const detachedAt = readOptionalNumber(row, "detached_at_ms");
            return {
                ...(answerDueAt === undefined ? {} : { answerDueAt }),
                ...(answerWaitStartedAt === undefined ? {} : { answerWaitStartedAt }),
                batchId: readString(row, "batch_id"),
                consumed: readNumber(row, "consumed") !== 0,
                createdAt: readNumber(row, "created_at_ms"),
                ...(detachedAt === undefined ? {} : { detachedAt }),
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
    });
}

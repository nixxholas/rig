import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { durableUserInputs } from "../database/schema.js";
import type { DurableUserInputCall } from "../../user-input/index.js";

export async function durableUserInputSave(
    ctx: Context,
    call: DurableUserInputCall,
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.durable_user_input_save", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .insert(durableUserInputs)
            .values({
                answerDueAtMs: call.answerDueAt ?? null,
                answerWaitStartedAtMs: call.answerWaitStartedAt ?? null,
                batchId: call.batchId,
                consumed: call.consumed,
                createdAtMs: call.createdAt,
                detachedAtMs: call.detachedAt ?? null,
                kind: call.kind,
                permissionJson:
                    call.permission === undefined ? null : JSON.stringify(call.permission),
                providerToolCallId: call.providerToolCallId ?? null,
                requestId: call.request.requestId,
                requestJson: JSON.stringify(call.request),
                resolvedAtMs: call.resolvedAt ?? null,
                responseJson: call.response === undefined ? null : JSON.stringify(call.response),
                resultJson: call.result === undefined ? null : JSON.stringify(call.result),
                runId: call.runId,
                sessionId: call.sessionId,
                status: call.status,
                toolArgumentsJson: JSON.stringify(call.toolArguments),
                toolCallId: call.toolCallId,
                toolCallIndex: call.toolCallIndex,
                toolName: call.toolName,
            })
            .onConflictDoUpdate({
                set: {
                    answerDueAtMs: sql`excluded.answer_due_at_ms`,
                    answerWaitStartedAtMs: sql`excluded.answer_wait_started_at_ms`,
                    consumed: sql`excluded.consumed`,
                    detachedAtMs: sql`excluded.detached_at_ms`,
                    resolvedAtMs: sql`excluded.resolved_at_ms`,
                    responseJson: sql`excluded.response_json`,
                    resultJson: sql`excluded.result_json`,
                    status: sql`excluded.status`,
                },
                target: [durableUserInputs.sessionId, durableUserInputs.requestId],
            })
            .run();
    });
}

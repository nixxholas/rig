import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { ExternalToolCall } from "../../external-tools/index.js";
import { externalToolCalls } from "../database/schema.js";

export async function externalToolCallSave(ctx: Context, call: ExternalToolCall): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.external_tool_call_save", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .insert(externalToolCalls)
            .values({
                argumentsJson: JSON.stringify(call.arguments),
                batchId: call.batchId,
                consumed: call.consumed,
                createdAtMs: call.createdAt,
                definitionJson: JSON.stringify(call.definition),
                id: call.id,
                providerToolCallId: call.providerToolCallId ?? null,
                resolutionJson:
                    call.resolution === undefined ? null : JSON.stringify(call.resolution),
                resolvedAtMs: call.resolvedAt ?? null,
                runId: call.runId,
                sessionId: call.sessionId,
                skillJson: call.skill === undefined ? null : JSON.stringify(call.skill),
                status: call.status,
                toolCallId: call.toolCallId,
                toolCallIndex: call.toolCallIndex,
            })
            .onConflictDoUpdate({
                set: {
                    consumed: sql`excluded.consumed`,
                    resolutionJson: sql`excluded.resolution_json`,
                    resolvedAtMs: sql`excluded.resolved_at_ms`,
                    status: sql`excluded.status`,
                },
                target: externalToolCalls.id,
            })
            .run();
    });
}
